export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_COOKIE = 'gt_theme';

export function readThemeCookie(v: string | undefined): ThemePref {
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** Inline script: resolves "system" before first paint so the app never flashes. */
export function themeScript(targetId: string, pref: ThemePref): string {
  return `(function(){var el=document.getElementById(${JSON.stringify(targetId)});if(!el)return;var p=${JSON.stringify(pref)};var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);el.classList.toggle('dark',d);})();`;
}

export function setThemeCookie(p: ThemePref): void {
  document.cookie = `${THEME_COOKIE}=${p}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
