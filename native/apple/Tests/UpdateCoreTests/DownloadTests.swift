import Foundation
import Testing
@testable import UpdateCore

final class ReleaseResponse: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url else { return }
    let status = url.lastPathComponent == "missing" ? 404 : 200
    let headers = url.lastPathComponent == "declared-large" ? ["Content-Length": "1000000"] : [:]
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("hello".utf8))
    if url.lastPathComponent == "chunked-large" { client?.urlProtocol(self, didLoad: Data(" world".utf8)) }
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@Test func downloadsAcceptExactBoundedBytesButRejectHTTPFailuresAndBothDeclaredAndStreamedOverflows() async throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ReleaseResponse.self]
  let destination = root.appendingPathComponent("download")
  try await Download(source: URL(string: "https://fixture.test/valid")!, limit: 5).run(to: destination, configuration: configuration)
  #expect(try Data(contentsOf: destination) == Data("hello".utf8))
  for scenario in ["missing", "declared-large", "chunked-large"] {
    await #expect(throws: (any Error).self) {
      try await Download(source: URL(string: "https://fixture.test/\(scenario)")!, limit: 5).run(to: destination, configuration: configuration)
    }
    #expect(try Data(contentsOf: destination).count <= 5)
  }
}

@Test func cancellationBeforeDownloadStartSettlesWithoutLeavingAWaitingContinuation() async throws {
  let root = try temporaryUpdateDirectory(); defer { try? FileManager.default.removeItem(at: root) }
  let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ReleaseResponse.self]
  let download = Download(source: URL(string: "https://fixture.test/valid")!, limit: 5)
  download.cancel()
  await #expect(throws: CancellationError.self) { try await download.run(to: root.appendingPathComponent("download"), configuration: configuration) }
}
