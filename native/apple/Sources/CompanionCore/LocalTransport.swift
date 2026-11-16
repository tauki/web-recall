import Darwin
import Foundation
import NativeProtocol
import Security

public enum CompanionError: Error, CustomStringConvertible {
  case unavailable, alreadyRunning, unsafeEndpoint, transport(String)
  public var description: String {
    switch self {
    case .unavailable: "Open the Web Recall companion app to use Apple inference. It is not running or its connection is unavailable."
    case .alreadyRunning: "The Web Recall companion is already running."
    case .unsafeEndpoint: "The companion connection failed its local ownership or executable identity check."
    case .transport(let reason): "Companion connection failed: \(reason)"
    }
  }
}

public enum CompanionLocation {
  public static var bundle: Bundle? {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    return Bundle(url: executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent())
  }
  public static var directory: URL {
    if let path = bundle?.object(forInfoDictionaryKey: "WebRecallStateDirectory") as? String { return URL(fileURLWithPath: path) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/WebRecall/Apple", isDirectory: true)
  }
  public static var bridge: URL { bundle!.bundleURL.appendingPathComponent("Contents/MacOS/web-recall-apple") }
  public static var app: URL { bundle!.bundleURL.appendingPathComponent("Contents/MacOS/WebRecallCompanion") }
}

private func socketAddress(_ path: String) throws -> sockaddr_un {
  var address = sockaddr_un()
  let bytes = Array(path.utf8) + [0]
  guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw CompanionError.transport("The local socket path is too long.") }
  address.sun_family = sa_family_t(AF_UNIX)
  address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
  return address
}

private func checkPeer(_ descriptor: Int32, executable: URL) throws {
  var user: uid_t = 0, group: gid_t = 0
  guard getpeereid(descriptor, &user, &group) == 0, user == geteuid() else { throw CompanionError.unsafeEndpoint }
  var pid: pid_t = 0
  var size = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0 else { throw CompanionError.unsafeEndpoint }
  var code: SecCode?
  var staticCode: SecStaticCode?
  var information: CFDictionary?
  guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary, [], &code) == errSecSuccess,
        let code, SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
        let staticCode, SecCodeCopySigningInformation(staticCode, [], &information) == errSecSuccess,
        let path = (information as? [String: Any])?[kSecCodeInfoMainExecutable as String] as? URL,
        path.resolvingSymlinksInPath() == executable.resolvingSymlinksInPath() else { throw CompanionError.unsafeEndpoint }
}

public final class LocalConnection: @unchecked Sendable {
  private let handle: FileHandle
  private let lock = NSLock()
  private var closed = false

  fileprivate init(_ descriptor: Int32) {
    handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var enabled: Int32 = 1
    _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
  }

  public static func connect(directory: URL, expectedExecutable: URL) throws -> LocalConnection {
    let file = directory.appendingPathComponent("companion.sock")
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & 0o077 == 0, info.st_mode & S_IFMT == S_IFDIR,
          lstat(file.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFSOCK else { throw CompanionError.unavailable }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw CompanionError.unavailable }
    let connection = LocalConnection(descriptor)
    do {
      var address = try socketAddress(file.path)
      let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      guard result == 0 else { throw CompanionError.unavailable }
      try checkPeer(descriptor, executable: expectedExecutable)
      return connection
    } catch { connection.close(); throw error }
  }

  public func read(maximumBytes: Int = NativeFraming.maximumResponseBytes) throws -> Data? { try NativeFraming.read(from: handle, maximumBytes: maximumBytes) }
  public func send(_ data: Data) throws { try writeFrame(NativeFraming.encode(data, maximumBytes: NativeFraming.maximumRequestBytes)) }
  public func writeFrame(_ frame: Data) throws {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { throw CompanionError.unavailable }
    try handle.write(contentsOf: frame)
  }
  public func close() {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return }; closed = true
    _ = shutdown(handle.fileDescriptor, SHUT_RDWR)
  }
}

public final class CompanionServer: @unchecked Sendable {
  private let directory: URL
  private let expectedExecutable: URL
  private let controller: CompanionController
  private let lock = NSLock()
  private var listener: Int32 = -1
  private var lease: Int32 = -1
  private var ownsSocket = false
  private var peers: [UUID: LocalConnection] = [:]

  public init(directory: URL, expectedExecutable: URL, controller: CompanionController) {
    self.directory = directory; self.expectedExecutable = expectedExecutable; self.controller = controller
  }

  public func start() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFDIR else { throw CompanionError.unsafeEndpoint }
    guard chmod(directory.path, 0o700) == 0 else { throw CompanionError.unsafeEndpoint }
    lease = open(directory.appendingPathComponent("companion.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lease >= 0 else { throw CompanionError.unsafeEndpoint }
    guard flock(lease, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(lease); lease = -1; throw CompanionError.alreadyRunning }
    do {
      let file = directory.appendingPathComponent("companion.sock")
      if lstat(file.path, &info) == 0 {
        guard info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFSOCK else { throw CompanionError.unsafeEndpoint }
        guard unlink(file.path) == 0 else { throw CompanionError.unsafeEndpoint }
      }
      listener = socket(AF_UNIX, SOCK_STREAM, 0)
      guard listener >= 0 else { throw CompanionError.unavailable }
      var address = try socketAddress(file.path)
      let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      ownsSocket = result == 0
      guard result == 0, chmod(file.path, 0o600) == 0, listen(listener, 8) == 0 else { throw CompanionError.unavailable }
      let descriptor = listener
      Task.detached { [self] in
        while true {
          let peer = accept(descriptor, nil, nil)
          if peer < 0 { return }
          do { try checkPeer(peer, executable: expectedExecutable) }
          catch { Darwin.close(peer); continue }
          let connection = LocalConnection(peer)
          let id = UUID()
          guard add(connection, id: id) else { connection.close(); return }
          Task.detached { [self] in
            await controller.connect(id)
            do {
              while let body = try connection.read(maximumBytes: NativeFraming.maximumRequestBytes) {
                let request = try JSONDecoder().decode(HostRequest.self, from: body)
                await controller.receive(request, client: id, writer: NativeWriter(writeFrame: { try connection.writeFrame($0) }))
              }
            } catch { }
            remove(id)
            connection.close()
            await controller.disconnect(id)
          }
        }
      }
    } catch { stop(); throw error }
  }

  private func add(_ connection: LocalConnection, id: UUID) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard listener >= 0 else { return false }
    peers[id] = connection; return true
  }
  private func remove(_ id: UUID) { lock.lock(); defer { lock.unlock() }; peers.removeValue(forKey: id) }

  public func stop() {
    lock.lock(); defer { lock.unlock() }
    if listener >= 0 { _ = shutdown(listener, SHUT_RDWR); Darwin.close(listener); listener = -1 }
    for connection in peers.values { connection.close() }
    peers.removeAll()
    if lease >= 0 {
      if ownsSocket { unlink(directory.appendingPathComponent("companion.sock").path); ownsSocket = false }
      Darwin.close(lease); lease = -1
    }
  }
}
