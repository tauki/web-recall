import { sendRuntimeMessage } from './runtime';
import { iconMarkup } from './presentation';
import type { SavedPageSnapshot, SavedVersionSummary } from '../../shared/savedPage';
import { RECENT_VERSION_LIMIT } from '../../shared/pageHistory';
import { captureNotice } from './captureNotice';

type SavedReader = { open: (url: string, timestamp?: number, query?: string, chunkIndex?: number, versionId?: string, history?: boolean) => Promise<void>; close: () => void };

export function createSavedReader(host: HTMLElement, onClose: () => void, onRead?: () => void): SavedReader {
  let generation = 0;
  let historyExpanded = false;
  const close = (): void => { generation++; host.hidden = true; host.replaceChildren(); onClose(); };
  const reader: SavedReader = {
    close,
    async open(url, timestamp, query, chunkIndex, versionId, history) {
      if (history !== undefined) historyExpanded = history;
      const revision = ++generation;
      host.hidden = false; host.replaceChildren();
      const back = document.createElement('button'); back.type = 'button'; back.className = 'text-button saved-reader-back'; back.innerHTML = `${iconMarkup('arrow-left')}Back to preview`; back.addEventListener('click', close);
      const status = document.createElement('p'); status.className = 'wr-help'; status.setAttribute('role', 'status'); status.textContent = 'Loading saved capture…';
      host.append(back, status);
      try {
        const { page } = await sendRuntimeMessage<{ page: SavedPageSnapshot }>({ type: 'GET_SAVED_PAGE', url, timestamp, query, chunkIndex, versionId });
        if (revision !== generation) return;
        if (!page || page.url !== url || typeof page.text !== 'string') throw new Error('The saved capture could not be loaded. Return to search and try again.');
        status.textContent = `Saved capture · ${new Date(page.firstCapturedAt ?? page.timestamp).toLocaleString()}${page.timestamp !== (page.firstCapturedAt ?? page.timestamp) ? ` · Last captured ${new Date(page.timestamp).toLocaleString()}` : ''}${page.current ? '' : ' · Earlier version'}`;
        const notice = captureNotice(page.captureInfo); if (notice) host.append(notice);
        const versions = document.createElement('details'); versions.className = 'saved-reader-history'; versions.open = historyExpanded;
        const summary = document.createElement('summary'); summary.textContent = 'Saved versions'; versions.append(summary);
        const tools = document.createElement('div'); versions.append(tools); host.append(versions);
        let loaded = false;
        const loadHistory = async (): Promise<void> => {
          if (loaded || !versions.open) return; loaded = true; tools.textContent = 'Loading saved versions…';
          try {
            const response = await sendRuntimeMessage<{ versions: SavedVersionSummary[] }>({ type: 'GET_SAVED_HISTORY', url });
            if (revision !== generation) return;
            const entries = response.versions || [];
            const selected = entries.find(entry => page.versionId ? entry.versionId === page.versionId : entry.timestamp === page.timestamp && entry.current === page.current);
            if (!selected) throw new Error('This saved version is no longer retained. Return to preview and open the current capture.');
            tools.replaceChildren();
            const label = document.createElement('label'); label.className = 'compact-setting'; label.append('Version');
            const select = document.createElement('select'); select.setAttribute('aria-label', 'Saved version');
            const optionText = (entry: SavedVersionSummary): string => `${entry.current ? 'Current · ' : ''}${new Date(entry.firstCapturedAt).toLocaleString()}${entry.kept ? ' · Kept' : ''}`;
            for (const entry of entries) { const option = document.createElement('option'); option.value = entry.versionId; option.textContent = optionText(entry); select.append(option); }
            select.value = selected.versionId; label.append(select); tools.append(label);
            select.addEventListener('change', () => { void reader.open(url, undefined, query, undefined, select.value, true); });
            const policy = document.createElement('p'); policy.className = 'field-note'; policy.textContent = `Keeps the latest ${RECENT_VERSION_LIMIT} versions plus kept versions. Imported older history starts kept; release it when ready.`; tools.append(policy);
            const actions = document.createElement('div'); actions.className = 'button-row'; tools.append(actions);
            const keep = document.createElement('button'); keep.className = 'text-button'; keep.textContent = selected.kept ? 'Release kept version' : 'Keep this version'; actions.append(keep);
            const feedback = document.createElement('p'); feedback.className = 'status-line'; feedback.setAttribute('role', 'status'); tools.append(feedback);
            keep.addEventListener('click', () => {
              keep.disabled = true;
              void sendRuntimeMessage({ type: 'UPDATE_SAVED_VERSION', url, versionId: selected.versionId, action: selected.kept ? 'release' : 'keep' }).then(() => {
                if (revision !== generation) return;
                selected.kept = !selected.kept; keep.textContent = selected.kept ? 'Release kept version' : 'Keep this version'; select.selectedOptions[0]!.textContent = optionText(selected);
                feedback.textContent = selected.kept ? 'Kept until you release or remove it.' : 'Released. Older versions may be removed on the next changed capture.';
              }).catch(error => { if (revision === generation) feedback.textContent = `Unable to update retention: ${error instanceof Error ? error.message : String(error)}`; }).finally(() => { keep.disabled = false; });
            });
            if (!selected.current) {
              const remove = document.createElement('button'); remove.className = 'text-button danger-text'; remove.textContent = 'Remove this version'; actions.append(remove);
              const confirm = document.createElement('div'); confirm.hidden = true; confirm.className = 'saved-version-confirm';
              const warning = document.createElement('p'); warning.textContent = 'Remove this earlier saved version? The current saved page stays. References to this version will no longer open.';
              const commit = document.createElement('button'); commit.className = 'secondary-button danger-text'; commit.textContent = 'Remove version';
              const cancel = document.createElement('button'); cancel.className = 'text-button'; cancel.textContent = 'Cancel';
              confirm.append(warning, commit, cancel); tools.append(confirm);
              remove.addEventListener('click', () => { confirm.hidden = false; }); cancel.addEventListener('click', () => { confirm.hidden = true; });
              commit.addEventListener('click', () => {
                commit.disabled = true; cancel.disabled = true;
                void sendRuntimeMessage({ type: 'UPDATE_SAVED_VERSION', url, versionId: selected.versionId, action: 'delete' }).then(() => { if (revision === generation) void reader.open(url, undefined, query, undefined, undefined, true); }).catch(error => { if (revision === generation) feedback.textContent = `Unable to remove version: ${error instanceof Error ? error.message : String(error)}`; }).finally(() => { commit.disabled = false; cancel.disabled = false; });
              });
            }
          } catch (error) { if (revision === generation) { loaded = false; tools.textContent = `History unavailable: ${error instanceof Error ? error.message : String(error)}`; } }
        };
        versions.addEventListener('toggle', () => { historyExpanded = versions.open; void loadHistory(); });
        if (historyExpanded) void loadHistory();
        const content = document.createElement('div'); content.className = 'saved-reader-text'; content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Saved page text'); content.tabIndex = 0;
        const match = page.match;
        let marker: HTMLElement | undefined;
        if (match?.field === 'text' && Number.isInteger(match.start) && Number.isInteger(match.end) && match.start >= 0 && match.end > match.start && match.end <= page.text.length) {
          marker = document.createElement('mark'); marker.textContent = page.text.slice(match.start, match.end); marker.tabIndex = -1;
          content.append(document.createTextNode(page.text.slice(0, match.start)), marker, document.createTextNode(page.text.slice(match.end)));
        } else content.textContent = page.text || 'No readable text was stored for this capture.';
        host.append(content);
        const parsed = new URL(page.url);
        if (['https:', 'http:'].includes(parsed.protocol)) {
          const live = document.createElement('a'); live.href = page.url; live.target = '_blank'; live.rel = 'noopener noreferrer'; live.className = 'text-button saved-reader-live'; live.textContent = 'Open live page'; host.append(live);
        }
        if (marker) { marker.focus({ preventScroll: true }); marker.scrollIntoView({ block: 'center' }); }
        else { content.focus({ preventScroll: true }); content.scrollIntoView({ block: 'nearest' }); }
        onRead?.();
      } catch (error) {
        if (revision !== generation) return;
        status.textContent = `Saved capture unavailable: ${error instanceof Error ? error.message : String(error)}`; status.dataset.variant = 'error';
      }
    }
  };
  return reader;
}
