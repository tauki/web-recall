import Foundation

public struct SavedSource: Codable, Sendable {
  public let index: Int
  public let title: String
  public let evidence: String
  public let url: String?
}

public struct ToolProperty: Codable, Sendable {
  public let type: String
  public let description: String?
}

public struct ToolParameters: Codable, Sendable {
  public let type: String
  public let properties: [String: ToolProperty]
  public let required: [String]?
}

public struct SavedMemoryTool: Codable, Sendable {
  public let name: String
  public let description: String
  public let parameters: ToolParameters
}

public struct ToolInvocation: Codable, Sendable {
  public let callId: String
  public let name: String
  public let arguments: String

  public init(callId: String, name: String, arguments: String) { self.callId = callId; self.name = name; self.arguments = arguments }
}

public struct HostRequest: Decodable, Sendable {
  public let id: String
  public let action: String
  public let mode: String?
  public let cloudConsent: Bool?
  public let instructions: String?
  public let prompt: String?
  public let sources: [SavedSource]?
  public let toolLimit: Int?
  public let maxOutputTokens: Int?
  public let tools: [SavedMemoryTool]?
  public let callId: String?
  public let result: String?

  public init(id: String, action: String, mode: String? = nil, cloudConsent: Bool? = nil, instructions: String? = nil, prompt: String? = nil, sources: [SavedSource]? = nil, toolLimit: Int? = nil, tools: [SavedMemoryTool]? = nil, callId: String? = nil, result: String? = nil, maxOutputTokens: Int? = nil) {
    self.id = id; self.action = action; self.mode = mode; self.cloudConsent = cloudConsent
    self.instructions = instructions; self.prompt = prompt; self.sources = sources; self.toolLimit = toolLimit
    self.tools = tools; self.callId = callId; self.result = result
    self.maxOutputTokens = maxOutputTokens
  }

  public func validate() throws {
    guard !id.isEmpty, id.utf8.count <= 128 else { throw ProtocolError.invalidRequest }
    guard ["status", "generate", "cancel", "tool_result", "backup_status_encrypted", "backup_begin_encrypted"].contains(action) else { throw ProtocolError.invalidRequest }
    guard mode == nil || mode == "on-device" || mode == "private-cloud" else { throw ProtocolError.invalidRequest }
    if mode == "private-cloud", cloudConsent != true { throw ProtocolError.cloudConsentRequired }
    if action == "generate" {
      if let maxOutputTokens { guard maxOutputTokens > 0, maxOutputTokens <= 1_000_000 else { throw ProtocolError.invalidRequest } }
      guard let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ProtocolError.invalidRequest }
      let sources = sources ?? []
      guard sources.allSatisfy({ $0.index > 0 }), Set(sources.map(\.index)).count == sources.count else { throw ProtocolError.invalidRequest }
      let allowed = Set(["fetch_more", "get_page_summary", "get_page_chunks", "search_memory", "search_within_page"])
      let tools = tools ?? []
      guard tools.count <= allowed.count, Set(tools.map(\.name)).count == tools.count,
        tools.allSatisfy({ allowed.contains($0.name) && $0.parameters.type == "object" && $0.parameters.properties.count <= 10 && $0.parameters.properties.values.allSatisfy { ["string", "integer"].contains($0.type) } }) else { throw ProtocolError.invalidRequest }
    }
    if action == "tool_result" { guard let callId, !callId.isEmpty, callId.utf8.count <= 128, let result, result.utf8.count <= 64 * 1024 else { throw ProtocolError.invalidRequest } }
  }
}

public enum ProtocolError: Error, CustomStringConvertible {
  case invalidRequest, cloudConsentRequired, invalidFrame, truncatedFrame

  public var description: String {
    switch self {
    case .invalidRequest: "Invalid native request."
    case .cloudConsentRequired: "Private Cloud Compute requires explicit consent."
    case .invalidFrame: "Native message exceeds the supported size."
    case .truncatedFrame: "Native message was interrupted."
    }
  }
}

public enum NativeFraming {
  public static let maximumRequestBytes = 4 * 1024 * 1024
  public static let maximumResponseBytes = 1024 * 1024

  public static func read(from handle: FileHandle, maximumBytes: Int = maximumRequestBytes) throws -> Data? {
    let header = try readExactly(4, from: handle)
    if header.isEmpty { return nil }
    guard header.count == 4 else { throw ProtocolError.truncatedFrame }
    let count = header.enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
    guard count > 0, count <= maximumBytes else { throw ProtocolError.invalidFrame }
    let body = try readExactly(count, from: handle)
    guard body.count == count else { throw ProtocolError.truncatedFrame }
    return body
  }

  public static func encode(_ data: Data, maximumBytes: Int = maximumResponseBytes) throws -> Data {
    guard !data.isEmpty, data.count <= maximumBytes else { throw ProtocolError.invalidFrame }
    let length = UInt32(data.count)
    return Data((0..<4).map { UInt8(truncatingIfNeeded: length >> ($0 * 8)) }) + data
  }

  private static func readExactly(_ count: Int, from handle: FileHandle) throws -> Data {
    var result = Data()
    while result.count < count {
      let part = try handle.read(upToCount: count - result.count) ?? Data()
      if part.isEmpty { break }
      result.append(part)
    }
    return result
  }
}

public struct HostStatus: Encodable, Sendable {
  public let protocolVersion = 2
  public let libraryTools = true
  public let available: Bool
  public let reason: String?
  public let contextTokens: Int?
  public let mode: String
  public let modelName: String?
  public let companionVersion: String?

  public init(available: Bool, reason: String?, contextTokens: Int?, mode: String, modelName: String? = nil, companionVersion: String? = nil) {
    self.available = available; self.reason = reason; self.contextTokens = contextTokens; self.mode = mode
    self.modelName = modelName; self.companionVersion = companionVersion
  }
}

public struct HostEvent: Encodable, Sendable {
  public let id: String
  public let type: String
  public var text: String?
  public var status: HostStatus?
  public var toolCall: ToolInvocation?
  public var phase: String?

  public init(id: String, type: String, text: String? = nil, status: HostStatus? = nil, toolCall: ToolInvocation? = nil, phase: String? = nil) {
    self.id = id; self.type = type; self.text = text; self.status = status
    self.toolCall = toolCall
    self.phase = phase
  }
}

public final class NativeWriter: @unchecked Sendable {
  private let lock = NSLock()
  private let sendEvent: @Sendable (HostEvent) throws -> Void

  public init(handle: FileHandle = .standardOutput) { sendEvent = { try handle.write(contentsOf: NativeFraming.encode(JSONEncoder().encode($0))) } }

  public init(writeFrame: @escaping @Sendable (Data) throws -> Void) { sendEvent = { try writeFrame(NativeFraming.encode(JSONEncoder().encode($0))) } }

  public init(sendEvent: @escaping @Sendable (HostEvent) throws -> Void) { self.sendEvent = sendEvent }

  public func send(_ event: HostEvent) throws {
    lock.lock()
    defer { lock.unlock() }
    try sendEvent(event)
  }
}
