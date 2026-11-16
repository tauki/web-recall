export class AppleSafetyBlockError extends Error {
  readonly code = 'apple_safety_block';

  constructor() {
    super('Apple Foundation Models blocked this request or response with its safety guardrails.');
    this.name = 'AppleSafetyBlockError';
  }
}
