import CompanionCore
import Foundation
import NativeProtocol
import Testing

private let firstLibrary = "13eae341-6bf5-4e48-8daf-66a247086021"
private let otherLibrary = "13eae341-6bf5-4e48-8daf-66a247086022"
let sampleKeyId = "0146cead6456ea78c5afb84abcf3e5e9"
let sampleEncryptedFrames = [
  Data("WRBK1".utf8) + Data(repeating: 0x93, count: 32),
  Data([0, 0, 0, 18]) + Data(repeating: 0xa4, count: 18),
  Data([0, 0, 0, 16]) + Data(repeating: 0xb5, count: 16)
]
let sampleEncryptedBackup = sampleEncryptedFrames.reduce(into: Data()) { $0.append($1) }

private final class Replies: @unchecked Sendable {
  var events: [String] = []
  var writer: NativeWriter { NativeWriter(sendEvent: { self.events.append($0.type) }) }
}

private func transfer(_ service: ManagedBackups, library: String = firstLibrary, keyId: String = sampleKeyId, revision: Int, keep: Int = 3, automatic: Bool = false, frames: [Data] = sampleEncryptedFrames, finish: Bool = true, action: String = "backup_begin_encrypted") throws -> [String] {
  let id = UUID().uuidString
  let begin = try JSONSerialization.data(withJSONObject: ["id": id, "action": action, "libraryId": library, "keyId": keyId, "revision": revision, "keep": keep, "automatic": automatic])
  var requests = try frames.map { part in
    try JSONSerialization.data(withJSONObject: ["id": id, "action": "backup_chunk", "data": part.base64EncodedString()])
  }
  if finish { requests.append(try JSONSerialization.data(withJSONObject: ["id": id, "action": "backup_finish"])) }
  let replies = Replies()
  var remaining = requests.makeIterator()
  service.serve(begin, read: { remaining.next() }, writer: replies.writer)
  return replies.events
}

private func savedFiles(_ root: URL, library: String = firstLibrary) throws -> Set<URL> {
  Set(try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("Web Recall " + library), includingPropertiesForKeys: nil))
}

@Test func onlyVerifiedReplacementRotatesPreviousBackupsAndOtherLibrariesAreUntouched() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
  defer { try? FileManager.default.removeItem(at: root) }
  let service = ManagedBackups(folder: { root })
  #expect(try transfer(service, library: otherLibrary, revision: 1).last == "backup_saved")
  let unrelated = try savedFiles(root, library: otherLibrary)
  var oldest: URL?
  for revision in 1...4 {
    #expect(try transfer(service, revision: revision).last == "backup_saved")
    if revision == 1 { oldest = try savedFiles(root).first }
  }
  let before = try savedFiles(root)
  #expect(before.count == 3)
  #expect(!before.contains(try #require(oldest)))
  for url in before {
    #expect(url.pathExtension == "wrbackup")
    #expect(try Data(contentsOf: url) == sampleEncryptedBackup)
  }
  #expect(try transfer(service, revision: 4, automatic: true) == ["backup_unchanged_encrypted"])

  #expect(try transfer(service, revision: 5, keep: 1, finish: false).last == "backup_ack")
  #expect(try transfer(service, revision: 5, keep: 1, frames: Array(sampleEncryptedFrames.dropLast())).last == "error")
  #expect(try transfer(service, revision: 5, keep: 1, frames: sampleEncryptedFrames + [sampleEncryptedFrames[1]]).last == "error")
  #expect(try savedFiles(root) == before)
  #expect(try transfer(service, revision: 5, keep: 1).last == "backup_saved")
  let newest = try savedFiles(root)
  #expect(newest.count == 1)
  #expect(before.isDisjoint(with: newest))
  #expect(try savedFiles(root, library: otherLibrary) == unrelated)
}

@Test func plaintextAndOtherRecoveryKeysCannotRotateExistingEncryptedBackups() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
  defer { try? FileManager.default.removeItem(at: root) }
  let service = ManagedBackups(folder: { root })
  #expect(try transfer(service, revision: 1).last == "backup_saved")
  let original = try #require(try savedFiles(root).first)
  let plaintext = Data(#"{"format":"web-recall","schemaVersion":3}"#.utf8)
  let legacy = original.deletingLastPathComponent().appendingPathComponent("backup_1000_0_\(UUID().uuidString).jsonl")
  try plaintext.write(to: legacy)
  let before = try savedFiles(root)
  #expect(try transfer(service, revision: 2, keep: 1, action: "backup_begin") == ["error"])
  #expect(try transfer(service, revision: 2, keep: 1, frames: [plaintext]).last == "error")
  #expect(try savedFiles(root) == before)
  let differentKey = String(repeating: "f", count: 32)
  #expect(try transfer(service, keyId: differentKey, revision: 1, keep: 1, automatic: true).last == "backup_saved")
  #expect(before.isSubset(of: try savedFiles(root)))
  #expect(try transfer(service, revision: 2, keep: 1).last == "backup_saved")
  #expect(try Data(contentsOf: legacy) == plaintext)
  #expect(try savedFiles(root).count == 3)
}

@Test func anUnconfiguredFolderAndASymlinkDestinationCannotPublishBackups() throws {
  #expect(try transfer(ManagedBackups(folder: { nil }), revision: 1) == ["error"])
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let outside = root.appendingPathComponent("other")
  try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Web Recall " + firstLibrary), withDestinationURL: outside)
  #expect(try transfer(ManagedBackups(folder: { root }), revision: 1) == ["error"])
  #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
}
