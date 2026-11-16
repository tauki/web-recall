export type AnswerOutcome = 'answered' | 'insufficient_evidence' | 'failed';
export type GroundedAnswer = { outcome: AnswerOutcome; answer: string };

export const ANSWER_FORMAT = {
  type: 'object', properties: { outcome: { type: 'string', enum: ['answered', 'insufficient_evidence'] }, answer: { type: 'string' } },
  required: ['outcome', 'answer'], additionalProperties: false
};

export function readGroundedAnswer(text: string, sourceIds: number[]): GroundedAnswer | null {
  let result: GroundedAnswer;
  try { result = JSON.parse(text); }
  catch { if (text.trimStart().startsWith('{')) return null; result = { outcome: 'answered', answer: text }; }
  if (!result || !['answered', 'insufficient_evidence'].includes(result.outcome) || typeof result.answer !== 'string' || !result.answer.trim()) return null;
  const citations = [...result.answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
  if (citations.some(index => !sourceIds.includes(index))) return null;
  if (result.outcome === 'answered' && !citations.length) return null;
  return { outcome: result.outcome, answer: result.answer.trim() };
}

export function streamedAnswer(text: string): string {
  if (!text.trimStart().startsWith('{')) return text;
  const match = /"answer"\s*:\s*"((?:\\[\s\S]|[^"\\])*)/.exec(text);
  if (!match) return '';
  let fragment = match[1]!;
  const trailingEscape = /(\\+)(?:u[0-9a-fA-F]{0,3})?$/.exec(fragment);
  if (trailingEscape && trailingEscape[1]!.length % 2 === 1) fragment = fragment.slice(0, trailingEscape.index + trailingEscape[1]!.length - 1);
  try { return JSON.parse(`"${fragment}"`) as string; }
  catch { return ''; }
}
