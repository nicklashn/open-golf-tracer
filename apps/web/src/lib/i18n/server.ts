import 'server-only';
import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, getDict, isLocale, localeFromAcceptLanguage, type Locale } from './index';

export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  // No choice made yet: the browser's language (a Danish Windows/Chrome gets Danish), else English.
  return localeFromAcceptLanguage((await headers()).get('accept-language')) ?? DEFAULT_LOCALE;
}

export async function getI18n() {
  const locale = await getLocale();
  return { locale, t: getDict(locale) };
}
