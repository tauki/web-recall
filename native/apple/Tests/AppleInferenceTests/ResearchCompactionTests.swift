import Foundation
import Testing
import NativeProtocol
@testable import AppleInference

@Test func groundedAnswersRenderSourceIDsWithoutRelyingOnCitationPunctuationFromTheModel() throws {
  let value = NativeAnswer(outcome: .answered, paragraphs: [NativeParagraph(text: "The launch is May 19.", citations: [7, 7])])
  let object = try JSONSerialization.jsonObject(with: Data(encodeGroundedAnswer(value).utf8)) as? [String: String]
  #expect(object?["outcome"] == "answered")
  #expect(object?["answer"] == "The launch is May 19. [7]")
  let insufficient = NativeAnswer(outcome: .insufficient_evidence, paragraphs: [NativeParagraph(text: "The saved plan has no budget.", citations: [])])
  let missing = try JSONSerialization.jsonObject(with: Data(encodeGroundedAnswer(insufficient).utf8)) as? [String: String]
  #expect(missing?["outcome"] == "insufficient_evidence")
  #expect(missing?["answer"] == "The saved plan has no budget.")
  let alreadyCited = NativeAnswer(outcome: .answered, paragraphs: [NativeParagraph(text: "The launch is May 19 [7].", citations: [7])])
  let rendered = try JSONSerialization.jsonObject(with: Data(encodeGroundedAnswer(alreadyCited).utf8)) as? [String: String]
  #expect(rendered?["answer"] == "The launch is May 19 [7].")
  let indexValue = NativeAnswer(outcome: .answered, paragraphs: [NativeParagraph(text: "Use values[7]", citations: [7])])
  let index = try JSONSerialization.jsonObject(with: Data(encodeGroundedAnswer(indexValue).utf8)) as? [String: String]
  #expect(index?["answer"] == "Use values[7] [7]")
}

@Test @MainActor func restartingAContextPacksPreviewsAroundTheQuestionAndPreservedEvidenceWithinTheModelLimit() async throws {
  let data = Data(#"[{"index":7,"title":"Saved plan","url":"https://example.test/plan","evidence":"A very long opening paragraph. A very long opening paragraph. A very long opening paragraph.","passages":[]}]"#.utf8)
  let sources = try JSONDecoder().decode([SavedSource].self, from: data)
  let result = try await libraryPrompt(question: "When is the launch?", sources: sources, workingState: "The user means Cedar [7].", recentEvidence: "The saved launch date is May 19 [7].", maxInputTokens: 220, measure: { $0.utf8.count })
  #expect(result.contains("When is the launch?"))
  #expect(result.contains("Cedar [7]"))
  #expect(result.contains("May 19 [7]"))
  #expect(result.utf8.count < 220)
}

@Test @MainActor func researchCompactionCarriesEarlierFindingsAndNewObservationsWithoutInventingSourceIDs() async throws {
  var prompts: [String] = []
  let result = try await compactResearch(previous: "The user is asking about Cedar.", observations: ["search_memory found source [7]", "fetch_more: The launch is May 19 [7]"], question: "When is the launch?", contextSize: 4096, measure: { $0.utf8.count }) { prompt in
    prompts.append(prompt)
    return "Cedar launches May 19 [7]. Verify any further details from saved passages."
  }
  #expect(!prompts.isEmpty)
  #expect(prompts.joined().contains("The user is asking about Cedar"))
  #expect(prompts.joined().contains("search_memory found source [7]"))
  #expect(prompts.joined().contains("The launch is May 19 [7]"))
  #expect(result.contains("May 19 [7]"))
}

@Test @MainActor func researchCompactionDoesNotRunAnotherModelAfterCancellation() async throws {
  var started = false, calls = 0
  let operation = Task { @MainActor in
    try Task.checkCancellation()
    return try await compactResearch(previous: "", observations: ["One", "Two"], question: "Question", contextSize: 4096, measure: { $0.utf8.count }) { _ in
      started = true; calls += 1
      try await Task.sleep(for: .seconds(3600))
      return "Should not finish"
    }
  }
  defer { operation.cancel() }
  for _ in 0..<2000 { if started { break }; await Task.yield() }
  try #require(started)
  operation.cancel()
  await #expect(throws: CancellationError.self) { try await operation.value }
  #expect(calls == 1)
}
