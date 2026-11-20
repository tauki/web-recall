import type { TextMatch } from './textSearch';
import type { CaptureInfo } from './capture';

export type SavedPageSnapshot = {
  url: string;
  title: string;
  timestamp: number;
  text: string;
  current: boolean;
  match?: TextMatch;
  versionId?: string;
  firstCapturedAt?: number;
  lastVisitedAt?: number;
  kept?: boolean;
  captureInfo?: CaptureInfo;
};

export type SavedVersionSummary = { versionId: string; title: string; timestamp: number; firstCapturedAt: number; kept: boolean; current: boolean };
