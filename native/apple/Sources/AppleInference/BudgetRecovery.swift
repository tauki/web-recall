import Foundation
import NativeProtocol


enum ResearchRecovery { case context, allowance, noProgress }

@MainActor func runLibraryResearch(channel: ToolSession, initiallyFinishOnly: Bool, isContextError: (Error) -> Bool, onCompact: (ResearchRecovery) throws -> Void, generate: (String, String, Bool) async throws -> String, compact: (String, [String]) async throws -> String) async throws -> String {
  var workingState = "", recentEvidence = "", compactedAt = -1, stalledWindows = 0, finishOnly = initiallyFinishOnly
  while true {
    try Task.checkCancellation()
    do {
      let answer = try await generate(workingState, recentEvidence, finishOnly)
      await channel.clearContextCheck()
      return answer
    } catch {
      await channel.clearContextCheck()
      try Task.checkCancellation()
      let budget = await channel.allowanceExceeded
      let progress = await channel.progress
      let context = await channel.needsCompaction
      stalledWindows = progress == compactedAt ? stalledWindows + 1 : 0
      guard !finishOnly, budget || context || isContextError(error) else { throw error }
      let recovery: ResearchRecovery = budget ? .allowance : stalledWindows >= 2 ? .noProgress : .context
      compactedAt = progress
      try onCompact(recovery)
      let observations = await channel.takeObservations()
      recentEvidence = observations.last ?? recentEvidence
      workingState = try await compact(workingState, observations)
      finishOnly = recovery != .context
    }
  }
}
