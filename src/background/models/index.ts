const MODEL_SETTINGS_KEY = 'betaModelSettings';

export type ModelSettings = {
  chatModel: string | null;
  summaryModel: string | null;
};

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  chatModel: null,
  summaryModel: null
};

function readModelSettings(): Promise<ModelSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([MODEL_SETTINGS_KEY], (result: Record<string, unknown>) => {
      const payload = result?.[MODEL_SETTINGS_KEY];
      if (payload && typeof payload === 'object') {
        resolve({
          chatModel: typeof (payload as ModelSettings).chatModel === 'string' ? (payload as ModelSettings).chatModel : null,
          summaryModel: typeof (payload as ModelSettings).summaryModel === 'string' ? (payload as ModelSettings).summaryModel : null
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
    chatModel: typeof partial.chatModel === 'string' && partial.chatModel.trim() ? partial.chatModel.trim() : current.chatModel,
    summaryModel: typeof partial.summaryModel === 'string' && partial.summaryModel.trim() ? partial.summaryModel.trim() : current.summaryModel
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
