import Combine
import CompanionCore
import CryptoKit
import Darwin
import Foundation
import UpdateCore

@MainActor final class CompanionUpdater: ObservableObject {
  enum State { case idle, checking, available, preparing, waiting, installing }
  @Published private(set) var state: State = .idle
  @Published private(set) var message = ""
  @Published private(set) var automatic = UserDefaults.standard.bool(forKey: "automaticCompanionUpdates")
  private var available: AvailableUpdate?
  private var operation: Task<Void, Never>?
  private var scheduled: Task<Void, Never>?
  private let controller: CompanionController
  private let quit: () -> Void
  private let app = Bundle.main.bundleURL.resolvingSymlinksInPath()

  init(controller: CompanionController, quit: @escaping () -> Void) { self.controller = controller; self.quit = quit }

  var busy: Bool { operation != nil }
  var cancellable: Bool { [.preparing, .waiting].contains(state) }
  var actionTitle: String {
    switch state {
    case .idle, .checking: "Check for updates"
    case .available: "Install \(available?.manifest.version ?? "update") & restart…"
    case .preparing: "Downloading update…"
    case .waiting: "Waiting for active work…"
    case .installing: "Installing update…"
    }
  }

  func start() {
    scheduled?.cancel()
    guard automatic else { return }
    scheduled = Task { [weak self] in
      while !Task.isCancelled {
        self?.check(installAutomatically: true)
        do { try await Task.sleep(for: .seconds(24 * 60 * 60)) } catch { return }
      }
    }
  }

  func setAutomatic(_ enabled: Bool) {
    automatic = enabled; UserDefaults.standard.set(enabled, forKey: "automaticCompanionUpdates"); start()
  }

  func action() { if state == .available { install() } else { check() } }

  func check(installAutomatically: Bool = false) {
    guard operation == nil else { return }
    state = .checking; message = ""
    operation = Task { [weak self] in
      guard let self else { return }
      defer { operation = nil }
      do {
        let bundle = try UpdateBundle.inspect(app)
        available = try await ReleaseClient.check(publicKey: bundle.publicKey, installedVersion: bundle.version, systemVersion: UpdatePolicy.systemVersion)
        try Task.checkCancellation()
        state = available == nil ? .idle : .available
        message = available == nil ? "Up to date" : "A signed companion update is available."
        if installAutomatically, automatic, let available, available.manifest.version != UserDefaults.standard.string(forKey: "failedCompanionUpdate") { try await install(available) }
      } catch { state = available == nil ? .idle : .available; message = error is CancellationError ? "Update cancelled." : error.localizedDescription }
    }
  }

  private func install() {
    guard operation == nil, let available else { return }
    operation = Task { [weak self] in
      guard let self else { return }
      defer { operation = nil }
      do { try await install(available) }
      catch { state = .available; message = error is CancellationError ? "Update cancelled." : error.localizedDescription }
    }
  }

  private func install(_ update: AvailableUpdate) async throws {
    var transaction: UpdateTransaction?
    defer { controller.setUpdating(false) }
    do {
      state = .preparing; message = "Downloading and verifying the signed release…"
      let prepared = try await UpdateTransaction.prepare(app: app, available: update)
      transaction = prepared
      try Task.checkCancellation()
      controller.setUpdating(true); state = .waiting; message = "Active work will finish before the companion restarts."
      while !controller.active.isEmpty { try await Task.sleep(for: .milliseconds(100)) }
      try Task.checkCancellation()
      try await handOff(prepared)
    } catch {
      if let transaction, state != .installing { try? FileManager.default.removeItem(at: transaction.directory) }
      throw error
    }
  }

  func cancel() { guard cancellable else { return }; operation?.cancel() }

  func recoverIfNeeded() {
    guard operation == nil, let jobs = try? FileManager.default.contentsOfDirectory(at: app.deletingLastPathComponent(), includingPropertiesForKeys: nil) else { return }
    for job in jobs where job.lastPathComponent.hasPrefix(".web-recall-update-") {
      guard let transaction = try? UpdateTransaction(directory: job), let plan = try? transaction.load() else { continue }
      if plan.phase == "rolledBack" {
        message = "A previous update failed and was rolled back."
        if let data = try? Data(contentsOf: job.appendingPathComponent("update.json")), let keyText = Bundle.main.object(forInfoDictionaryKey: "WebRecallUpdatePublicKey") as? String, let key = Data(base64Encoded: keyText), let update = try? SignedUpdate.verify(data, publicKey: key, installedVersion: plan.originalVersion, systemVersion: UpdatePolicy.systemVersion) {
          UserDefaults.standard.set(update.version, forKey: "failedCompanionUpdate")
        }
      }
      guard ["prepared", "replaced"].contains(plan.phase) else { continue }
      controller.setUpdating(true)
      operation = Task { [weak self] in
        guard let self else { return }
        defer { operation = nil; controller.setUpdating(false) }
        do { try await handOff(transaction) }
        catch { state = .idle; message = "Could not resume the interrupted update: \(error.localizedDescription)" }
      }
      return
    }
    start()
  }

  private func handOff(_ transaction: UpdateTransaction) async throws {
    let plan = try transaction.load()
    let current = try UpdateBundle.inspect(app)
    let original = current.version == plan.originalVersion ? app : transaction.candidate
    _ = try UpdateBundle.inspect(original, version: plan.originalVersion, publicKey: current.publicKey)
    let helper = transaction.directory.appendingPathComponent("WebRecallUpdater")
    try UpdateFiles.check(helper, directory: false)
    guard try SHA256.hash(data: Data(contentsOf: helper)) == SHA256.hash(data: Data(contentsOf: original.appendingPathComponent("Contents/MacOS/WebRecallUpdater"))) else { throw UpdateError.unsafePath }
    state = .installing; message = "Verifying the installer before restarting…"
    try? FileManager.default.removeItem(at: transaction.directory.appendingPathComponent("helper-ready"))
    let log = transaction.directory.appendingPathComponent("helper.log")
    try UpdateFiles.write(Data(), to: log)
    let output = try FileHandle(forWritingTo: log); defer { try? output.close() }
    let process = Process(); process.executableURL = helper
    process.arguments = ["install", transaction.directory.path, String(getpid())]
    process.standardOutput = output; process.standardError = output
    try process.run()
    let deadline = ContinuousClock.now.advanced(by: .seconds(15))
    while process.isRunning && ContinuousClock.now < deadline {
      if (try? String(contentsOf: transaction.directory.appendingPathComponent("helper-ready"), encoding: .utf8)) == plan.nonce { quit(); return }
      try await Task.sleep(for: .milliseconds(100))
    }
    if process.isRunning {
      process.terminate()
      let stopDeadline = ContinuousClock.now.advanced(by: .seconds(5))
      while process.isRunning && ContinuousClock.now < stopDeadline { try await Task.sleep(for: .milliseconds(100)) }
    }
    if !process.isRunning, plan.phase == "prepared", (try? UpdateBundle.inspect(transaction.destination, version: plan.originalVersion, publicKey: current.publicKey)) != nil {
      try? FileManager.default.removeItem(at: transaction.directory)
    }
    throw UpdateError.installation("The installer could not prepare the update. Web Recall has not been replaced.")
  }
}
