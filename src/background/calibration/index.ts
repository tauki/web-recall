const CALIBRATION_KEY = 'betaCalibration';

export type CalibrationSettings = {
  wSim: number;
  wLLM: number;
};

const DEFAULT_CALIBRATION: CalibrationSettings = {
  wSim: 0.6,
  wLLM: 0.4
};

let cachedCalibration: CalibrationSettings = { ...DEFAULT_CALIBRATION };

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function sanitize(calibration: Partial<CalibrationSettings> | undefined): CalibrationSettings {
  if (!calibration) return { ...DEFAULT_CALIBRATION };
  return {
    wSim: clamp(calibration.wSim ?? DEFAULT_CALIBRATION.wSim, 0, 1),
    wLLM: clamp(calibration.wLLM ?? DEFAULT_CALIBRATION.wLLM, 0, 1)
  };
}

export function getCalibrationSnapshot(): CalibrationSettings {
  return cachedCalibration;
}

export async function getCalibration(): Promise<CalibrationSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CALIBRATION_KEY], (result: Record<string, unknown>) => {
      if (result?.[CALIBRATION_KEY] && typeof result[CALIBRATION_KEY] === 'object') {
        cachedCalibration = sanitize(result[CALIBRATION_KEY] as CalibrationSettings);
        resolve(cachedCalibration);
      } else {
        resolve(cachedCalibration);
      }
    });
  });
}

export async function updateCalibration(partial: Partial<CalibrationSettings>): Promise<CalibrationSettings> {
  cachedCalibration = sanitize({ ...cachedCalibration, ...partial });
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [CALIBRATION_KEY]: cachedCalibration }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
  return cachedCalibration;
}

try {
  chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    if (!changes[CALIBRATION_KEY] || typeof changes[CALIBRATION_KEY].newValue !== 'object') return;
    cachedCalibration = sanitize(changes[CALIBRATION_KEY].newValue as CalibrationSettings);
  });
} catch (err) {
  console.warn('[beta-calibration] unable to bind storage listener', err);
}
