export type ThemeChoice = 'light' | 'dark' | 'system';

let stopSystemThemeListener: (() => void) | null = null;

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return choice;
}

export function applyTheme(theme: ThemeChoice): void {
  document.documentElement.dataset.themeChoice = theme;
  document.documentElement.dataset.theme = resolveTheme(theme);
}

export function bindSystemThemeListener(): () => void {
  if (stopSystemThemeListener) {
    return stopSystemThemeListener;
  }
  if (!window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (): void => {
    if (document.documentElement.dataset.themeChoice === 'system') {
      applyTheme('system');
    }
  };
  const wrapCleanup = (cleanup: () => void): (() => void) => {
    return () => {
      cleanup();
      stopSystemThemeListener = null;
    };
  };
  try {
    media.addEventListener('change', handleChange);
    stopSystemThemeListener = wrapCleanup(() => media.removeEventListener('change', handleChange));
  } catch {
    media.addListener(handleChange);
    stopSystemThemeListener = wrapCleanup(() => media.removeListener(handleChange));
  }
  return stopSystemThemeListener;
}
