import CompanionCore
import Darwin
import Foundation
import NativeProtocol

@main struct WebRecallApple {
  static func main() {
    signal(SIGPIPE, SIG_IGN)
    let writer = NativeWriter()
    var requestId = "native-connection"
    do {
      guard let first = try NativeFraming.read(from: .standardInput) else { return }
      let request = try JSONDecoder().decode(HostRequest.self, from: first)
      requestId = request.id
      try request.validate()
      guard CompanionLocation.bundle != nil else { throw CompanionError.unavailable }
      let connection = try LocalConnection.connect(directory: CompanionLocation.directory, expectedExecutable: CompanionLocation.app)
      defer { connection.close() }
      try connection.send(first)
      DispatchQueue.global().async {
        do {
          while let body = try NativeFraming.read(from: .standardInput) { try connection.send(body) }
        } catch { }
        connection.close()
      }
      while let body = try connection.read() {
        try FileHandle.standardOutput.write(contentsOf: NativeFraming.encode(body))
      }
    } catch { try? writer.send(HostEvent(id: requestId, type: "error", text: String(describing: error))) }
  }
}
