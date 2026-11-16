import Darwin
import Foundation

public enum UpdateArchive {
  public static func validate(_ file: URL) throws {
    try UpdateFiles.check(file, directory: false)
    let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
    guard size >= 22, size <= UpdatePolicy.archiveLimit else { throw UpdateError.unsafeArchive }
    let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
    func number(_ offset: Int, _ length: Int) throws -> Int {
      guard offset >= 0, offset <= bytes.count - length else { throw UpdateError.unsafeArchive }
      return (0..<length).reduce(0) { $0 | Int(bytes[offset + $1]) << ($1 * 8) }
    }
    guard let end = stride(from: bytes.count - 22, through: max(0, bytes.count - 65557), by: -1).first(where: { (try? number($0, 4)) == 0x06054b50 && (try? number($0 + 20, 2)) == bytes.count - $0 - 22 }),
          try number(end + 4, 2) == 0, try number(end + 6, 2) == 0 else { throw UpdateError.unsafeArchive }
    let count = try number(end + 10, 2), start = try number(end + 16, 4)
    guard count > 0, count <= 4096, try number(end + 8, 2) == count, try start + number(end + 12, 4) == end else { throw UpdateError.unsafeArchive }
    var offset = start, expanded = 0
    var names = Set<String>(), files = Set<String>(), paths: [String] = []
    for _ in 0..<count {
      guard try number(offset, 4) == 0x02014b50 else { throw UpdateError.unsafeArchive }
      let flags = try number(offset + 8, 2), method = try number(offset + 10, 2), nameLength = try number(offset + 28, 2)
      let extra = try number(offset + 30, 2), comment = try number(offset + 32, 2), local = try number(offset + 42, 4)
      let compressed = try number(offset + 20, 4), uncompressed = try number(offset + 24, 4)
      let mode = try number(offset + 38, 4) >> 16, kind = mode & Int(S_IFMT)
      guard flags & ~0x080e == 0, [0, 8].contains(method), extra == 0, try number(offset + 34, 2) == 0,
            offset + 46 + nameLength + comment <= end,
            let name = String(data: bytes[(offset + 46)..<(offset + 46 + nameLength)], encoding: .utf8),
            !name.contains("\\"), !name.unicodeScalars.contains(where: { $0.value < 32 }), name.hasPrefix("Web Recall.app/"),
            name.split(separator: "/", omittingEmptySubsequences: false).dropLast(name.hasSuffix("/") ? 1 : 0).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
            [0, Int(S_IFREG), Int(S_IFDIR)].contains(kind), (kind != Int(S_IFDIR) || name.hasSuffix("/")), mode & 0o022 == 0 else { throw UpdateError.unsafeArchive }
      let normalized = name.trimmingCharacters(in: CharacterSet(charactersIn: "/")).precomposedStringWithCanonicalMapping.lowercased()
      guard names.insert(normalized).inserted else { throw UpdateError.unsafeArchive }
      paths.append(normalized); if !name.hasSuffix("/") { files.insert(normalized) }
      expanded += uncompressed
      guard expanded <= UpdatePolicy.expandedLimit, local < start, try number(local, 4) == 0x04034b50,
            try number(local + 6, 2) == flags, try number(local + 8, 2) == method,
            try number(local + 26, 2) == nameLength, try number(local + 28, 2) == 0,
            local + 30 + nameLength + compressed <= start,
            bytes[(local + 30)..<(local + 30 + nameLength)] == bytes[(offset + 46)..<(offset + 46 + nameLength)] else { throw UpdateError.unsafeArchive }
      offset += 46 + nameLength + comment
    }
    guard offset == end, paths.allSatisfy({ path in
      let parts = path.split(separator: "/")
      return (1..<parts.count).allSatisfy { !files.contains(parts.prefix($0).joined(separator: "/")) }
    }) else { throw UpdateError.unsafeArchive }
  }

  public static func extract(_ archive: URL, into directory: URL) throws -> URL {
    try validate(archive)
    try UpdateFiles.createPrivateDirectory(directory)
    try UpdateFiles.run("/usr/bin/ditto", ["-x", "-k", archive.path, directory.path])
    return directory.appendingPathComponent("Web Recall.app", isDirectory: true)
  }
}
