import CompanionCore
import Foundation
import NativeProtocol
import Testing

private func temporaryDirectory() throws -> URL {
  let directory = URL(fileURLWithPath: "/private/tmp/wr-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return directory
}

private func withBlockingClientIO<Value: Sendable>(_ operation: @escaping @Sendable () throws -> Value) async throws -> Value {
  try await withCheckedThrowingContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(with: Result(catching: operation)) }
  }
}

@Test @MainActor func localBridgeStreamsResponsesAndQuitLeavesNoListeningEndpoint() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  let controller = CompanionController { request, writer, _ in
    try writer.send(HostEvent(id: request.id, type: "chunk", text: "Saved"))
    return HostEvent(id: request.id, type: "done", text: "Saved fact [1]")
  }
  let server = CompanionServer(directory: directory, expectedExecutable: executable, controller: controller)
  try server.start()
  defer { server.stop() }
  let events = try await withBlockingClientIO {
    let connection = try LocalConnection.connect(directory: directory, expectedExecutable: executable)
    defer { connection.close() }
    try connection.send(Data(#"{"id":"sample","action":"generate","prompt":"Read saved evidence"}"#.utf8))
    var events: [[String: String]] = []
    for _ in 0..<2 {
      let received = try connection.read()
      let data = try #require(received)
      let object = try JSONSerialization.jsonObject(with: data)
      events.append(try #require(object as? [String: String]))
    }
    return events
  }
  #expect(events.map { $0["type"] } == ["chunk", "done"])
  #expect(events.last?["text"] == "Saved fact [1]")
  controller.quit(); server.stop()
  #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("companion.sock").path))
  #expect(throws: CompanionError.self) { try LocalConnection.connect(directory: directory, expectedExecutable: executable) }
}

@Test @MainActor func anotherInstanceCannotRemoveTheLiveEndpointOrAnUnrelatedFile() throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  let controller = CompanionController { request, _, _ in HostEvent(id: request.id, type: "done", text: "OK") }
  let first = CompanionServer(directory: directory, expectedExecutable: executable, controller: controller)
  try first.start()
  defer { first.stop() }
  let second = CompanionServer(directory: directory, expectedExecutable: executable, controller: controller)
  #expect(throws: CompanionError.self) { try second.start() }
  second.stop()
  #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("companion.sock").path))
  first.stop()
  let unrelated = directory.appendingPathComponent("companion.sock")
  try Data("Preserve this file".utf8).write(to: unrelated)
  #expect(throws: CompanionError.self) { try second.start() }
  #expect(try String(contentsOf: unrelated, encoding: .utf8) == "Preserve this file")
}

@Test @MainActor func bridgeRejectsACompanionWithTheWrongExecutableIdentity() throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  let controller = CompanionController { request, _, _ in HostEvent(id: request.id, type: "done", text: "OK") }
  let server = CompanionServer(directory: directory, expectedExecutable: executable, controller: controller)
  try server.start()
  defer { server.stop() }
  #expect(throws: CompanionError.self) { try LocalConnection.connect(directory: directory, expectedExecutable: URL(fileURLWithPath: "/different-app")) }
  #expect(controller.active.isEmpty)
}

@Test @MainActor func companionRejectsLocalCallersOtherThanItsExpectedBridge() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  var executions = 0
  let controller = CompanionController { request, _, _ in executions += 1; return HostEvent(id: request.id, type: "done", text: "Must not be sent") }
  let server = CompanionServer(directory: directory, expectedExecutable: URL(fileURLWithPath: "/different-bridge"), controller: controller)
  try server.start()
  defer { server.stop() }
  let refused = try await withBlockingClientIO {
    do {
      let connection = try LocalConnection.connect(directory: directory, expectedExecutable: executable)
      defer { connection.close() }
      try connection.send(Data(#"{"id":"untrusted","action":"generate","prompt":"Do not execute"}"#.utf8))
      return try connection.read() == nil
    } catch { return true }
  }
  #expect(refused)
  #expect(executions == 0)
}

@Test @MainActor func idleConnectionsCannotStarveConcurrentClientRequests() async throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  let controller = CompanionController { request, writer, _ in
    try writer.send(HostEvent(id: request.id, type: "chunk", text: "Reading"))
    return HostEvent(id: request.id, type: "done", text: request.prompt)
  }
  let server = CompanionServer(directory: directory, expectedExecutable: executable, controller: controller)
  try server.start()
  defer { server.stop() }
  let watchdog = DispatchWorkItem { @Sendable in
    Issue.record("Socket handling failed to make progress with an idle connection and concurrent clients.")
    server.stop()
  }
  DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: watchdog)
  defer { watchdog.cancel() }
  let idle = try await withBlockingClientIO { try LocalConnection.connect(directory: directory, expectedExecutable: executable) }
  defer { idle.close() }
  let answers = try await withThrowingTaskGroup(of: String.self) { group in
    for index in 0..<4 {
      group.addTask {
        try await withBlockingClientIO {
          let connection = try LocalConnection.connect(directory: directory, expectedExecutable: executable)
          defer { connection.close() }
          let id = "client-\(index)", prompt = "Saved evidence \(index)"
          try connection.send(Data("{\"id\":\"\(id)\",\"action\":\"generate\",\"prompt\":\"\(prompt)\"}".utf8))
          var last = ""
          for expectedType in ["chunk", "done"] {
            let received = try connection.read()
            let data = try #require(received)
            let object = try JSONSerialization.jsonObject(with: data)
            let event = try #require(object as? [String: String])
            #expect(event["id"] == id)
            #expect(event["type"] == expectedType)
            last = try #require(event["text"])
          }
          return last
        }
      }
    }
    var received: [String] = []
    for try await answer in group { received.append(answer) }
    return received
  }
  #expect(answers.sorted() == (0..<4).map { "Saved evidence \($0)" })
  controller.quit(); server.stop()
  #expect(try await withBlockingClientIO { try idle.read() } == nil)
}
