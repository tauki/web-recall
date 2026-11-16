import Darwin
import Foundation

public struct UpdateStartup: Codable, Sendable {
  public let nonce: String
  public let version: String
  public let processID: Int32

  @MainActor public static func confirm(directory: URL, nonce: String, app: URL) throws -> String? {
    let transaction = try UpdateTransaction(directory: directory), plan = try transaction.load()
    guard transaction.destination.resolvingSymlinksInPath().path == app.resolvingSymlinksInPath().path, nonce == plan.nonce else { throw UpdateError.unsafePath }
    let bundle = try UpdateBundle.inspect(app)
    let manifest = try SignedUpdate.verify(Data(contentsOf: directory.appendingPathComponent("update.json")), publicKey: bundle.publicKey, installedVersion: plan.originalVersion, systemVersion: UpdatePolicy.systemVersion)
    let expected = plan.phase == "rolledBack" ? plan.originalVersion : manifest.version
    guard ["replaced", "rolledBack"].contains(plan.phase), bundle.version == expected else { throw UpdateError.invalidBundle }
    try UpdateFiles.write(JSONEncoder().encode(Self(nonce: nonce, version: bundle.version, processID: getpid())), to: transaction.readyURL)
    return plan.phase == "rolledBack" ? manifest.version : nil
  }

  public static func read(from file: URL, nonce: String, version: String, processID: Int32) throws -> Bool {
    try UpdateFiles.check(file, directory: false, privateOnly: true)
    let data = try Data(contentsOf: file)
    guard data.count <= 4096 else { throw UpdateError.unsafePath }
    let message = try JSONDecoder().decode(Self.self, from: data)
    return message.nonce == nonce && message.version == version && message.processID == processID
  }
}
