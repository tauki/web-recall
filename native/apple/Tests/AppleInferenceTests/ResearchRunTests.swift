import Foundation
import Testing
import NativeProtocol
@testable import AppleInference

private actor BrowserReply {
  weak var channel: ToolSession?
  let text: String
  init(text: String = "Saved fact: Cedar launches May 19 [7].") { self.text = text }
  func bind(_ channel: ToolSession) { self.channel = channel }
  func reply(_ event: HostEvent) async { if let call = event.toolCall { await channel?.resolve(callId: call.callId, result: text) } }
}

@Test @MainActor func aFullResearchWindowCompactsAndContinuesWithTheReadEvidenceAndTheOriginalCallAllowance() async throws {
  let browser = BrowserReply()
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in Task { await browser.reply(event) } }), limit: 3)
  await browser.bind(channel)
  var generations = 0, compactions = 0
  let answer = try await runLibraryResearch(channel: channel, initiallyFinishOnly: false, isContextError: { _ in false }, onCompact: { reason in #expect(reason == .context) }, generate: { state, recent, finishOnly in
    generations += 1
    #expect(!finishOnly)
    if generations == 1 {
      await channel.setContextCheck { _ in false }
      return try await channel.call(name: "fetch_more", arguments: "{\"chunkIndex\":2}")
    }
    #expect(state.contains("May 19 [7]"))
    #expect(recent.contains("Saved fact: Cedar launches May 19 [7]"))
    #expect(await channel.calls == 1)
    return "Cedar launches May 19 [7]."
  }, compact: { _, observations in
    compactions += 1
    #expect(observations.joined().contains("May 19 [7]"))
    return "We read that Cedar launches May 19 [7]. No questions remain."
  })
  #expect(answer == "Cedar launches May 19 [7].")
  #expect(generations == 2)
  #expect(compactions == 1)
}

@Test @MainActor func anExhaustedCallAllowanceFinalizesWithoutReenablingToolsOrRetryingUnrelatedFailures() async throws {
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { _ in }), limit: 0)
  var generations = 0
  let answer = try await runLibraryResearch(channel: channel, initiallyFinishOnly: false, isContextError: { _ in false }, onCompact: { reason in #expect(reason == .allowance) }, generate: { _, _, finishOnly in
    generations += 1
    if !finishOnly { return try await channel.call(name: "search_memory", arguments: "{}") }
    return "The saved evidence is insufficient."
  }, compact: { previous, _ in previous })
  #expect(answer.contains("insufficient"))
  #expect(generations == 2)
  let failure = NSError(domain: "ProviderUnavailable", code: 1)
  await #expect(throws: NSError.self) {
    try await runLibraryResearch(channel: ToolSession(requestId: "other", writer: NativeWriter(sendEvent: { _ in }), limit: 3), initiallyFinishOnly: false, isContextError: { _ in false }, onCompact: { _ in Issue.record("Unrelated failures must not compact") }, generate: { _, _, _ in throw failure }, compact: { _, _ in Issue.record("Unrelated failures must not summarize"); return "" })
  }
}

@Test @MainActor func repeatedUnchangedToolsCannotSpendTheWholeSafetyAllowanceCompactingWithoutProgress() async throws {
  let browser = BrowserReply(text: #"{"ok":true,"data":{"text":"Already read","sourceIndex":7},"newInformation":false,"control":{"noProgress":true}}"#)
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in Task { await browser.reply(event) } }), limit: 100)
  await browser.bind(channel)
  var attempts = 0, finalizations = 0
  var reason: ResearchRecovery?
  let answer = try await runLibraryResearch(channel: channel, initiallyFinishOnly: false, isContextError: { _ in false }, onCompact: { reason = $0 }, generate: { state, _, finishOnly in
    attempts += 1
    if finishOnly {
      finalizations += 1
      #expect(state.contains("[7]"))
      return "The already-read passage answers the question [7]."
    }
    await channel.setContextCheck { _ in true }
    return try await channel.call(name: "fetch_more", arguments: "{}")
  }, compact: { _, _ in "The read passage [7] is unchanged. No new evidence was found." })
  #expect(answer.contains("[7]"))
  #expect(finalizations == 1)
  #expect(reason == .noProgress)
  #expect(attempts < 10)
  #expect(await channel.progress == 0)
}

@Test @MainActor func callExhaustionStillGetsOneToolFreeFinalizationAfterStalledContextRecovery() async throws {
  let browser = BrowserReply(text: #"{"ok":true,"data":{},"newInformation":false,"control":{"noProgress":true}}"#)
  let channel = ToolSession(requestId: "run", writer: NativeWriter(sendEvent: { event in Task { await browser.reply(event) } }), limit: 2)
  await browser.bind(channel)
  var finalized = false
  let answer = try await runLibraryResearch(channel: channel, initiallyFinishOnly: false, isContextError: { _ in false }, onCompact: { _ in }, generate: { _, _, finishOnly in
    if finishOnly { finalized = true; return "The saved evidence is insufficient." }
    await channel.setContextCheck { _ in true }
    return try await channel.call(name: "fetch_more", arguments: "{}")
  }, compact: { _, _ in "We have not found the missing detail." })
  #expect(finalized)
  #expect(answer.contains("insufficient"))
  #expect(await channel.calls == 2)
}
