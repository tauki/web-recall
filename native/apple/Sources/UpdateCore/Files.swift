import CryptoKit
import Darwin
import Foundation
import Security

public enum UpdateFiles {
  public static func check(_ url: URL, directory: Bool, privateOnly: Bool = false) throws {
    var info = stat()
    guard url.standardizedFileURL == url.resolvingSymlinksInPath(), lstat(url.path, &info) == 0, info.st_uid == geteuid(),
          info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG), info.st_mode & 0o022 == 0,
          !privateOnly || info.st_mode & 0o077 == 0, directory || info.st_nlink == 1 else { throw UpdateError.unsafePath }
  }

  public static func createPrivateDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    try check(url, directory: true, privateOnly: true)
  }

  public static func write(_ data: Data, to url: URL) throws {
    try check(url.deletingLastPathComponent(), directory: true, privateOnly: true)
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".write-\(UUID().uuidString)")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw UpdateError.unsafePath }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
    try handle.write(contentsOf: data); try handle.synchronize()
    guard rename(temporary.path, url.path) == 0 else { throw UpdateError.installation("Could not save the update recovery record.") }
    try synchronizeDirectory(url.deletingLastPathComponent())
  }

  public static func synchronizeDirectory(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw UpdateError.unsafePath }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw UpdateError.installation("Could not synchronize the update directory.") }
  }

  public static func swap(_ first: URL, _ second: URL) throws {
    try check(first, directory: true); try check(second, directory: true)
    guard renamex_np(first.path, second.path, UInt32(RENAME_SWAP | RENAME_NOFOLLOW_ANY)) == 0 else { throw UpdateError.installation("The app could not be replaced safely. The original app is unchanged.") }
    try synchronizeDirectory(first.deletingLastPathComponent())
    try synchronizeDirectory(second.deletingLastPathComponent())
  }

  public static func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    guard process.terminationReason == .exit, process.terminationStatus == 0 else { throw UpdateError.installation("The system could not prepare or validate the app archive.") }
  }
}

public struct UpdateBundle: Sendable {
  public let version: String
  public let publicKey: Data
  public let team: String?
  public let minimumSystemVersion: String

  public static func inspect(_ url: URL, version: String? = nil, publicKey: Data? = nil, team: String? = nil) throws -> Self {
    try UpdateFiles.check(url, directory: true)
    let infoURL = url.appendingPathComponent("Contents/Info.plist")
    try UpdateFiles.check(infoURL, directory: false)
    guard let items = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isDirectoryKey]),
          let properties = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), format: nil) as? [String: Any],
          properties["CFBundleIdentifier"] as? String == UpdatePolicy.bundleIdentifier,
          properties["CFBundleExecutable"] as? String == "WebRecallCompanion",
          let foundVersion = properties["CFBundleShortVersionString"] as? String else { throw UpdateError.invalidBundle }
    guard let keyText = properties["WebRecallUpdatePublicKey"] as? String, let foundKey = Data(base64Encoded: keyText), foundKey.count == 32 else { throw UpdateError.unconfigured }
    _ = try ReleaseVersion(foundVersion)
    guard let minimum = properties["LSMinimumSystemVersion"] as? String else { throw UpdateError.invalidBundle }
    let minimumSystemVersion = minimum.split(separator: ".").count == 2 ? minimum + ".0" : minimum
    _ = try ReleaseVersion(minimumSystemVersion)
    var size = 0, count = 0
    for case let item as URL in items {
      let isDirectory = try item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
      try UpdateFiles.check(item, directory: isDirectory)
      count += 1
      if !isDirectory { size += (try FileManager.default.attributesOfItem(atPath: item.path)[.size] as? NSNumber)?.intValue ?? 0 }
      guard size <= UpdatePolicy.expandedLimit, count <= 4096 else { throw UpdateError.invalidBundle }
    }
    for name in ["WebRecallCompanion", "web-recall-apple", "WebRecallUpdater"] {
      let binary = url.appendingPathComponent("Contents/MacOS/\(name)")
      try UpdateFiles.check(binary, directory: false)
      guard FileManager.default.isExecutableFile(atPath: binary.path) else { throw UpdateError.invalidBundle }
    }
    var code: SecStaticCode?, info: CFDictionary?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode), nil) == errSecSuccess,
          SecCodeCopySigningInformation(code, [], &info) == errSecSuccess else { throw UpdateError.invalidBundle }
    let foundTeam = (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
    guard version == nil || version == foundVersion, publicKey == nil || publicKey == foundKey, team == nil || team == foundTeam else { throw UpdateError.invalidBundle }
    return Self(version: foundVersion, publicKey: foundKey, team: foundTeam, minimumSystemVersion: minimumSystemVersion)
  }
}
