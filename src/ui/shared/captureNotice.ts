import type { CaptureInfo } from '../../shared/capture';

export function captureNotice(info?: CaptureInfo): HTMLElement | undefined {
  if (!info?.warnings.length) return;
  const notice = document.createElement('p'); notice.className = 'capture-notice';
  notice.textContent = `Partial capture · ${info.warnings.join(' ')}`;
  return notice;
}
