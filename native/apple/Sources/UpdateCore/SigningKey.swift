import CryptoKit
import Foundation
import Security

public enum UpdateSigningKey {
  public static let service = "com.webrecall.companion.update-signing"
  public static let account = "ed25519"

  public static func load(create: Bool = false) throws -> Curve25519.Signing.PrivateKey {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let encoded = result as? Data, let raw = Data(base64Encoded: encoded) { return try Curve25519.Signing.PrivateKey(rawRepresentation: raw) }
    guard status == errSecItemNotFound, create else { throw UpdateError.installation("The updater signing key is unavailable in macOS Keychain (\(status)).") }
    let key = Curve25519.Signing.PrivateKey()
    let attributes: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecValueData as String: key.rawRepresentation.base64EncodedData(), kSecAttrLabel as String: "Web Recall updater signing key"]
    guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else { throw UpdateError.installation("Could not store the dedicated updater key in macOS Keychain.") }
    return key
  }

  public static func sign(archive: URL, app: URL, output: URL, key: Curve25519.Signing.PrivateKey) throws {
    let bundle = try UpdateBundle.inspect(app, publicKey: key.publicKey.rawRepresentation)
    try UpdateArchive.validate(archive)
    let data = try Data(contentsOf: archive, options: .mappedIfSafe)
    guard data.count <= UpdatePolicy.archiveLimit else { throw UpdateError.unsafeArchive }
    let payload: [String: Any] = ["schemaVersion": 1, "version": bundle.version, "bundleIdentifier": UpdatePolicy.bundleIdentifier, "minimumSystemVersion": bundle.minimumSystemVersion, "architecture": "arm64", "size": data.count, "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()]
    let bytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let envelope = try JSONSerialization.data(withJSONObject: ["payload": bytes.base64EncodedString(), "signature": try key.signature(for: bytes).base64EncodedString()], options: [.sortedKeys])
    try envelope.write(to: output, options: .atomic)
  }
}
