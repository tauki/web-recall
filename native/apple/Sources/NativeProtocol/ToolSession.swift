import Foundation

public enum ToolSessionError: Error, CustomStringConvertible {
  case allowanceExceeded, contextNeedsCompaction, noProgress
  public var description: String {
    switch self {
    case .allowanceExceeded: "The saved-memory tool-call allowance is exhausted."
    case .contextNeedsCompaction: "The research context needs compaction."
    case .noProgress: "The model repeated an already-read lookup without finding new evidence. Try a more focused question or another model."
    }
  }
}

public actor ToolSession {
  private let requestId: String
  private let writer: NativeWriter
  private let limit: Int
  private var pending: [String: CheckedContinuation<String, Error>] = [:]
  private var observations: [String] = []
  private var contextCheck: (@Sendable (String) async throws -> Bool)?
  private var closed = false
  public private(set) var calls = 0
  public private(set) var allowanceExceeded = false
  public private(set) var needsCompaction = false
  public private(set) var progress = 0

  public init(requestId: String, writer: NativeWriter, limit: Int) { self.requestId = requestId; self.writer = writer; self.limit = max(0, min(100, limit)) }

  public func setContextCheck(_ check: @escaping @Sendable (String) async throws -> Bool) { contextCheck = check; needsCompaction = false }
  public func clearContextCheck() { contextCheck = nil }
  public func takeObservations() -> [String] { let result = observations; observations = []; return result }

  public func call(name: String, arguments: String) async throws -> String {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    guard calls < limit else { allowanceExceeded = true; throw ToolSessionError.allowanceExceeded }
    calls += 1
    let callId = UUID().uuidString
    let result: String = try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
        pending[callId] = continuation
        do { try writer.send(HostEvent(id: requestId, type: "tool_call", toolCall: ToolInvocation(callId: callId, name: name, arguments: arguments))) }
        catch { pending.removeValue(forKey: callId)?.resume(throwing: error) }
      }
    } onCancel: { Task { await self.cancel(callId) } }
    try Task.checkCancellation()
    observations.append("Tool \(name), arguments \(arguments)\n\(result)")
    let metadata = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any]
    if metadata?["newInformation"] as? Bool != false { progress += 1 }
    if let control = metadata?["control"] as? [String: Any], control["noProgress"] as? Bool == true { needsCompaction = true; throw ToolSessionError.noProgress }
    if let contextCheck, try await !contextCheck(result) { needsCompaction = true; throw ToolSessionError.contextNeedsCompaction }
    return result
  }

  public func resolve(callId: String, result: String) { pending.removeValue(forKey: callId)?.resume(returning: result) }
  public func close() {
    closed = true; contextCheck = nil
    let waiting = pending.values; pending.removeAll()
    for continuation in waiting { continuation.resume(throwing: CancellationError()) }
    observations = []
  }
  private func cancel(_ callId: String) { pending.removeValue(forKey: callId)?.resume(throwing: CancellationError()) }
}
