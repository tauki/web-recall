import { createCaptureQueue } from './capture/index';
import { configureEmbeddings } from './embeddings/index';
import { initStorage } from './storage/index';
import { orchestrateLifecycle } from './orchestration/index';
import { getSettings, updateSettings } from './settings/index';

type ContextMenuClickInfo = {
  menuItemId?: string | number;
};

type TabLike = {
  id?: number | null;
  windowId?: number;
};

type SidePanelVisibilityEvent = {
  windowId?: number;
};

console.info('[beta-background] Initialising service worker');

initStorage();
configureEmbeddings();
orchestrateLifecycle();

const captureQueue = createCaptureQueue();

captureQueue.bindRuntimeListener();

const openPanelWindows = new Set<number>();
let sidePanelListenersBound = false;

function ensureSidePanelTracking(): void {
  if (sidePanelListenersBound || !chrome.sidePanel) return;
  if (!chrome.sidePanel.onShown || !chrome.sidePanel.onHidden) return;
  try {
    chrome.sidePanel.onShown.addListener((event: SidePanelVisibilityEvent) => {
      if (typeof event.windowId === 'number') {
        openPanelWindows.add(event.windowId);
      }
    });
    chrome.sidePanel.onHidden.addListener((event: SidePanelVisibilityEvent) => {
      if (typeof event.windowId === 'number') {
        openPanelWindows.delete(event.windowId);
      }
    });
    sidePanelListenersBound = true;
  } catch (err) {
    console.warn('[beta-background] unable to bind side panel visibility listeners', err);
  }
}

async function openSidePanel(windowId?: number): Promise<void> {
  if (!chrome.sidePanel) return;
  ensureSidePanelTracking();
  const targetWindow = typeof windowId === 'number' ? windowId : chrome.windows.WINDOW_ID_CURRENT;
  await chrome.sidePanel.open({ windowId: targetWindow });
  openPanelWindows.add(targetWindow);
}

async function closeSidePanel(windowId?: number): Promise<void> {
  if (!chrome.sidePanel) return;
  ensureSidePanelTracking();
  const targetWindow = typeof windowId === 'number' ? windowId : chrome.windows.WINDOW_ID_CURRENT;
  await chrome.sidePanel.close({ windowId: targetWindow });
  openPanelWindows.delete(targetWindow);
}

async function toggleSidePanel(windowId?: number): Promise<void> {
  if (!chrome.sidePanel) return;
  ensureSidePanelTracking();
  const targetWindow = typeof windowId === 'number' ? windowId : chrome.windows.WINDOW_ID_CURRENT;
  if (openPanelWindows.has(targetWindow)) {
    await closeSidePanel(targetWindow);
  } else {
    await openSidePanel(targetWindow);
  }
}

function sendForceCaptureToTab(tabId?: number | null): void {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: 'FORCE_CAPTURE' }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn('[beta-background] force capture failed', err);
      }
    });
  } catch (err) {
    console.warn('[beta-background] force capture failed', err);
  }
}

function setupContextMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    try {
      chrome.contextMenus.create({ id: 'wr_open_panel', title: 'Open Web Recall', contexts: ['action', 'page'] });
      chrome.contextMenus.create({ id: 'wr_capture_now', title: 'Capture this page now', contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'wr_toggle_pause', title: 'Pause capture', contexts: ['action'] });
    } catch (err) {
      console.warn('[beta-background] context menu creation failed', err);
    }
  });
  chrome.contextMenus.onClicked.addListener(async (info: ContextMenuClickInfo, tab: TabLike | undefined) => {
    if (info.menuItemId === 'wr_open_panel') {
      try {
        const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        await openSidePanel(windowId);
      } catch (err) {
        console.warn('[beta-background] failed to open side panel', err);
      }
      return;
    }
    if (info.menuItemId === 'wr_capture_now') {
      sendForceCaptureToTab(tab?.id);
      return;
    }
    if (info.menuItemId === 'wr_toggle_pause') {
      try {
        const current = await getSettings();
        const nextPaused = !current.paused;
        await updateSettings({ paused: nextPaused });
        chrome.contextMenus.update('wr_toggle_pause', {
          title: nextPaused ? 'Resume capture' : 'Pause capture'
        });
      } catch (err) {
        console.warn('[beta-background] toggle pause failed', err);
      }
    }
  });
}

function setupCommands(): void {
  if (!chrome.commands) return;
  chrome.commands.onCommand.addListener(async (command: string) => {
    if (command === 'open-side-panel') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        await toggleSidePanel(windowId);
      } catch (err) {
        console.warn('[beta-background] command open-side-panel failed', err);
      }
    }
    if (command === 'capture-this-page') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendForceCaptureToTab(tab?.id);
    }
  });
}

function setupActionToggle(): void {
  if (!chrome.action || !chrome.sidePanel) return;
  chrome.action.onClicked.addListener(async (tab: TabLike | undefined) => {
    const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    try {
      await toggleSidePanel(windowId);
    } catch (err) {
      console.warn('[beta-background] action toggle failed', err);
    }
  });
}

setupContextMenus();
setupCommands();
setupActionToggle();

self.addEventListener('install', () => {
  console.info('[beta-background] installed');
});

self.addEventListener('activate', () => {
  console.info('[beta-background] activated');
});
