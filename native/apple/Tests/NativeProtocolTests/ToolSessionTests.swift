import Foundation
import Testing
@testable import NativeProtocol

private actor Invocations {
  var values: [ToolInvocation] = []
  func append(_ invocation: ToolInvocation) { values.append(invocation) }
  func first() -> ToolInvocation? { values.first }
}

private func invocation(_ events: Invocations) async throws -> ToolInvocation {
  for _ in 0..<2000 { if let value = await events.first() { return value }; await Task.yield() }
  throw NSError(domain: "Expected a pending native tool invocation", code: 1)
}

@Test func closingAToolSessionReleasesPendingReadsAndRejectsLaterReadsWithoutRelyingOnModelCancellation() async throws {
  let events = Invocations()
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in if let call = event.toolCall { Task { await events.append(call) } } }), limit: 3)
  let task = Task { try await channel.call(name: "fetch_more", arguments: "{}") }
  _ = try await invocation(events)
  await channel.close()
  await #expect(throws: CancellationError.self) { try await task.value }
  await #expect(throws: CancellationError.self) { try await channel.call(name: "search_memory", arguments: "{}") }
  #expect(await channel.calls == 1)
}

@Test func toolRepliesAreCorrelatedAndTheCallAllowanceIsNotResetByAContextWindow() async throws {
  let events = Invocations()
  let writer = NativeWriter(sendEvent: { event in if let call = event.toolCall { Task { await events.append(call) } } })
  let channel = ToolSession(requestId: "run", writer: writer, limit: 1)
  let task = Task { try await channel.call(name: "fetch_more", arguments: "{\"url\":\"https://example.test\"}") }
  let call = try await invocation(events)
  await channel.resolve(callId: "unrelated", result: "Must not replace evidence")
  await channel.resolve(callId: call.callId, result: "Saved evidence [7]")
  #expect(try await task.value == "Saved evidence [7]")
  await channel.setContextCheck { _ in true }
  await #expect(throws: ToolSessionError.self) { try await channel.call(name: "search_memory", arguments: "{}") }
  #expect(await channel.allowanceExceeded)
  #expect(await channel.calls == 1)
}

@Test func cancellationReleasesAWaitingBrowserToolAndLateRepliesAreIgnored() async throws {
  let events = Invocations()
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in if let call = event.toolCall { Task { await events.append(call) } } }), limit: 3)
  let task = Task { try await channel.call(name: "search_memory", arguments: "{}") }
  let call = try await invocation(events)
  task.cancel()
  await #expect(throws: CancellationError.self) { try await task.value }
  await channel.resolve(callId: call.callId, result: "Late evidence")
  #expect(await channel.takeObservations().isEmpty)
}

@Test func compactionPreservesTheJustReadObservationWithoutReturningAnOversizedToolResult() async throws {
  let events = Invocations()
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in if let call = event.toolCall { Task { await events.append(call) } } }), limit: 3)
  await channel.setContextCheck { $0.isEmpty }
  let task = Task { try await channel.call(name: "fetch_more", arguments: "{\"chunkIndex\":4}") }
  let call = try await invocation(events)
  await channel.resolve(callId: call.callId, result: "The saved date is May 19 [7]")
  await #expect(throws: ToolSessionError.self) { try await task.value }
  #expect(await channel.needsCompaction)
  let observations = await channel.takeObservations()
  #expect(observations.count == 1)
  #expect(observations[0].contains("May 19 [7]"))
  await channel.setContextCheck { _ in true }
  #expect(await !channel.needsCompaction)
  #expect(await channel.calls == 1)
}
