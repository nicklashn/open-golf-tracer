import { describe, expect, it } from 'vitest';
import { localeFromAcceptLanguage } from '../src/lib/i18n';

describe('first-visit language', () => {
  it('follows the browser: a Danish browser gets Danish', () => {
    expect(localeFromAcceptLanguage('da-DK,da;q=0.9,en-US;q=0.8,en;q=0.7')).toBe('da');
    expect(localeFromAcceptLanguage('en-GB,en;q=0.9')).toBe('en');
  });

  it('goes by weight and skips languages the app does not have', () => {
    expect(localeFromAcceptLanguage('de-DE,de;q=0.9,da;q=0.8,en;q=0.5')).toBe('da');
    expect(localeFromAcceptLanguage('en;q=0.4,da;q=0.6')).toBe('da');
    expect(localeFromAcceptLanguage('de,fr')).toBeNull();
    expect(localeFromAcceptLanguage('')).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });
});
