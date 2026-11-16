import Combine
import Foundation
import NativeProtocol

public struct OperationSummary: Identifiable, Sendable {
  public let id: UUID
  public let action: String
  public let mode: String
  public let startedAt: Date
  public var finishedAt: Date?
  public var outcome: String
}

private final class RequestOutput: @unchecked Sendable {
  private let lock = NSLock()
  private var active = true
  private let destination: NativeWriter

  init(_ destination: NativeWriter) { self.destination = destination }

  func forward(_ event: HostEvent) throws {
    lock.lock(); defer { lock.unlock() }
    if active { try destination.send(event) }
  }

  func finish(_ event: HostEvent) {
    lock.lock(); defer { lock.unlock() }
    guard active else { return }
    active = false
    try? destination.send(event)
  }

}

@MainActor public final class CompanionController: ObservableObject {
  public typealias Worker = @MainActor (HostRequest, NativeWriter, ToolSession) async throws -> HostEvent
  @Published public private(set) var paused = false
  @Published public private(set) var quitting = false
  @Published public private(set) var updating = false
  @Published public private(set) var active: [OperationSummary] = []
  @Published public private(set) var history: [OperationSummary] = []
  @Published public private(set) var connections = 0
  @Published public private(set) var lastConnectedAt: Date?
  @Published public private(set) var modelStatus: HostStatus?
  @Published public private(set) var modelError: String?
  private let worker: Worker
  private var clients: Set<UUID> = []
  private struct Pending {
    let client: UUID
    let request: String
    let summary: OperationSummary
    let output: RequestOutput
    let task: Task<Void, Never>
    let tools: ToolSession
  }
  private var pending: [UUID: Pending] = [:]

  public init(worker: @escaping Worker) { self.worker = worker }

  public var statusText: String {
    if quitting { return "Stopping…" }
    if updating { return active.isEmpty ? "Updating…" : "Waiting to update…" }
    if paused { return "Paused" }
    if !active.isEmpty { return active.count == 1 ? "Working" : "Working · \(active.count)" }
    if modelError != nil { return "Unavailable" }
    return modelStatus == nil ? "Checking…" : "Ready"
  }

  public func setModelStatus(_ status: HostStatus?, error: String? = nil) {
    modelStatus = status; modelError = error
  }

  public func connect(_ client: UUID) {
    guard !quitting else { return }
    clients.insert(client); connections = clients.count; lastConnectedAt = Date()
  }

  public func disconnect(_ client: UUID) {
    clients.remove(client); connections = clients.count
    for (key, operation) in pending where operation.client == client { cancel(key) }
  }

  public func receive(_ request: HostRequest, client: UUID, writer: NativeWriter) {
    do { try request.validate() }
    catch { try? writer.send(HostEvent(id: request.id, type: "error", text: String(describing: error))); return }
    if request.action == "cancel" {
      for (key, operation) in pending where operation.client == client && operation.request == request.id { cancel(key) }
      return
    }
    if request.action == "tool_result" {
      if let operation = pending.values.first(where: { $0.client == client && $0.request == request.id }), let callId = request.callId, let result = request.result {
        Task { await operation.tools.resolve(callId: callId, result: result) }
      }
      return
    }
    guard !quitting, !paused, !updating else {
      try? writer.send(HostEvent(id: request.id, type: "error", text: updating ? "Web Recall is updating. New inference can start after it restarts." : quitting ? "Web Recall companion is quitting. Open it again to use Apple inference." : "Native inference is paused. Resume it from the Web Recall menu-bar app.")); return
    }
    guard !pending.values.contains(where: { $0.client == client && $0.request == request.id }) else {
      try? writer.send(HostEvent(id: request.id, type: "error", text: "Request is already running.")); return
    }
    let key = UUID()
    let summary = OperationSummary(id: key, action: request.action, mode: request.mode ?? "on-device", startedAt: Date(), outcome: "Running")
    let output = RequestOutput(writer)
    let sink = NativeWriter(sendEvent: { try output.forward($0) })
    let tools = ToolSession(requestId: request.id, writer: sink, limit: request.toolLimit ?? 0)
    let task = Task {
      do {
        let result = try await worker(request, sink, tools)
        try Task.checkCancellation()
        if let status = result.status { setModelStatus(status) }
        complete(key, event: result, outcome: "Completed")
      } catch {
        if request.action == "status", !Task.isCancelled { setModelStatus(nil, error: String(describing: error)) }
        complete(key, event: HostEvent(id: request.id, type: Task.isCancelled ? "cancelled" : "error", text: Task.isCancelled ? "Answer stopped" : String(describing: error)), outcome: Task.isCancelled ? "Stopped" : "Failed")
      }
    }
    pending[key] = Pending(client: client, request: request.id, summary: summary, output: output, task: task, tools: tools)
    active.append(summary)
  }

  public func stopAll() { for key in Array(pending.keys) { cancel(key) } }
  public func setPaused(_ value: Bool) { paused = value; if value { stopAll() } }
  public func setUpdating(_ value: Bool) { updating = value }
  public func quit() { quitting = true; stopAll() }

  private func cancel(_ key: UUID) {
    guard let operation = pending[key] else { return }
    operation.task.cancel()
    complete(key, event: HostEvent(id: operation.request, type: "cancelled", text: "Answer stopped"), outcome: "Stopped")
  }

  private func complete(_ key: UUID, event: HostEvent, outcome: String) {
    guard let operation = pending.removeValue(forKey: key) else { return }
    Task { await operation.tools.close() }
    operation.output.finish(event)
    active.removeAll { $0.id == key }
    var summary = operation.summary
    summary.finishedAt = Date(); summary.outcome = outcome
    history.insert(summary, at: 0)
    if history.count > 20 { history.removeLast(history.count - 20) }
  }
}
