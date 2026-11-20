export function captureStatusText(entry: { status: string; error?: string; textSaved?: boolean }): string {
  if (!entry.textSaved) {
    if (entry.status === 'queued') return 'Waiting to save and index';
    if (entry.status === 'processing') return 'Saving and indexing';
    return `Capture or indexing failed${entry.error ? `: ${entry.error}` : ''}. Check settings, then Retry.`;
  }
  if (entry.status === 'queued') return 'Saved · waiting for indexing';
  if (entry.status === 'processing') return 'Saved · indexing';
  if (entry.status === 'failed') return `Saved text is searchable · indexing failed${entry.error ? `: ${entry.error}` : ''}. Check settings, then Retry.`;
  return 'Saved · text-searchable';
}
