import AppKit
import AppleInference
import Combine
import CompanionCore
import Darwin
import Foundation
import NativeProtocol
import ServiceManagement
import SwiftUI
import UpdateCore

@MainActor final class LoginPreference: ObservableObject {
  @Published private(set) var enabled = SMAppService.mainApp.status == .enabled
  @Published private(set) var message = ""

  func setEnabled(_ value: Bool) {
    do {
      if value { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
      enabled = SMAppService.mainApp.status == .enabled
      message = SMAppService.mainApp.status == .requiresApproval ? "Approve Web Recall in System Settings → General → Login Items." : ""
    } catch {
      enabled = SMAppService.mainApp.status == .enabled
      message = "Could not update launch at login. Install the app in Applications and check Login Items in System Settings."
    }
  }
}

@MainActor struct Dashboard: View {
  @ObservedObject var controller: CompanionController
  @ObservedObject var login: LoginPreference
  @ObservedObject var updater: CompanionUpdater
  @Environment(\.colorScheme) private var colorScheme
  let refresh: () -> Void
  let quit: () -> Void

  private var dark: Bool { colorScheme == .dark }
  private var ink: Color { color(dark ? 0xeeeaf4 : 0x242429) }
  private var muted: Color { color(dark ? 0xb3adbf : 0x6f6878) }
  private var accent: Color { color(dark ? 0xb9a0eb : 0x7354b1) }
  private var line: Color { color(dark ? 0x37323e : 0xe5e5e9) }
  private func color(_ value: UInt32) -> Color {
    Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack(alignment: .firstTextBaseline) {
          Text("Apple Intelligence").font(.system(size: 17, weight: .semibold))
          Spacer()
          Text(controller.statusText).font(.system(size: 12)).foregroundStyle(muted).accessibilityIdentifier("companion-status")
        }
        HStack(spacing: 6) {
          Text(controller.modelStatus?.modelName ?? "On-device")
          if let size = controller.modelStatus?.contextTokens { Text("·"); Text("\(size.formatted()) tokens") }
        }.font(.system(size: 12)).foregroundStyle(muted).padding(.top, -10)
        HStack(spacing: 8) {
          Button(controller.paused ? "Resume" : "Pause") { controller.setPaused(!controller.paused) }
            .accessibilityLabel(controller.paused ? "Resume native inference" : "Pause native inference")
            .accessibilityIdentifier("pause-native")
          Button("Refresh model status", action: refresh).buttonStyle(.bordered)
          if !controller.active.isEmpty {
            Button("Stop", role: .destructive) { controller.stopAll() }.accessibilityIdentifier("stop-all")
          }
        }.controlSize(.small)
        if let error = controller.modelError {
          Text(error).font(.system(size: 12)).foregroundStyle(muted)
        }
        Rectangle().fill(line).frame(height: 1)
        if !controller.active.isEmpty || !controller.history.isEmpty {
          DisclosureGroup("Recent activity") {
            VStack(spacing: 10) {
              ForEach(controller.active + Array(controller.history.prefix(5))) { operation in
              HStack {
                Text(operation.action == "status" ? "Model check" : "Answer")
                if operation.mode == "private-cloud" { Text("PCC").foregroundStyle(muted) }
                Spacer()
                Text(operation.outcome).foregroundStyle(muted)
                if let end = operation.finishedAt {
                  Text("\(max(0, end.timeIntervalSince(operation.startedAt)), specifier: "%.1f") s").foregroundStyle(muted).monospacedDigit()
                }
              }
              }
            }.padding(.top, 10)
          }
        }
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("App version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development")
            LabeledContent("macOS", value: ProcessInfo.processInfo.operatingSystemVersionString)
            if let date = controller.lastConnectedAt {
              LabeledContent("Last connected", value: date.formatted(date: .omitted, time: .shortened))
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Button(updater.actionTitle) { updater.action() }.buttonStyle(.bordered).controlSize(.small).disabled(updater.busy)
              Text(updater.state == .checking ? "Checking…" : updater.message.isEmpty ? " " : updater.message)
                .font(.system(size: 11)).frame(maxWidth: .infinity, minHeight: 14, alignment: .leading)
            }
            if updater.cancellable { Button("Cancel update") { updater.cancel() }.buttonStyle(.link) }
            Toggle("Automatic updates", isOn: Binding(get: { updater.automatic }, set: updater.setAutomatic))
        }.foregroundStyle(muted)
        Rectangle().fill(line).frame(height: 1)
        HStack {
          Toggle("Launch at login", isOn: Binding(get: { login.enabled }, set: login.setEnabled))
            .toggleStyle(.checkbox).accessibilityIdentifier("launch-at-login")
          Spacer()
          Button("Quit", action: quit).buttonStyle(.plain).foregroundStyle(muted).accessibilityIdentifier("quit-companion")
        }
        if !login.message.isEmpty {
          Text(login.message).foregroundStyle(muted)
          Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }.buttonStyle(.link)
        }
      }.font(.system(size: 12)).foregroundStyle(ink).padding(20)
    }.frame(minWidth: 360, minHeight: 240).background(color(dark ? 0x18181c : 0xfbfbfa)).tint(accent)
  }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  let controller = CompanionController { request, writer, tools in try await AppleModel.run(request, writer: writer, tools: tools) }
  let login = LoginPreference()
  private var server: CompanionServer?
  private var statusItem: NSStatusItem?
  private var dashboard: NSWindow?
  private var changes: AnyCancellable?
  private var menuIcon: NSImage?
  private lazy var updater = CompanionUpdater(controller: controller, quit: { [weak self] in self?.quit() })

  func applicationDidFinishLaunching(_ notification: Notification) {
    signal(SIGPIPE, SIG_IGN)
    do {
      guard CompanionLocation.bundle != nil else { throw CompanionError.unavailable }
      let server = CompanionServer(directory: CompanionLocation.directory, expectedExecutable: CompanionLocation.bridge, controller: controller)
      try server.start(); self.server = server
    } catch {
      let alert = NSAlert()
      alert.messageText = "Web Recall could not start"
      alert.informativeText = String(describing: error)
      alert.runModal(); NSApp.terminate(nil); return
    }
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let resource = Bundle.main.url(forResource: "MenuIcon", withExtension: "png") {
      menuIcon = NSImage(contentsOf: resource)
      menuIcon?.size = NSSize(width: 18, height: 18)
      menuIcon?.isTemplate = true
    }
    changes = controller.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.updateMenu() } }
    if let index = CommandLine.arguments.firstIndex(of: "--update-startup"), CommandLine.arguments.count == index + 3 {
      do {
        let directory = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        if let failedVersion = try UpdateStartup.confirm(directory: directory, nonce: CommandLine.arguments[index + 2], app: Bundle.main.bundleURL.resolvingSymlinksInPath()) {
          UserDefaults.standard.set(failedVersion, forKey: "failedCompanionUpdate")
        }
        updater.start()
      } catch { quit(); return }
    } else { updater.recoverIfNeeded() }
    updateMenu(); refreshAvailability()
    if CommandLine.arguments.contains("--dashboard") { openDashboard() }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openDashboard(); return true }
  func applicationWillTerminate(_ notification: Notification) { controller.quit(); server?.stop() }

  private func updateMenu() {
    guard let statusItem else { return }
    statusItem.button?.image = menuIcon
    statusItem.button?.toolTip = "Web Recall — \(controller.statusText)"
    let menu = NSMenu()
    menu.autoenablesItems = false
    let status = menu.addItem(withTitle: controller.statusText, action: nil, keyEquivalent: "")
    status.isEnabled = false
    add(menu, "Open dashboard", #selector(openDashboard), "d")
    menu.addItem(.separator())
    add(menu, controller.paused ? "Resume native inference" : "Pause native inference", #selector(togglePause), "")
    let stop = add(menu, "Stop active work", #selector(stopWork), ".")
    stop.isEnabled = !controller.active.isEmpty
    menu.addItem(.separator())
    add(menu, "Quit Web Recall", #selector(quit), "q")
    statusItem.menu = menu
  }

  @discardableResult private func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
    let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key); item.target = self; return item
  }

  @objc private func togglePause() { controller.setPaused(!controller.paused) }
  @objc private func stopWork() { controller.stopAll() }
  @objc private func quit() { controller.quit(); server?.stop(); NSApp.terminate(nil) }
  @objc private func openDashboard() {
    if dashboard == nil {
      let view = Dashboard(controller: controller, login: login, updater: updater, refresh: { [weak self] in self?.refreshAvailability() }, quit: { [weak self] in self?.quit() })
      let window = NSWindow(contentViewController: NSHostingController(rootView: view))
      window.title = "Web Recall"
      window.setContentSize(NSSize(width: 400, height: 360))
      window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      window.isReleasedWhenClosed = false
      window.center(); dashboard = window
    }
    dashboard?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
  }

  private func refreshAvailability() {
    Task {
      do {
        let result = try await AppleModel.run(HostRequest(id: "dashboard-availability", action: "status", mode: "on-device"), writer: NativeWriter(sendEvent: { _ in }))
        controller.setModelStatus(result.status)
      } catch { controller.setModelStatus(nil, error: "Check Apple Intelligence in System Settings.") }
    }
  }
}

@main struct WebRecallCompanion {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
    withExtendedLifetime(delegate) { }
  }
}
