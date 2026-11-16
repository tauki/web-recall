import CompanionCore
import Foundation
import NativeProtocol
import Testing

private final class Events: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [HostEvent] = []
  var values: [HostEvent] { lock.lock(); defer { lock.unlock() }; return storage }
  func append(_ event: HostEvent) { lock.lock(); defer { lock.unlock() }; storage.append(event) }
  var writer: NativeWriter { NativeWriter(sendEvent: { [self] in append($0) }) }
}

@Test @MainActor func updatingDrainsExistingWorkWithoutCancellingItAndRejectsNewAdmissions() async throws {
  let events = Events()
  let controller = CompanionController { request, _, tools in
    let result = try await tools.call(name: "search_memory", arguments: "{}")
    return HostEvent(id: request.id, type: "done", text: result)
  }
  let client = UUID(); controller.connect(client)
  controller.receive(HostRequest(id: "active", action: "generate", prompt: "Question", toolLimit: 1), client: client, writer: events.writer)
  try await settle { events.values.contains { $0.toolCall != nil } }
  let call = try #require(events.values.first?.toolCall)
  controller.setUpdating(true)
  #expect(controller.active.count == 1)
  #expect(controller.statusText == "Waiting to update…")
  controller.receive(HostRequest(id: "new", action: "generate", prompt: "New question"), client: client, writer: events.writer)
  #expect(events.values.last?.id == "new" && events.values.last?.type == "error")
  controller.receive(HostRequest(id: "active", action: "tool_result", callId: call.callId, result: "Saved evidence"), client: client, writer: events.writer)
  try await settle { controller.active.isEmpty }
  #expect(events.values.last?.text == "Saved evidence")
  #expect(!events.values.contains { $0.type == "cancelled" })
  controller.setUpdating(false)
  controller.receive(HostRequest(id: "resumed", action: "generate", prompt: "Another question", toolLimit: 1), client: client, writer: events.writer)
  try await settle { controller.active.count == 1 }
  controller.stopAll()
}

@Test @MainActor func failedCapabilityChecksInvalidateReadinessButGenerationErrorsDoNot() async throws {
  for action in ["status", "generate"] {
    let events = Events()
    var fail = true
    let status = HostStatus(available: true, reason: nil, contextTokens: 8192, mode: "on-device")
    let controller = CompanionController { request, _, _ in
      if fail { throw CocoaError(.fileReadNoPermission) }
      return HostEvent(id: request.id, type: "status", status: status)
    }
    controller.setModelStatus(status)
    let client = UUID()
    controller.connect(client)
    controller.receive(HostRequest(id: "failed", action: action, prompt: "Question"), client: client, writer: events.writer)
    try await settle { controller.active.isEmpty }
    #expect(events.values.last?.type == "error")
    #expect(controller.statusText == (action == "status" ? "Unavailable" : "Ready"))
    if action == "status" { #expect(controller.modelStatus == nil) }
    fail = false
    controller.receive(HostRequest(id: "recovery", action: "status"), client: client, writer: events.writer)
    try await settle { controller.active.isEmpty }
    #expect(controller.statusText == "Ready")
    #expect(controller.modelError == nil)
  }
}

@Test @MainActor func cancelledCapabilityCheckPreservesTheLastKnownAvailability() async throws {
  let events = Events()
  let controller = CompanionController { _, _, _ in
    try await Task.sleep(for: .seconds(3600))
    throw CancellationError()
  }
  controller.setModelStatus(HostStatus(available: true, reason: nil, contextTokens: 8192, mode: "on-device"))
  let client = UUID()
  controller.connect(client)
  controller.receive(HostRequest(id: "check", action: "status"), client: client, writer: events.writer)
  controller.stopAll()
  try await settle { controller.active.isEmpty }
  #expect(events.values.last?.type == "cancelled")
  #expect(controller.statusText == "Ready")
  #expect(controller.modelError == nil)
}

@Test @MainActor func aDifferentConnectionCannotSupplyAnotherRequestsToolEvidence() async throws {
  let events = Events()
  let controller = CompanionController { request, _, tools in
    let result = try await tools.call(name: "search_memory", arguments: "{}")
    return HostEvent(id: request.id, type: "done", text: result)
  }
  let owner = UUID(), other = UUID()
  controller.connect(owner); controller.connect(other)
  controller.receive(HostRequest(id: "run", action: "generate", prompt: "Question", toolLimit: 1), client: owner, writer: events.writer)
  try await settle { events.values.contains { $0.toolCall != nil } }
  let call = try #require(events.values.first?.toolCall)
  controller.receive(HostRequest(id: "run", action: "tool_result", callId: call.callId, result: "Spoofed private evidence"), client: other, writer: events.writer)
  #expect(controller.active.count == 1)
  controller.receive(HostRequest(id: "run", action: "tool_result", callId: call.callId, result: "Authorized saved evidence"), client: owner, writer: events.writer)
  try await settle { controller.active.isEmpty }
  #expect(events.values.last?.text == "Authorized saved evidence")
  #expect(!events.values.contains { $0.text == "Spoofed private evidence" })
}

@MainActor private func settle(_ condition: () -> Bool) async throws {
  for _ in 0..<2000 { if condition() { return }; await Task.yield() }
  Issue.record("The companion did not reach the expected observable lifecycle state.")
  throw CancellationError()
}

@Test @MainActor func pauseCancelsActiveWorkAndResumeAdmitsNewWork() async throws {
  let events = Events()
  var began = 0
  var cancellations = 0
  let controller = CompanionController { request, writer, _ in
    began += 1
    try writer.send(HostEvent(id: request.id, type: "chunk", text: "Partial"))
    do { try await Task.sleep(for: .seconds(3600)) }
    catch { cancellations += 1; throw error }
    return HostEvent(id: request.id, type: "done", text: "Must not arrive")
  }
  let client = UUID()
  controller.connect(client)
  controller.receive(HostRequest(id: "answer", action: "generate", prompt: "Private prompt"), client: client, writer: events.writer)
  try await settle { began == 1 }
  controller.setPaused(true)
  #expect(controller.active.isEmpty)
  #expect(events.values.last?.type == "cancelled")
  try await settle { cancellations == 1 }
  controller.receive(HostRequest(id: "paused", action: "status"), client: client, writer: events.writer)
  #expect(events.values.last?.type == "error")
  #expect(began == 1)
  controller.setPaused(false)
  controller.receive(HostRequest(id: "again", action: "generate", prompt: "New prompt"), client: client, writer: events.writer)
  try await settle { began == 2 }
  controller.stopAll()
  try await settle { cancellations == 2 }
  #expect(!controller.paused)
  #expect(controller.history.allSatisfy { $0.outcome == "Stopped" })
}

@Test @MainActor func cancellationIsScopedToConnectionAndLateOutputCannotReplaceIt() async throws {
  let first = Events(), second = Events()
  var sinks: [NativeWriter] = []
  let controller = CompanionController { request, writer, _ in
    sinks.append(writer)
    try await Task.sleep(for: .seconds(3600))
    return HostEvent(id: request.id, type: "done", text: "Late answer")
  }
  let firstClient = UUID(), secondClient = UUID()
  controller.connect(firstClient); controller.connect(secondClient)
  for (client, events) in [(firstClient, first), (secondClient, second)] {
    controller.receive(HostRequest(id: "same-id", action: "generate", prompt: "Saved evidence"), client: client, writer: events.writer)
  }
  try await settle { sinks.count == 2 }
  controller.disconnect(firstClient)
  #expect(controller.connections == 1)
  #expect(controller.active.count == 1)
  #expect(first.values.last?.type == "cancelled")
  #expect(second.values.isEmpty)
  try sinks[0].send(HostEvent(id: "same-id", type: "chunk", text: "Late private text"))
  #expect(!first.values.contains { $0.text == "Late private text" })
  controller.quit()
  #expect(controller.active.isEmpty)
  #expect(second.values.last?.type == "cancelled")
  controller.receive(HostRequest(id: "after-quit", action: "status"), client: secondClient, writer: second.writer)
  #expect(second.values.last?.type == "error")
}

@Test @MainActor func dashboardHistoryContainsOnlyBoundedOperationMetadata() async throws {
  let events = Events()
  let controller = CompanionController { request, _, _ in
    HostEvent(id: request.id, type: "done", text: "Secret answer")
  }
  let client = UUID()
  controller.connect(client)
  for index in 0..<25 {
    controller.receive(HostRequest(id: "\(index)", action: "generate", prompt: "Secret prompt https://private.test/"), client: client, writer: events.writer)
    try await settle { controller.active.isEmpty }
  }
  #expect(controller.history.count <= 20)
  #expect(controller.history.last?.finishedAt != nil)
  #expect(controller.history.allSatisfy { $0.outcome == "Completed" })
  #expect(!String(describing: controller.history).contains("Secret"))
  #expect(!String(describing: controller.history).contains("private.test"))
}
