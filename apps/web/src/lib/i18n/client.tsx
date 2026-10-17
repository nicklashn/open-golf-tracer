'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LOCALE_COOKIE, fmt, getDict, type Dict, type Locale } from './index';

interface Ctx {
  locale: Locale;
  t: Dict;
  f: typeof fmt;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();
  const setLocale = useCallback(
    (l: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
      document.documentElement.lang = l;
      router.refresh();
    },
    [router],
  );
  const value = useMemo(() => ({ locale, t: getDict(locale), f: fmt, setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n uden I18nProvider');
  return c;
}

/** The locale where a provider exists (generic controls also render without one, in tests). */
export function useOptionalLocale(): Locale | null {
  return useContext(I18nContext)?.locale ?? null;
}
