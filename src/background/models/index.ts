const MODEL_SETTINGS_KEY = 'betaModelSettings';

export type ModelSettings = {
  chatModel: string | null;
};

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  chatModel: null
};

function readModelSettings(): Promise<ModelSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([MODEL_SETTINGS_KEY], (result: Record<string, unknown>) => {
      const payload = result?.[MODEL_SETTINGS_KEY];
      if (payload && typeof payload === 'object') {
        resolve({
          ...(payload as Record<string, unknown>),
          chatModel: typeof (payload as ModelSettings).chatModel === 'string' ? (payload as ModelSettings).chatModel : null
        });
        return;
      }
      resolve({ ...DEFAULT_MODEL_SETTINGS });
    });
  });
}

function broadcastModelSettings(settings: ModelSettings): void {
  try {
    chrome.runtime.sendMessage({ type: 'MODEL_SETTINGS_UPDATED', settings });
  } catch (err) {
    console.warn('[beta-background:models] broadcast failed', err);
  }
}

export async function getModelSettings(): Promise<ModelSettings> {
  return readModelSettings();
}

export async function updateModelSettings(partial: Partial<ModelSettings>): Promise<ModelSettings> {
  const current = await readModelSettings();
  const next: ModelSettings = {
    ...current,
    chatModel: typeof partial.chatModel === 'string' && partial.chatModel.trim() ? partial.chatModel.trim() : current.chatModel
  };
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [MODEL_SETTINGS_KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
  broadcastModelSettings(next);
  return next;
}
