import CryptoKit
import Darwin
import Foundation
import NativeProtocol

public final class ManagedBackups: @unchecked Sendable {
  public static let folderKey = "managedBackupFolder"
  private let folder: @Sendable () -> URL?
  private let lock = NSLock()

  public init(folder: @escaping @Sendable () -> URL? = {
    guard let path = UserDefaults.standard.string(forKey: folderKey), !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
  }) { self.folder = folder }

  private struct Request: Decodable {
    let id: String
    let action: String
    var libraryId: String?
    var keyId: String?
    var revision: Int?
    var keep: Int?
    var automatic: Bool?
    var data: Data?
  }

  private struct Entry {
    let url: URL
    let timestamp: Int
    let revision: Int
  }

  private struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
  }

  private struct ArchiveFrames {
    private var headerSeen = false
    private var dataSeen = false
    private(set) var complete = false

    mutating func accept(_ bytes: Data) throws {
      guard !complete else { throw Failure("Unexpected data after the encrypted backup.") }
      if !headerSeen {
        guard bytes.count == 37, bytes.starts(with: "WRBK1".utf8) else { throw Failure("Only encrypted backups can be saved to this folder.") }
        headerSeen = true
        return
      }
      guard (20...(256 * 1024 + 20)).contains(bytes.count) else { throw Failure("Invalid encrypted backup frame.") }
      let length = bytes.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
      guard length == bytes.count - 4 else { throw Failure("Invalid encrypted backup frame.") }
      if length == 16 {
        guard dataSeen else { throw Failure("The encrypted backup is empty.") }
        complete = true
      } else {
        dataSeen = true
      }
    }
  }

  private func entries(in directory: URL, keyId: String) throws -> [Entry] {
    try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]).compactMap { url in
      let name = url.deletingPathExtension().lastPathComponent
      if url.pathExtension == "partial", name.hasPrefix("."), name.hasSuffix(".wrbackup"),
         UUID(uuidString: String(name.dropFirst().dropLast(".wrbackup".count))) != nil,
         (try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])).map({ $0.isRegularFile == true && $0.isSymbolicLink != true }) == true {
        try? FileManager.default.removeItem(at: url)
        return nil
      }
      let parts = name.split(separator: "_")
      guard url.pathExtension == "wrbackup", parts.count == 5, parts[0] == "backup", parts[3] == keyId,
            let timestamp = Int(parts[1]), let revision = Int(parts[2]), UUID(uuidString: String(parts[4])) != nil else { return nil }
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? 0) > 0 else { return nil }
      return Entry(url: url, timestamp: timestamp, revision: revision)
    }.sorted { $0.timestamp > $1.timestamp }
  }

  public func serve(_ first: Data, read: () throws -> Data?, writer: NativeWriter) {
    var id = "native-connection"
    do {
      let request = try JSONDecoder().decode(Request.self, from: first)
      id = request.id
      if request.action == "backup_status_encrypted" {
        try writer.send(HostEvent(id: id, type: "backup_status_encrypted", text: folder()?.path))
        return
      }
      guard request.action == "backup_begin_encrypted", let libraryId = request.libraryId,
            let keyId = request.keyId, keyId.utf8.count == 32, keyId.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
            let uuid = UUID(uuidString: libraryId), let revision = request.revision, revision >= 0,
            let keep = request.keep, (1...30).contains(keep) else { throw ProtocolError.invalidRequest }
      guard lock.try() else { throw Failure("Another local backup is running. Try again.") }
      defer { lock.unlock() }
      guard let root = folder() else { throw Failure("Choose a backup folder in the Web Recall Mac dashboard first.") }
      let directory = root.appendingPathComponent("Web Recall " + uuid.uuidString.lowercased(), isDirectory: true)
      do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
      catch let error as CocoaError where error.code == .fileWriteFileExists { }
      let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else { throw Failure("The managed backup directory is not a folder.") }
      let previous = try entries(in: directory, keyId: keyId)
      if request.automatic == true, previous.first?.revision == revision {
        try writer.send(HostEvent(id: id, type: "backup_unchanged_encrypted"))
        return
      }
      let nonce = UUID().uuidString
      let temporary = directory.appendingPathComponent(".\(nonce).wrbackup.partial")
      let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard descriptor >= 0 else { throw Failure("Could not create a temporary backup file. Check folder access and disk space.") }
      let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      defer {
        try? file.close()
        try? FileManager.default.removeItem(at: temporary)
      }
      try writer.send(HostEvent(id: id, type: "backup_ready_encrypted"))
      var archive = ArchiveFrames()
      var hash = SHA256()
      while let body = try read() {
        let next = try JSONDecoder().decode(Request.self, from: body)
        guard next.id == id, folder() == root else { throw Failure("The backup folder changed. Try again.") }
        if next.action == "backup_finish" {
          guard archive.complete else { throw Failure("The encrypted backup was incomplete.") }
          try file.synchronize()
          try file.close()
          let reader = try FileHandle(forReadingFrom: temporary)
          var verified = SHA256()
          defer { try? reader.close() }
          while let bytes = try reader.read(upToCount: 256 * 1024), !bytes.isEmpty { verified.update(data: bytes) }
          guard hash.finalize() == verified.finalize() else { throw Failure("The written backup failed verification.") }
          guard folder() == root else { throw Failure("The backup folder changed. Try again.") }
          let timestamp = max(Int(Date().timeIntervalSince1970 * 1000), min(previous.first?.timestamp ?? 0, Int.max - 1) + 1)
          let destination = directory.appendingPathComponent("backup_\(timestamp)_\(revision)_\(keyId)_\(nonce).wrbackup")
          try FileManager.default.moveItem(at: temporary, to: destination)
          let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
          guard directoryDescriptor >= 0 else { throw Failure("The backup was written, but the folder could not be verified. Older backups were kept.") }
          defer { _ = Darwin.close(directoryDescriptor) }
          guard fsync(directoryDescriptor) == 0 else { throw Failure("The backup was written, but the folder could not be verified. Older backups were kept.") }
          let warning = previous.dropFirst(keep - 1).reduce(false) { failed, entry in
            do { try FileManager.default.removeItem(at: entry.url); return failed }
            catch { return true }
          }
          try writer.send(HostEvent(id: id, type: "backup_saved", text: warning ? "Backup saved, but older backups could not all be removed." : nil))
          return
        }
        guard next.action == "backup_chunk", let bytes = next.data else { throw ProtocolError.invalidRequest }
        try archive.accept(bytes)
        try file.write(contentsOf: bytes)
        hash.update(data: bytes)
        try writer.send(HostEvent(id: id, type: "backup_ack"))
      }
    } catch {
      try? writer.send(HostEvent(id: id, type: "error", text: String(describing: error)))
    }
  }
}
