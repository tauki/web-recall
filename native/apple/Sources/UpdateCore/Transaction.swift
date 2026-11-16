import Darwin
import Foundation

public struct UpdatePlan: Codable, Sendable {
  public let schemaVersion: Int
  public let originalVersion: String
  public let nonce: String
  public var phase: String
  public var failure: String?
}

@MainActor public final class UpdateTransaction {
  public let directory: URL
  public let destination: URL
  public var candidate: URL { directory.appendingPathComponent("extracted/Web Recall.app", isDirectory: true) }
  public var archive: URL { directory.appendingPathComponent("release.zip") }
  public var planURL: URL { directory.appendingPathComponent("transaction.json") }
  public var readyURL: URL { directory.appendingPathComponent("startup.json") }

  public init(directory: URL) throws {
    try UpdateFiles.check(directory, directory: true, privateOnly: true)
    guard directory.lastPathComponent.hasPrefix(".web-recall-update-"), UUID(uuidString: String(directory.lastPathComponent.dropFirst(".web-recall-update-".count))) != nil else { throw UpdateError.unsafePath }
    self.directory = directory
    destination = directory.deletingLastPathComponent().appendingPathComponent("Web Recall.app", isDirectory: true)
    try UpdateFiles.check(directory.deletingLastPathComponent(), directory: true)
  }

  public static func prepare(app: URL, available: AvailableUpdate) async throws -> UpdateTransaction {
    guard app.lastPathComponent == "Web Recall.app" else { throw UpdateError.unsafePath }
    let installed = try UpdateBundle.inspect(app)
    let manifest = try SignedUpdate.verify(available.envelope, publicKey: installed.publicKey, installedVersion: installed.version, systemVersion: UpdatePolicy.systemVersion)
    let directory = app.deletingLastPathComponent().appendingPathComponent(".web-recall-update-\(UUID().uuidString)")
    try UpdateFiles.createPrivateDirectory(directory)
    let transaction = try UpdateTransaction(directory: directory)
    do {
      try UpdateFiles.write(available.envelope, to: directory.appendingPathComponent("update.json"))
      try await ReleaseClient.download(manifest.archiveURL, to: transaction.archive, limit: manifest.size)
      try manifest.verifyArchive(transaction.archive)
      let bundle = try UpdateArchive.extract(transaction.archive, into: directory.appendingPathComponent("extracted"))
      _ = try UpdateBundle.inspect(bundle, version: manifest.version, publicKey: installed.publicKey, team: installed.team)
      let helper = app.appendingPathComponent("Contents/MacOS/WebRecallUpdater")
      try FileManager.default.copyItem(at: helper, to: directory.appendingPathComponent("WebRecallUpdater"))
      try transaction.save(UpdatePlan(schemaVersion: 1, originalVersion: installed.version, nonce: UUID().uuidString, phase: "prepared"))
      return transaction
    } catch { try? FileManager.default.removeItem(at: directory); throw error }
  }

  public func load() throws -> UpdatePlan {
    try UpdateFiles.check(planURL, directory: false, privateOnly: true)
    let data = try Data(contentsOf: planURL)
    guard data.count <= 16 * 1024 else { throw UpdateError.unsafePath }
    let plan = try JSONDecoder().decode(UpdatePlan.self, from: data)
    guard plan.schemaVersion == 1, UUID(uuidString: plan.nonce) != nil,
          ["prepared", "replaced", "confirmed", "rolledBack"].contains(plan.phase) else { throw UpdateError.unsafePath }
    _ = try ReleaseVersion(plan.originalVersion)
    return plan
  }

  public func save(_ plan: UpdatePlan) throws { try UpdateFiles.write(JSONEncoder().encode(plan), to: planURL) }

  public func perform(publicKey: Data, systemVersion: String, verify: (URL, String, Data) throws -> Void, beforeReplacement: () async throws -> Void = {}, ensureStopped: (URL) throws -> Void = { _ in }, launch: (URL, String?, URL) async throws -> Bool) async throws {
    let lockURL = directory.deletingLastPathComponent().appendingPathComponent(".web-recall-update.lock")
    let lease = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lease >= 0 else { throw UpdateError.unsafePath }
    defer { close(lease) }
    try UpdateFiles.check(lockURL, directory: false, privateOnly: true)
    guard flock(lease, LOCK_EX | LOCK_NB) == 0 else { throw UpdateError.installation("Another app update is already running.") }
    var plan = try load()
    guard ["prepared", "replaced"].contains(plan.phase) else { return }
    let envelopeFile = directory.appendingPathComponent("update.json")
    try UpdateFiles.check(envelopeFile, directory: false, privateOnly: true)
    let update = try SignedUpdate.verify(Data(contentsOf: envelopeFile), publicKey: publicKey, installedVersion: plan.originalVersion, systemVersion: systemVersion)
    try update.verifyArchive(archive)
    if (try? verify(destination, plan.originalVersion, publicKey)) != nil {
      try verify(candidate, update.version, publicKey)
    } else {
      try verify(destination, update.version, publicKey)
      try verify(candidate, plan.originalVersion, publicKey)
    }
    try await beforeReplacement()
    let isOriginal = (try? verify(destination, plan.originalVersion, publicKey)) != nil
    if isOriginal {
      try verify(candidate, update.version, publicKey)
      try ensureStopped(destination)
      try UpdateFiles.swap(destination, candidate)
    } else {
      try verify(destination, update.version, publicKey)
      try verify(candidate, plan.originalVersion, publicKey)
    }
    do {
      plan.phase = "replaced"; try save(plan)
      try? FileManager.default.removeItem(at: readyURL)
      guard try await launch(destination, plan.nonce, directory) else { throw UpdateError.installation("The updated app did not confirm a healthy startup.") }
    } catch {
      if case UpdateError.applicationStillRunning = error { throw error }
      try verify(destination, update.version, publicKey)
      try verify(candidate, plan.originalVersion, publicKey)
      try ensureStopped(destination)
      try UpdateFiles.swap(destination, candidate)
      plan.phase = "rolledBack"; plan.failure = error.localizedDescription; try save(plan)
      guard try await launch(destination, nil, directory) else { throw UpdateError.installation("The previous app was restored but could not be relaunched. Open Web Recall from Applications.") }
      throw UpdateError.installation("Update failed; the previous app was restored and relaunched. \(error.localizedDescription)")
    }
    try verify(destination, update.version, publicKey)
    plan.phase = "confirmed"; try save(plan)
    if (try? verify(candidate, plan.originalVersion, publicKey)) != nil { try? FileManager.default.removeItem(at: candidate) }
    try? FileManager.default.removeItem(at: archive)
  }
}
