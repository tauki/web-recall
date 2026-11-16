import CryptoKit
import Foundation
import Testing
@testable import UpdateCore

let signingFixture = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x11, count: 32))

func manifestFixture(overrides: [String: Any] = [:], key: Curve25519.Signing.PrivateKey = signingFixture) throws -> Data {
  var payload: [String: Any] = ["schemaVersion": 1, "version": "0.2.4", "bundleIdentifier": "com.webrecall.companion", "minimumSystemVersion": "26.4.0", "architecture": "arm64", "size": 123, "sha256": String(repeating: "a", count: 64)]
  payload.merge(overrides) { _, replacement in replacement }
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
  return try JSONSerialization.data(withJSONObject: ["payload": data.base64EncodedString(), "signature": try key.signature(for: data).base64EncodedString()])
}

@Test func onlyThePinnedKeyCanAuthorizeAnUpdateAndAllMetadataIsCoveredByTheSignature() throws {
  let key = signingFixture.publicKey.rawRepresentation
  let manifest = try SignedUpdate.verify(manifestFixture(), publicKey: key, installedVersion: "0.2.3", systemVersion: "27.0.0")
  #expect(manifest.version == "0.2.4")
  let wrongKey = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x22, count: 32))
  #expect(throws: UpdateError.self) { try SignedUpdate.verify(manifestFixture(key: wrongKey), publicKey: key, installedVersion: "0.2.3", systemVersion: "27.0.0") }
  var envelope = try #require(JSONSerialization.jsonObject(with: manifestFixture()) as? [String: String])
  let original = try #require(Data(base64Encoded: envelope["payload"]!))
  envelope["payload"] = Data(String(decoding: original, as: UTF8.self).replacingOccurrences(of: "0.2.4", with: "9.0.0").utf8).base64EncodedString()
  #expect(throws: UpdateError.self) { try SignedUpdate.verify(JSONSerialization.data(withJSONObject: envelope), publicKey: key, installedVersion: "0.2.3", systemVersion: "27.0.0") }
}

@Test func signedButIncompatibleOrDowngradeReleasesAreRejected() throws {
  for fields: [String: Any] in [["schemaVersion": 2], ["version": "0.2.3"], ["version": "0.2.2"], ["version": "0.3.0-beta"], ["minimumSystemVersion": "99.0.0"], ["architecture": "x86_64"], ["bundleIdentifier": "com.unrelated.app"], ["size": 0], ["size": Int.max], ["sha256": "invalid"]] {
    #expect(throws: UpdateError.self) { try SignedUpdate.verify(manifestFixture(overrides: fields), publicKey: signingFixture.publicKey.rawRepresentation, installedVersion: "0.2.3", systemVersion: "27.0.0") }
  }
}

@Test func releaseDiscoveryIsRestrictedToStableAssetsInTheConfiguredRepository() throws {
  let valid: [String: Any] = ["tag_name": "v0.2.4", "draft": false, "prerelease": false, "assets": [["name": "web-recall-companion-update.json", "browser_download_url": "https://github.com/tauki/web-recall/releases/download/v0.2.4/web-recall-companion-update.json"]]]
  let release = try GitHubRelease.decode(JSONSerialization.data(withJSONObject: valid))
  #expect(release.version == "0.2.4")
  for (key, value): (String, Any) in [("draft", true), ("prerelease", true), ("tag_name", "v0.2.4-beta"), ("assets", [["name": "web-recall-companion-update.json", "browser_download_url": "https://attacker.test/update.json"]])] {
    var changed = valid; changed[key] = value
    #expect(throws: UpdateError.self) { try GitHubRelease.decode(JSONSerialization.data(withJSONObject: changed)) }
  }
}
