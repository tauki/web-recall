import { pageContent } from '../pageContent';
import type { PageRecord, PageVersion } from './index';

export function searchPageRecord(page: PageRecord): PageRecord {
  const snapshot = (version: PageVersion): PageVersion => ({ title: version.title, timestamp: version.timestamp, firstCapturedAt: version.firstCapturedAt, versionId: version.versionId, text: pageContent(version), chunks: [] });
  return { ...snapshot(page), url: page.url, title: page.title, manual: page.manual, createdAt: page.createdAt, updatedAt: page.updatedAt, versions: page.versions?.map(snapshot) };
}
