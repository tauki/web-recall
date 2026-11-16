import CryptoKit
import Foundation
import Testing
@testable import UpdateCore

@MainActor struct TransactionFixture {
  let root: URL
  let transaction: UpdateTransaction
  let nonce: String
  init() throws {
    root = URL(fileURLWithPath: "/private/tmp/wr-update-\(UUID().uuidString)")
    try UpdateFiles.createPrivateDirectory(root)
    let job = root.appendingPathComponent(".web-recall-update-\(UUID().uuidString)")
    try UpdateFiles.createPrivateDirectory(job)
    transaction = try UpdateTransaction(directory: job)
    try UpdateFiles.createPrivateDirectory(transaction.destination)
    try UpdateFiles.createPrivateDirectory(job.appendingPathComponent("extracted"))
    try UpdateFiles.createPrivateDirectory(transaction.candidate)
    try Data("0.2.3".utf8).write(to: transaction.destination.appendingPathComponent("version"))
    try Data("0.2.4".utf8).write(to: transaction.candidate.appendingPathComponent("version"))
    let archive = Data("Authenticated release bytes".utf8)
    try archive.write(to: transaction.archive)
    let digest = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
    try UpdateFiles.write(manifestFixture(overrides: ["size": archive.count, "sha256": digest]), to: job.appendingPathComponent("update.json"))
    nonce = UUID().uuidString
    try transaction.save(UpdatePlan(schemaVersion: 1, originalVersion: "0.2.3", nonce: nonce, phase: "prepared"))
  }
  func version(_ url: URL) throws -> String { try String(contentsOf: url.appendingPathComponent("version"), encoding: .utf8) }
  func verify(_ url: URL, _ version: String, _ key: Data) throws {
    guard try self.version(url) == version else { throw UpdateError.invalidBundle }
  }
  func remove() { try? FileManager.default.removeItem(at: root) }
}

@Test @MainActor func successfulReplacementKeepsTheOldAppUntilTheNewStartupIsConfirmed() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  var launches = 0
  try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { app, nonce, directory in
    launches += 1
    let installed = try fixture.version(app), backup = try fixture.version(fixture.transaction.candidate)
    #expect(installed == "0.2.4")
    #expect(backup == "0.2.3")
    #expect(nonce == fixture.nonce)
    #expect(directory == fixture.transaction.directory)
    return true
  }
  #expect(launches == 1)
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.4")
  #expect(try fixture.transaction.load().phase == "confirmed")
}

@Test @MainActor func failedStartupRestoresAndRelaunchesTheExactPreviousApp() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  var launches: [String] = []
  await #expect(throws: UpdateError.self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { app, nonce, _ in
      let version = try fixture.version(app); launches.append(version)
      if version == "0.2.3" { #expect(nonce == nil) }
      return version == "0.2.3"
    }
  }
  #expect(launches == ["0.2.4", "0.2.3"])
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.3")
  #expect(try fixture.transaction.load().phase == "rolledBack")
}

@Test @MainActor func aCrashBetweenTheAtomicSwapAndJournalWriteIsRecoverableWithoutSwappingTheWrongApp() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  try UpdateFiles.swap(fixture.transaction.destination, fixture.transaction.candidate)
  let resumed = try UpdateTransaction(directory: fixture.transaction.directory)
  try await resumed.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { app, _, _ in
    let installed = try fixture.version(app)
    #expect(installed == "0.2.4")
    return true
  }
  #expect(try fixture.version(resumed.destination) == "0.2.4")
  #expect(try resumed.load().phase == "confirmed")
}

@Test @MainActor func tamperedDownloadsCannotReachReplacementOrLaunchAndUnrelatedFilesStayUntouched() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  let unrelated = fixture.root.appendingPathComponent("unrelated.txt")
  try Data("Keep user data".utf8).write(to: unrelated)
  try Data("Tampered".utf8).write(to: fixture.transaction.archive)
  await #expect(throws: UpdateError.self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { _, _, _ in
      Issue.record("Unauthenticated updates must not launch"); return true
    }
  }
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.3")
  #expect(try String(contentsOf: unrelated, encoding: .utf8) == "Keep user data")
}

@Test @MainActor func symbolicInstallationPathsAreRejectedBeforeAnyReplacement() throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  let link = fixture.root.appendingPathComponent("linked")
  try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture.transaction.directory)
  #expect(throws: UpdateError.self) { try UpdateTransaction(directory: link) }
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.3")
}

@Test @MainActor func replacementWaitsForAdmissionAndDoesNotTouchEitherAppIfPreparationFails() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  await #expect(throws: CancellationError.self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify, beforeReplacement: {
      let installed = try fixture.version(fixture.transaction.destination)
      #expect(installed == "0.2.3")
      throw CancellationError()
    }, launch: { _, _, _ in Issue.record("Must not launch before admission"); return true })
  }
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.3")
  #expect(try fixture.version(fixture.transaction.candidate) == "0.2.4")
}

@Test @MainActor func anUnstoppableCandidateKeepsBothVersionsInsteadOfSwappingUnderARunningProcess() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  var launches = 0
  await #expect(throws: UpdateError.self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { _, _, _ in
      launches += 1; throw UpdateError.applicationStillRunning
    }
  }
  #expect(launches == 1)
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.4")
  #expect(try fixture.version(fixture.transaction.candidate) == "0.2.3")
  #expect(try fixture.transaction.load().phase == "replaced")
}

@Test @MainActor func aJournalFailureAfterHealthyStartupDoesNotRollBackARunningAppOrDeleteItsBackup() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  var launches = 0
  await #expect(throws: (any Error).self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { _, _, _ in
      launches += 1
      try FileManager.default.removeItem(at: fixture.transaction.planURL)
      try FileManager.default.createDirectory(at: fixture.transaction.planURL, withIntermediateDirectories: false)
      return true
    }
  }
  #expect(launches == 1)
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.4")
  #expect(try fixture.version(fixture.transaction.candidate) == "0.2.3")
}

@Test @MainActor func invalidCandidatesAreRejectedBeforeTheRunningParentIsAskedToQuit() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  try Data("Untrusted".utf8).write(to: fixture.transaction.candidate.appendingPathComponent("version"))
  var admitted = false
  await #expect(throws: UpdateError.self) {
    try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify, beforeReplacement: { admitted = true }, launch: { _, _, _ in Issue.record("Invalid candidate must not launch"); return true })
  }
  #expect(!admitted)
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.3")
}

@Test @MainActor func aSecondInstallerCannotReplaceAnAppWhileTheFirstHoldsItsTransactionLease() async throws {
  let fixture = try TransactionFixture(); defer { fixture.remove() }
  let competing = try UpdateTransaction(directory: fixture.transaction.directory)
  try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify, beforeReplacement: {
    await #expect(throws: UpdateError.self) {
      try await competing.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify) { _, _, _ in Issue.record("A concurrent installer must not launch"); return true }
    }
    let installed = try fixture.version(fixture.transaction.destination)
    #expect(installed == "0.2.3")
  }, launch: { _, _, _ in true })
  #expect(try fixture.version(fixture.transaction.destination) == "0.2.4")
}

@Test @MainActor func aManuallyOpenedAppCannotBeSwappedUnderDuringInstallOrRollback() async throws {
  for openedAfterReplacement in [false, true] {
    let fixture = try TransactionFixture(); defer { fixture.remove() }
    var checks = 0
    await #expect(throws: UpdateError.self) {
      try await fixture.transaction.perform(publicKey: signingFixture.publicKey.rawRepresentation, systemVersion: "27.0.0", verify: fixture.verify, ensureStopped: { _ in
        checks += 1
        if !openedAfterReplacement || checks == 2 { throw UpdateError.applicationStillRunning }
      }, launch: { _, _, _ in false })
    }
    #expect(try fixture.version(fixture.transaction.destination) == (openedAfterReplacement ? "0.2.4" : "0.2.3"))
    #expect(try fixture.version(fixture.transaction.candidate) == (openedAfterReplacement ? "0.2.3" : "0.2.4"))
  }
}
