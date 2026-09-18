export type CapturePayload = {
  url: string;
  title: string;
  timestamp: number;
  chunks: string[];
  text: string;
  force?: boolean;
  manual?: boolean;
};

export type QueueItem = {
  url: string;
  payload: CapturePayload;
  delayMs: number;
  attempts: number;
};
