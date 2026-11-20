import { storageManager } from '../storage/manager';
import { pageContent } from '../../shared/pageContent';
import { createTextMatcher, findStoredTextRange, type TextMatch } from '../../shared/textSearch';
import type { SavedPageSnapshot, SavedVersionSummary } from '../../shared/savedPage';

export async function getSavedVersion(url: string, timestamp?: number, versionId?: string) {
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) throw new Error('Invalid saved capture time. Search again to open a saved capture.');
  const record = await storageManager.getPageRecord(url);
  if (!record) return undefined;
  if (versionId !== undefined && (typeof versionId !== 'string' || !versionId)) throw new Error('Invalid saved version identity.');
  const candidates = [record, ...(record.versions || [])].filter(item => versionId ? item.versionId === versionId : timestamp === undefined ? item === record : item.timestamp === timestamp || item.firstCapturedAt === timestamp);
  if (candidates.length > 1 && candidates.some(item => item.title !== candidates[0]!.title || pageContent(item) !== pageContent(candidates[0]!))) throw new Error('Several captures share this time. Open saved history and choose a version.');
  const version = candidates[0];
  const current = version === record;
  if (!version) throw new Error('This saved capture is no longer available. Search again to find the current saved version.');
  return { record, version, current };
}

export async function getSavedPage(url: string, timestamp?: number, query = '', chunkIndex?: number, versionId?: string): Promise<SavedPageSnapshot> {
  const saved = await getSavedVersion(url, timestamp, versionId);
  if (!saved) throw new Error('This saved page is no longer available. Search again or capture the live page.');
  const { record, version, current } = saved;
  const text = pageContent(version);
  const snapshot = { ...record, ...version, text };
  let match: TextMatch | undefined = query.trim() ? createTextMatcher(query)(snapshot)?.match : undefined;
  if (chunkIndex !== undefined) {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= version.chunks.length) throw new Error('This saved passage is no longer available. Search again to find the current saved version.');
    let from = 0;
    for (let index = 0; index <= chunkIndex; index++) {
      const range = findStoredTextRange(text, version.chunks[index]!.text, from);
      if (!range) throw new Error('This saved passage could not be located in the capture. Return to search and try another saved result.');
      from = range.end;
      if (index === chunkIndex) {
        const local = query.trim() ? createTextMatcher(query)({ ...snapshot, title: '', url: '', text: text.slice(range.start, range.end), chunks: [] })?.match : undefined;
        match = { field: 'text', start: range.start + (local?.start || 0), end: local ? range.start + local.end : range.end };
      }
    }
  }
  return { url: record.url, title: version.title || record.url, timestamp: version.timestamp, text, current, match, versionId: version.versionId, firstCapturedAt: version.firstCapturedAt ?? version.timestamp, lastVisitedAt: current ? record.lastVisitedAt : undefined, kept: version.kept, captureInfo: version.captureInfo };
}

export async function getSavedHistory(url: string): Promise<SavedVersionSummary[]> {
  const versions = await storageManager.listPageVersions(url);
  return versions.map((version, index) => ({ versionId: version.versionId!, title: version.title || url, timestamp: version.timestamp, firstCapturedAt: version.firstCapturedAt ?? version.timestamp, kept: version.kept === true, current: index === 0 }));
}
