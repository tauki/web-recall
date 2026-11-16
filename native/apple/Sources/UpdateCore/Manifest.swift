import CryptoKit
import Foundation

public enum UpdateError: Error, LocalizedError {
  case unconfigured, invalidSignature, invalidManifest, incompatible, unsafePath, unsafeArchive, invalidBundle, applicationStillRunning
  case download(String), installation(String)
  public var errorDescription: String? {
    switch self {
    case .unconfigured: "This build has no trusted update-signing key. Install an updater-enabled release manually."
    case .invalidSignature: "Update signature verification failed. Nothing was installed."
    case .invalidManifest: "The release has invalid update metadata. Nothing was installed."
    case .incompatible: "This release is not a newer compatible companion for this Mac."
    case .unsafePath: "Update files or installation paths failed their ownership and safety checks."
    case .unsafeArchive: "The update archive contains unsupported or unsafe entries."
    case .invalidBundle: "The downloaded app failed its identity or code-signature checks."
    case .applicationStillRunning: "The failed app could not be stopped safely. The previous app is retained for recovery; quit Web Recall before retrying."
    case .download(let reason), .installation(let reason): reason
    }
  }
}

public enum UpdatePolicy {
  public static let bundleIdentifier = "com.webrecall.companion"
  public static let archiveLimit = 128 * 1024 * 1024
  public static let expandedLimit = 512 * 1024 * 1024
  public static let metadataLimit = 256 * 1024
  public static let releaseAPI = URL(string: "https://api.github.com/repos/tauki/web-recall/releases/latest")!
  public static var systemVersion: String {
    let system = ProcessInfo.processInfo.operatingSystemVersion
    return "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)"
  }
  public static func asset(version: String, name: String) -> URL {
    URL(string: "https://github.com/tauki/web-recall/releases/download/v\(version)/\(name)")!
  }
  public static func archiveName(version: String) -> String { "web-recall-companion-\(version).zip" }
}

public struct ReleaseVersion: Comparable, Sendable {
  private let parts: [Int]
  public init(_ value: String) throws {
    let components = value.split(separator: ".", omittingEmptySubsequences: false)
    guard components.count == 3 else { throw UpdateError.invalidManifest }
    parts = try components.map { component in
      guard !component.isEmpty, component.allSatisfy({ $0.isASCII && $0.isNumber }), component.count == 1 || component.first != "0", let number = Int(component) else { throw UpdateError.invalidManifest }
      return number
    }
  }
  public static func < (first: Self, second: Self) -> Bool { first.parts.lexicographicallyPrecedes(second.parts) }
}

public struct SignedUpdate: Codable, Sendable {
  public let schemaVersion: Int
  public let version: String
  public let bundleIdentifier: String
  public let minimumSystemVersion: String
  public let architecture: String
  public let size: Int
  public let sha256: String
  public var archiveURL: URL { UpdatePolicy.asset(version: version, name: UpdatePolicy.archiveName(version: version)) }

  public static func verify(_ data: Data, publicKey: Data, installedVersion: String, systemVersion: String) throws -> Self {
    struct Envelope: Decodable { let payload: String; let signature: String }
    guard data.count <= UpdatePolicy.metadataLimit, publicKey.count == 32 else { throw UpdateError.invalidSignature }
    let envelope = try JSONDecoder().decode(Envelope.self, from: data)
    guard let payload = Data(base64Encoded: envelope.payload), payload.count <= 16 * 1024, let signature = Data(base64Encoded: envelope.signature), signature.count == 64,
          try Curve25519.Signing.PublicKey(rawRepresentation: publicKey).isValidSignature(signature, for: payload) else { throw UpdateError.invalidSignature }
    let update = try JSONDecoder().decode(Self.self, from: payload)
    guard update.schemaVersion == 1, update.bundleIdentifier == UpdatePolicy.bundleIdentifier, update.size > 0, update.size <= UpdatePolicy.archiveLimit,
          update.sha256.count == 64, update.sha256.allSatisfy({ $0.isASCII && ("0123456789abcdef".contains($0)) }) else { throw UpdateError.invalidManifest }
    guard update.architecture == "arm64", try ReleaseVersion(update.version) > ReleaseVersion(installedVersion), try ReleaseVersion(update.minimumSystemVersion) <= ReleaseVersion(systemVersion) else { throw UpdateError.incompatible }
    return update
  }

  public func verifyArchive(_ file: URL) throws {
    try UpdateFiles.check(file, directory: false)
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? NSNumber)?.intValue == size else { throw UpdateError.invalidSignature }
    let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
    guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw UpdateError.invalidSignature }
  }
}

public struct GitHubRelease: Sendable {
  public let version: String
  public let metadataURL: URL
  public static func decode(_ data: Data) throws -> Self {
    struct Asset: Decodable { let name: String; let browser_download_url: String }
    struct Release: Decodable { let tag_name: String; let draft: Bool; let prerelease: Bool; let assets: [Asset] }
    guard data.count <= UpdatePolicy.metadataLimit else { throw UpdateError.invalidManifest }
    let release = try JSONDecoder().decode(Release.self, from: data)
    guard !release.draft, !release.prerelease, release.tag_name.first == "v" else { throw UpdateError.incompatible }
    let version = String(release.tag_name.dropFirst())
    _ = try ReleaseVersion(version)
    let name = "web-recall-companion-update.json"
    let url = UpdatePolicy.asset(version: version, name: name)
    guard release.assets.filter({ $0.name == name && $0.browser_download_url == url.absoluteString }).count == 1 else { throw UpdateError.invalidManifest }
    return Self(version: version, metadataURL: url)
  }
}
