import Foundation

public enum UpdateRedirects {
  public static func allowsSource(_ url: URL) -> Bool {
    if url == UpdatePolicy.releaseAPI { return true }
    guard url.scheme == "https", url.host == "github.com", url.user == nil, url.password == nil,
          url.port == nil, url.query == nil, url.fragment == nil else { return false }
    let components = url.path.split(separator: "/").map(String.init)
    guard components.count == 6, Array(components.prefix(4)) == ["tauki", "web-recall", "releases", "download"], components[4].first == "v" else { return false }
    let version = String(components[4].dropFirst())
    guard (try? ReleaseVersion(version)) != nil else { return false }
    return ["web-recall-companion-update.json", UpdatePolicy.archiveName(version: version)].contains(components[5])
  }

  public static func allows(_ url: URL, from initial: URL) -> Bool {
    guard allowsSource(initial), url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443, url.fragment == nil else { return false }
    if initial == UpdatePolicy.releaseAPI { return url == initial }
    return url == initial || ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "")
  }
}

final class Download: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private let source: URL
  private let limit: Int
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var continuation: CheckedContinuation<Void, Error>?
  private var output: FileHandle?
  private var count = 0
  private var cancelled = false
  private var failure: Error?

  init(source: URL, limit: Int) { self.source = source; self.limit = limit }

  func run(to destination: URL, configuration: URLSessionConfiguration = .ephemeral) async throws {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        lock.withLock {
          self.continuation = continuation
          do {
            try UpdateFiles.write(Data(), to: destination)
            output = try FileHandle(forWritingTo: destination)
            configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
            configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 600
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            var request = URLRequest(url: source)
            request.setValue("WebRecall-Companion-Updater", forHTTPHeaderField: "User-Agent")
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            task = session.dataTask(with: request)
            if cancelled { task?.cancel() }
            task?.resume()
          } catch { self.continuation = nil; continuation.resume(throwing: error) }
        }
      }
    } onCancel: { self.cancel() }
  }

  func cancel() { lock.withLock { cancelled = true; task?.cancel() } }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    guard let url = request.url, UpdateRedirects.allows(url, from: source) else {
      lock.withLock { failure = UpdateError.download("The update redirected outside GitHub's release servers.") }
      completionHandler(nil); return
    }
    completionHandler(request)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
          response.expectedContentLength <= Int64(limit) else {
      lock.withLock { failure = UpdateError.download("The release download failed or exceeded its allowed size.") }
      completionHandler(.cancel); return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.withLock {
      count += data.count
      do {
        guard count <= limit else { throw UpdateError.download("The release download exceeded its allowed size.") }
        try output?.write(contentsOf: data)
      } catch { failure = error; dataTask.cancel() }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.withLock {
      defer { output = nil; continuation = nil; self.task = nil; self.session = nil; session.finishTasksAndInvalidate() }
      do {
        if cancelled { throw CancellationError() }
        if let failure { throw failure }
        if let error { throw error }
        try output?.synchronize(); try output?.close()
        continuation?.resume()
      } catch { try? output?.close(); continuation?.resume(throwing: error) }
    }
  }
}

public struct AvailableUpdate: Sendable {
  public let manifest: SignedUpdate
  public let envelope: Data
}

public enum ReleaseClient {
  public static func check(publicKey: Data, installedVersion: String, systemVersion: String) async throws -> AvailableUpdate? {
    let directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("web-recall-check-\(UUID().uuidString)")
    try UpdateFiles.createPrivateDirectory(directory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let releaseFile = directory.appendingPathComponent("release.json")
    try await download(UpdatePolicy.releaseAPI, to: releaseFile, limit: UpdatePolicy.metadataLimit)
    let data = try Data(contentsOf: releaseFile)
    struct Version: Decodable { let tag_name: String }
    let tag = try JSONDecoder().decode(Version.self, from: data).tag_name
    guard tag.first == "v" else { throw UpdateError.invalidManifest }
    if try ReleaseVersion(String(tag.dropFirst())) <= ReleaseVersion(installedVersion) { return nil }
    let release = try GitHubRelease.decode(data)
    let metadataFile = directory.appendingPathComponent("update.json")
    try await download(release.metadataURL, to: metadataFile, limit: UpdatePolicy.metadataLimit)
    let envelope = try Data(contentsOf: metadataFile)
    let manifest = try SignedUpdate.verify(envelope, publicKey: publicKey, installedVersion: installedVersion, systemVersion: systemVersion)
    guard manifest.version == release.version else { throw UpdateError.invalidManifest }
    return AvailableUpdate(manifest: manifest, envelope: envelope)
  }

  public static func download(_ url: URL, to destination: URL, limit: Int) async throws {
    guard UpdateRedirects.allowsSource(url), limit > 0, limit <= UpdatePolicy.archiveLimit else { throw UpdateError.invalidManifest }
    try Task.checkCancellation()
    try await Download(source: url, limit: limit).run(to: destination)
  }
}
