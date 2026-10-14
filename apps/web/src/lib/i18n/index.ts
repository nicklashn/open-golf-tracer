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

/** Fills {name} placeholders. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export type { Dict };
