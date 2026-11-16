import CompanionCore
import Foundation
import NativeProtocol
import Testing

private func temporaryDirectory() throws -> URL {
  let directory = URL(fileURLWithPath: "/private/tmp/wr-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  return directory
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
  let exchange = Task.detached {
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
  let events = try await exchange.value
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
  let refused = await Task.detached {
    do {
      let connection = try LocalConnection.connect(directory: directory, expectedExecutable: executable)
      defer { connection.close() }
      try connection.send(Data(#"{"id":"untrusted","action":"generate","prompt":"Do not execute"}"#.utf8))
      return try connection.read() == nil
    } catch { return true }
  }.value
  #expect(refused)
  #expect(executions == 0)
}
