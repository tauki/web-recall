import type { PageRecord, PageVersion } from './db/index';
import { pageContent } from './pageContent';

export const RECENT_VERSION_LIMIT = 5;

export type SavedVersionSelection = { url: string; versionIds: string[] };
export type ForgetResult = { pages: number; versions: number };
export type SavedVersionSource = { url: string; versionId?: string; timestamp: number; firstCapturedAt?: number; title?: string; text: string };

export function versionSource(url: string, version: PageVersion): SavedVersionSource {
  return { url, versionId: version.versionId, timestamp: version.timestamp, firstCapturedAt: version.firstCapturedAt, title: version.title, text: pageContent(version) };
}

export function readVersionSelection(value: unknown): SavedVersionSelection[] {
  if (!Array.isArray(value)) throw new Error('Review saved versions before forgetting them.');
  const selected = new Map<string, Set<string>>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || !Array.isArray(entry.versionIds)) throw new Error('Invalid saved-version selection. Review it again.');
    let address: URL;
    try { address = new URL(entry.url); } catch { throw new Error('Invalid saved-page URL.'); }
    if (!['http:', 'https:'].includes(address.protocol)) throw new Error('Invalid saved-page URL.');
    const versions = selected.get(entry.url) || new Set<string>();
    for (const identity of entry.versionIds) {
      if (typeof identity !== 'string' || !identity || identity.length > 100) throw new Error('Invalid saved version identity.');
      versions.add(identity);
    }
    selected.set(entry.url, versions);
  }
  return [...selected].map(([url, versionIds]) => ({ url, versionIds: [...versionIds] }));
}

export function versionSnapshot(page: PageRecord): PageVersion {
  return {
    versionId: page.versionId,
    title: page.title,
    timestamp: page.timestamp,
    firstCapturedAt: page.firstCapturedAt ?? page.timestamp,
    kept: page.kept,
    manual: page.manual,
    lastVisitedAt: page.lastVisitedAt,
    lastEmbeddedAt: page.lastEmbeddedAt,
    text: page.text,
    chunks: page.chunks,
    summary: page.summary,
    captureInfo: page.captureInfo
  };
}

export function identifySavedVersions(page: PageRecord): PageRecord {
  const versions = (page.versions || []).map(version => ({ ...version, versionId: version.versionId || crypto.randomUUID(), kept: version.kept ?? true })).sort((left, right) => right.timestamp - left.timestamp);
  const duplicate = versions.find(version => version.timestamp === page.timestamp && pageContent(version) === pageContent(page) && (!version.title || version.title === page.title));
  const versionId = page.versionId || duplicate?.versionId || crypto.randomUUID();
  return { ...page, versionId, firstCapturedAt: page.firstCapturedAt ?? page.timestamp, kept: page.kept ?? !page.versionId, versions: versions.filter(version => version.versionId !== versionId) };
}

export function captureWithHistory(incoming: PageRecord, saved?: PageRecord): PageRecord {
  if (!saved) return { ...incoming, versionId: crypto.randomUUID(), firstCapturedAt: incoming.timestamp, lastVisitedAt: incoming.timestamp, kept: false };
  const current = identifySavedVersions(saved);
  const unchanged = current.title === incoming.title && pageContent(current) === pageContent(incoming);
  if (unchanged) return { ...incoming, versionId: current.versionId, firstCapturedAt: current.firstCapturedAt, lastVisitedAt: incoming.timestamp, kept: current.kept, versions: current.versions };
  const history = [versionSnapshot(current), ...(current.versions || [])].sort((left, right) => right.timestamp - left.timestamp);
  return {
    ...incoming, versionId: crypto.randomUUID(), firstCapturedAt: incoming.timestamp, lastVisitedAt: incoming.timestamp, kept: false,
    versions: history.filter((version, index) => index < RECENT_VERSION_LIMIT - 1 || version.kept)
  };
}
