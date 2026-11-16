import Foundation
import Testing
@testable import NativeProtocol

@Test func nativeFramesUseChromeLengthPrefixAndPreserveUTF8() throws {
  let payload = Data("{\"text\":\"café 🐈\"}".utf8)
  let framed = try NativeFraming.encode(payload)
  #expect(Array(framed.prefix(4)) == [UInt8(payload.count), 0, 0, 0])
  let pipe = Pipe()
  try pipe.fileHandleForWriting.write(contentsOf: framed)
  try pipe.fileHandleForWriting.close()
  #expect(try NativeFraming.read(from: pipe.fileHandleForReading) == payload)
  #expect(try NativeFraming.read(from: pipe.fileHandleForReading) == nil)
}

@Test func interruptedAndOversizedFramesAreRejected() throws {
  for bytes in [Data([1, 0]), Data([4, 0, 0, 0, 123]), Data([0, 0, 0, 1])] {
    let pipe = Pipe()
    try pipe.fileHandleForWriting.write(contentsOf: bytes)
    try pipe.fileHandleForWriting.close()
    #expect(throws: ProtocolError.self) { try NativeFraming.read(from: pipe.fileHandleForReading) }
  }
}

@Test func modelAndCompanionIdentitySurviveTheNativeCapabilityResponse() throws {
  let pipe = Pipe()
  let status = HostStatus(available: true, reason: nil, contextTokens: 8192, mode: "on-device", modelName: "Fixture Model", companionVersion: "1.2.3-testing")
  try NativeWriter(handle: pipe.fileHandleForWriting).send(HostEvent(id: "status-check", type: "status", status: status))
  let received = try NativeFraming.read(from: pipe.fileHandleForReading)
  let data = try #require(received)
  let object = try JSONSerialization.jsonObject(with: data)
  let response = try #require(object as? [String: Any])
  let capability = try #require(response["status"] as? [String: Any])
  #expect(capability["protocolVersion"] as? Int == 2)
  #expect(capability["modelName"] as? String == "Fixture Model")
  #expect(capability["companionVersion"] as? String == "1.2.3-testing")
  #expect(capability["contextTokens"] as? Int == 8192)
}

@Test func cloudGenerationRequiresConsentAndSourceIdentityIsUnique() throws {
  let decoder = JSONDecoder()
  for json in [
    #"{"id":"cloud","action":"generate","mode":"private-cloud","prompt":"Hello"}"#,
    #"{"id":"local","action":"generate","prompt":"Hi","sources":[{"index":1,"title":"A","evidence":"One","passages":[]},{"index":1,"title":"B","evidence":"Two","passages":[]}]}"#,
    #"{"id":"unknown","action":"execute"}"#
  ] {
    let request = try decoder.decode(HostRequest.self, from: Data(json.utf8))
    #expect(throws: ProtocolError.self) { try request.validate() }
  }
  let local = try decoder.decode(HostRequest.self, from: Data(#"{"id":"local","action":"generate","prompt":"Hello"}"#.utf8))
  try local.validate()
  let cloud = try decoder.decode(HostRequest.self, from: Data(#"{"id":"cloud","action":"generate","mode":"private-cloud","cloudConsent":true,"prompt":"Hello"}"#.utf8))
  try cloud.validate()
}
