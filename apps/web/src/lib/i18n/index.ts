import da, { type Dict } from './da';
import en from './en';

export type Locale = 'da' | 'en';
export const LOCALES: Locale[] = ['da', 'en'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'gt_locale';

const dicts: Record<Locale, Dict> = { da, en };

export function getDict(locale: Locale): Dict {
  return dicts[locale] ?? en;
}

export function isLocale(v: unknown): v is Locale {
  return v === 'da' || v === 'en';
}

/** The first supported language in an Accept-Language header ("da-DK,da;q=0.9,en;q=0.8" → da), by weight. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const langs = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q[1]) : 1, i };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { lang } of langs) {
    if (isLocale(lang)) return lang;
  }
  return null;
}

/** Fills {name} placeholders. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export type { Dict };
