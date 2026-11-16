import AppKit
import CryptoKit
import Darwin
import Foundation
import UpdateCore

@main struct WebRecallUpdater {
  @MainActor static func main() async {
    do {
      let arguments = Array(CommandLine.arguments.dropFirst())
      switch arguments.first {
      case "keygen":
        guard arguments.count == 2 else { throw UpdateError.installation("Usage: WebRecallUpdater keygen PUBLIC_KEY_FILE") }
        let key = try UpdateSigningKey.load(create: true)
        let destination = URL(fileURLWithPath: arguments[1])
        let text = key.publicKey.rawRepresentation.base64EncodedString() + "\n"
        if FileManager.default.fileExists(atPath: destination.path) {
          guard try String(contentsOf: destination, encoding: .utf8) == text else { throw UpdateError.installation("Refusing to replace a different pinned public key.") }
        } else { try Data(text.utf8).write(to: destination, options: .withoutOverwriting) }
        print("Updater signing key is stored in macOS Keychain. Public key: \(destination.path)")
      case "sign":
        guard arguments.count == 4 else { throw UpdateError.installation("Usage: WebRecallUpdater sign ARCHIVE APP OUTPUT_JSON") }
        let key: Curve25519.Signing.PrivateKey
        if let encoded = ProcessInfo.processInfo.environment["APPLE_UPDATE_SIGNING_KEY"] {
          guard let raw = Data(base64Encoded: encoded), raw.count == 32 else { throw UpdateError.invalidSignature }
          key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        } else { key = try UpdateSigningKey.load() }
        try UpdateSigningKey.sign(archive: URL(fileURLWithPath: arguments[1]), app: URL(fileURLWithPath: arguments[2]), output: URL(fileURLWithPath: arguments[3]), key: key)
        print("Signed companion update metadata.")
      case "install":
        guard arguments.count == 3, let parent = Int32(arguments[2]), parent == getppid() else { throw UpdateError.unsafePath }
        try await install(directory: URL(fileURLWithPath: arguments[1]), parent: parent)
      default: throw UpdateError.installation("Use keygen, sign or install.")
      }
    } catch {
      FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8)); exit(1)
    }
  }

  @MainActor private static func install(directory: URL, parent: Int32) async throws {
    let transaction = try UpdateTransaction(directory: directory), plan = try transaction.load()
    let current = try UpdateBundle.inspect(transaction.destination)
    let original = current.version == plan.originalVersion ? transaction.destination : transaction.candidate
    let trusted = try UpdateBundle.inspect(original, version: plan.originalVersion, publicKey: current.publicKey)
    let helper = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    try UpdateFiles.check(helper, directory: false)
    let expected = original.appendingPathComponent("Contents/MacOS/WebRecallUpdater")
    guard try SHA256.hash(data: Data(contentsOf: helper)) == SHA256.hash(data: Data(contentsOf: expected)) else { throw UpdateError.unsafePath }
    try await transaction.perform(publicKey: trusted.publicKey, systemVersion: UpdatePolicy.systemVersion, verify: { app, version, key in
      _ = try UpdateBundle.inspect(app, version: version, publicKey: key, team: trusted.team)
    }, beforeReplacement: {
      try UpdateFiles.write(Data(plan.nonce.utf8), to: directory.appendingPathComponent("helper-ready"))
      let deadline = ContinuousClock.now.advanced(by: .seconds(30))
      while kill(parent, 0) == 0 {
        guard ContinuousClock.now < deadline else { throw UpdateError.installation("The companion did not quit. The installed app was not replaced.") }
        try await Task.sleep(for: .milliseconds(100))
      }
    }, ensureStopped: { app in
      guard !NSWorkspace.shared.runningApplications.contains(where: { !$0.isTerminated && $0.bundleURL?.resolvingSymlinksInPath().path == app.resolvingSymlinksInPath().path }) else { throw UpdateError.applicationStillRunning }
    }, launch: { app, _, job in try await launch(app: app, directory: job) })
    if try transaction.load().phase == "confirmed" { try? FileManager.default.removeItem(at: directory) }
  }

  @MainActor private static func launch(app: URL, directory: URL) async throws -> Bool {
    let transaction = try UpdateTransaction(directory: directory), plan = try transaction.load()
    let expected = try UpdateBundle.inspect(app)
    try? FileManager.default.removeItem(at: transaction.readyURL)
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--update-startup", directory.path, plan.nonce]
    let application = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
    let deadline = ContinuousClock.now.advanced(by: .seconds(30))
    while !application.isTerminated && ContinuousClock.now < deadline {
      if (try? UpdateStartup.read(from: transaction.readyURL, nonce: plan.nonce, version: expected.version, processID: application.processIdentifier)) == true { return true }
      try await Task.sleep(for: .milliseconds(100))
    }
    if !application.isTerminated {
      guard application.bundleURL?.resolvingSymlinksInPath().path == app.resolvingSymlinksInPath().path else { throw UpdateError.applicationStillRunning }
      application.terminate()
      let stopDeadline = ContinuousClock.now.advanced(by: .seconds(5))
      while !application.isTerminated && ContinuousClock.now < stopDeadline { try await Task.sleep(for: .milliseconds(100)) }
      if !application.isTerminated { application.forceTerminate() }
      let forceDeadline = ContinuousClock.now.advanced(by: .seconds(5))
      while !application.isTerminated && ContinuousClock.now < forceDeadline { try await Task.sleep(for: .milliseconds(50)) }
      guard application.isTerminated else { throw UpdateError.applicationStillRunning }
    }
    return false
  }
}
