'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMe } from '@/lib/me';
import { setThemeCookie, themeScript, type ThemePref } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { createContext, useContext } from 'react';

const ThemeCtx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({ pref: 'system', setPref: () => undefined });
export const useTheme = () => useContext(ThemeCtx);

/** Local user settings + theme for everything under /app. The editor forces dark on its own subtree. */
export function AppRoot({ themePref, children }: { themePref: ThemePref; children: ReactNode }) {
  const { load } = useMe();
  const [pref, setPrefState] = useState(themePref);
  const [dark, setDark] = useState(themePref === 'dark');

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setDark(pref === 'dark' || (pref === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);

  const setPref = (p: ThemePref) => {
    setThemeCookie(p);
    setPrefState(p);
  };

  return (
    <ThemeCtx.Provider value={{ pref, setPref }}>
      <div id="app-root" className={cn('min-h-screen bg-bg text-fg', dark && 'dark')}>
        <script dangerouslySetInnerHTML={{ __html: themeScript('app-root', themePref) }} />
        {children}
      </div>
    </ThemeCtx.Provider>
  );
}
