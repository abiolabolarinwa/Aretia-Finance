/** Light / dark choice for the wallet app: the saved choice if there is one, else the operating system's. */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'aretia-theme';

export const parseTheme = (v: unknown): Theme | null => (v === 'light' || v === 'dark' ? v : null);

export function savedTheme(): Theme | null {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0e0c24' : '#ffffff');
}

/** Wires the header button. The page's <head> has already applied the theme, so there is no flash. */
export function initThemeToggle(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]');
  if (buttons.length === 0) return;
  applyTheme(savedTheme() ?? systemTheme());
  const label = (): void => {
    const dark = currentTheme() === 'dark';
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(dark));
      b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  };
  label();
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Private mode or blocked storage: the choice lasts for this visit only.
      }
      label();
    });
  }
  // Until the visitor chooses, the page follows the system if it changes.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (savedTheme() === null) {
        applyTheme(systemTheme());
        label();
      }
    });
  } catch {
    // Older browsers without MediaQueryList events keep the theme they loaded with.
  }
}
