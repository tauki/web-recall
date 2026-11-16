import CryptoKit
import Darwin
import Foundation
import Testing
@testable import UpdateCore

func temporaryUpdateDirectory() throws -> URL {
  let root = URL(fileURLWithPath: "/private/tmp/wr-package-\(UUID().uuidString)")
  try UpdateFiles.createPrivateDirectory(root)
  return root
}

func signedApp(in root: URL, version: String = "0.2.4", publicKey: Data = signingFixture.publicKey.rawRepresentation, minimumSystemVersion: String = "26.4") throws -> URL {
  let app = root.appendingPathComponent("Web Recall.app"), contents = app.appendingPathComponent("Contents"), binaries = contents.appendingPathComponent("MacOS")
  try FileManager.default.createDirectory(at: binaries, withIntermediateDirectories: true)
  let plist: [String: Any] = ["CFBundleIdentifier": "com.webrecall.companion", "CFBundleExecutable": "WebRecallCompanion", "CFBundlePackageType": "APPL", "CFBundleShortVersionString": version, "CFBundleVersion": version, "WebRecallUpdatePublicKey": publicKey.base64EncodedString(), "LSMinimumSystemVersion": minimumSystemVersion]
  try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
  for name in ["WebRecallCompanion", "web-recall-apple", "WebRecallUpdater"] {
    let file = binaries.appendingPathComponent(name)
    try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: file)
    try UpdateFiles.run("/usr/bin/codesign", ["--force", "--sign", "-", file.path])
  }
  try UpdateFiles.run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
  return app
}

@Test func signingDerivesCompatibilityFromTheAppAndRefusesADifferentPrivateKey() throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let app = try signedApp(in: root, minimumSystemVersion: "27.1"), archive = root.appendingPathComponent("release.zip"), metadata = root.appendingPathComponent("update.json")
  try package(app, to: archive)
  let otherKey = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x22, count: 32))
  #expect(throws: UpdateError.self) { try UpdateSigningKey.sign(archive: archive, app: app, output: metadata, key: otherKey) }
  #expect(!FileManager.default.fileExists(atPath: metadata.path))
  try UpdateSigningKey.sign(archive: archive, app: app, output: metadata, key: signingFixture)
  #expect(throws: UpdateError.self) { try SignedUpdate.verify(Data(contentsOf: metadata), publicKey: signingFixture.publicKey.rawRepresentation, installedVersion: "0.2.3", systemVersion: "27.0.0") }
  let manifest = try SignedUpdate.verify(Data(contentsOf: metadata), publicKey: signingFixture.publicKey.rawRepresentation, installedVersion: "0.2.3", systemVersion: "27.1.0")
  #expect(manifest.minimumSystemVersion == "27.1.0")
}

func package(_ app: URL, to archive: URL) throws {
  let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
  process.currentDirectoryURL = app.deletingLastPathComponent()
  process.arguments = ["-qryX", archive.path, app.lastPathComponent]
  try process.run(); process.waitUntilExit()
  #expect(process.terminationStatus == 0)
}

@Test func aSignedReleaseRoundTripsThroughTheRealPackagerExtractorAndBundleVerifier() throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let app = try signedApp(in: root), archive = root.appendingPathComponent("release.zip"), envelope = root.appendingPathComponent("update.json")
  try package(app, to: archive)
  try UpdateSigningKey.sign(archive: archive, app: app, output: envelope, key: signingFixture)
  let update = try SignedUpdate.verify(Data(contentsOf: envelope), publicKey: signingFixture.publicKey.rawRepresentation, installedVersion: "0.2.3", systemVersion: "27.0.0")
  try update.verifyArchive(archive)
  let extracted = try UpdateArchive.extract(archive, into: root.appendingPathComponent("extracted"))
  #expect(try UpdateBundle.inspect(extracted, version: "0.2.4", publicKey: signingFixture.publicKey.rawRepresentation).version == "0.2.4")
  let handle = try FileHandle(forWritingTo: archive); try handle.seek(toOffset: 10); try handle.write(contentsOf: Data([0xff])); try handle.close()
  #expect(throws: UpdateError.self) { try update.verifyArchive(archive) }
}

@Test func modifiedCodeAndWrongBundleIdentityCannotBecomeInstallCandidates() throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let app = try signedApp(in: root)
  #expect(throws: UpdateError.self) { try UpdateBundle.inspect(app, version: "9.0.0") }
  #expect(throws: UpdateError.self) { try UpdateBundle.inspect(app, publicKey: Data(repeating: 0x55, count: 32)) }
  let executable = app.appendingPathComponent("Contents/MacOS/web-recall-apple")
  let handle = try FileHandle(forWritingTo: executable); try handle.seekToEnd(); try handle.write(contentsOf: Data("Tampered".utf8)); try handle.close()
  #expect(throws: UpdateError.self) { try UpdateBundle.inspect(app) }
}

func rawZip(name: String, mode: Int = Int(S_IFREG) | 0o644, expanded: Int = 1) -> Data {
  var data = Data()
  func number(_ value: Int, _ count: Int) { for index in 0..<count { data.append(UInt8(truncatingIfNeeded: value >> (8 * index))) } }
  let bytes = Data(name.utf8)
  number(0x04034b50, 4); number(20, 2); number(0, 2); number(0, 2); number(0, 4); number(0, 4); number(1, 4); number(expanded, 4); number(bytes.count, 2); number(0, 2); data.append(bytes); data.append(0)
  let start = data.count
  number(0x02014b50, 4); number(3 << 8 | 20, 2); number(20, 2); number(0, 2); number(0, 2); number(0, 4); number(0, 4); number(1, 4); number(expanded, 4)
  number(bytes.count, 2); number(0, 2); number(0, 2); number(0, 2); number(0, 2); number(mode << 16, 4); number(0, 4); data.append(bytes)
  let size = data.count - start
  number(0x06054b50, 4); number(0, 2); number(0, 2); number(1, 2); number(1, 2); number(size, 4); number(start, 4); number(0, 2)
  return data
}

@Test func archiveValidationRejectsTraversalLinksAndExpansionBombsBeforeExtraction() throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let archive = root.appendingPathComponent("release.zip")
  for data in [rawZip(name: "../escape"), rawZip(name: "Web Recall.app/../../escape"), rawZip(name: "Web Recall.app/Contents/link", mode: Int(S_IFLNK) | 0o777), rawZip(name: "Web Recall.app/Contents/file", expanded: UpdatePolicy.expandedLimit + 1), rawZip(name: "Web Recall.app/Contents\\escape"), Data([1, 2, 3])] {
    try data.write(to: archive)
    #expect(throws: UpdateError.self) { try UpdateArchive.extract(archive, into: root.appendingPathComponent("extracted")) }
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("extracted").path))
  }
}

@Test func redirectsAndStartupMessagesCannotSubstituteAnotherOriginProcessOrVersion() throws {
  let source = UpdatePolicy.asset(version: "0.2.4", name: UpdatePolicy.archiveName(version: "0.2.4"))
  #expect(UpdateRedirects.allows(URL(string: "https://release-assets.githubusercontent.com/path?signature=value")!, from: source))
  for value in ["http://github.com/path", "https://attacker.test/path", "https://github.com.evil.test/path", "https://user:password@release-assets.githubusercontent.com/path", "https://release-assets.githubusercontent.com:444/path"] { #expect(!UpdateRedirects.allows(URL(string: value)!, from: source)) }
  #expect(!UpdateRedirects.allows(source, from: UpdatePolicy.releaseAPI))
  #expect(!UpdateRedirects.allowsSource(URL(string: "https://github.com/another/project/releases/download/v0.2.4/release.zip")!))
  #expect(!UpdateRedirects.allowsSource(URL(string: "https://attacker.test/update.zip")!))
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let file = root.appendingPathComponent("startup.json"), nonce = UUID().uuidString
  try UpdateFiles.write(JSONEncoder().encode(UpdateStartup(nonce: nonce, version: "0.2.4", processID: 123)), to: file)
  #expect(try UpdateStartup.read(from: file, nonce: nonce, version: "0.2.4", processID: 123))
  #expect(try !UpdateStartup.read(from: file, nonce: "wrong", version: "0.2.4", processID: 123))
  #expect(try !UpdateStartup.read(from: file, nonce: nonce, version: "0.2.3", processID: 123))
  #expect(try !UpdateStartup.read(from: file, nonce: nonce, version: "0.2.4", processID: 456))
}

@Test func bundleIdentityIsRereadAfterAnAtomicReplacementInsteadOfUsingCachedPlistValues() throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let staging = root.appendingPathComponent("staging")
  try UpdateFiles.createPrivateDirectory(staging)
  let installed = try signedApp(in: root, version: "0.2.3"), candidate = try signedApp(in: staging)
  _ = Bundle(url: installed)?.infoDictionary
  #expect(try UpdateBundle.inspect(installed).version == "0.2.3")
  try UpdateFiles.swap(installed, candidate)
  #expect(try UpdateBundle.inspect(installed, version: "0.2.4").version == "0.2.4")
  #expect(try UpdateBundle.inspect(candidate, version: "0.2.3").version == "0.2.3")
}

@Test @MainActor func startupAcknowledgesOnlyTheExpectedSignedAppAndReturnsRollbackIdentityWithoutAnotherJobRead() throws {
  for rolledBack in [false, true] {
    let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
    let app = try signedApp(in: root, version: rolledBack ? "0.2.3" : "0.2.4")
    let job = root.appendingPathComponent(".web-recall-update-\(UUID().uuidString)")
    try UpdateFiles.createPrivateDirectory(job)
    let transaction = try UpdateTransaction(directory: job), nonce = UUID().uuidString
    try transaction.save(UpdatePlan(schemaVersion: 1, originalVersion: "0.2.3", nonce: nonce, phase: rolledBack ? "rolledBack" : "replaced"))
    try UpdateFiles.write(manifestFixture(), to: job.appendingPathComponent("update.json"))
    #expect(throws: UpdateError.self) { try UpdateStartup.confirm(directory: job, nonce: "wrong", app: app) }
    #expect(!FileManager.default.fileExists(atPath: transaction.readyURL.path))
    let failedVersion = try UpdateStartup.confirm(directory: job, nonce: nonce, app: app)
    #expect(try UpdateStartup.read(from: transaction.readyURL, nonce: nonce, version: rolledBack ? "0.2.3" : "0.2.4", processID: getpid()))
    try FileManager.default.removeItem(at: job)
    #expect(failedVersion == (rolledBack ? "0.2.4" : nil))
  }
}
