export type CaptureInfo = {
  source: 'article' | 'main' | 'body';
  warnings: string[];
};

export function readCaptureInfo(value: unknown): CaptureInfo | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capture metadata.');
  const record = value as Record<string, unknown>;
  if (record.source !== 'article' && record.source !== 'main' && record.source !== 'body') {
    throw new Error('Invalid capture extraction source.');
  }
  if (!Array.isArray(record.warnings) || record.warnings.length > 16 || [...record.warnings].some(warning => typeof warning !== 'string' || warning.length > 500)) {
    throw new Error('Invalid capture warnings: expected at most 16 strings of at most 500 characters.');
  }
  return { source: record.source, warnings: [...record.warnings] };
}
