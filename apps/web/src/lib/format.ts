import type { Locale } from './i18n';

const loc = (l: Locale) => (l === 'da' ? 'da-DK' : 'en-GB');

export function bytes(n: number, l: Locale): string {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toLocaleString(loc(l), { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

export function timecode(sec: number, fps = 30, withFrames = false): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const base = `${m}:${ss.toString().padStart(2, '0')}`;
  if (!withFrames) return `${base}.${Math.floor((s % 1) * 10)}`;
  const f = Math.floor((s % 1) * fps + 1e-6);
  return `${base}:${f.toString().padStart(2, '0')}`;
}

export function duration(sec: number): string {
  const s = Math.round(sec);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function relativeTime(iso: string, l: Locale): string {
  const d = new Date(iso).getTime();
  const diff = (d - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(loc(l), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(loc(l), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function date(iso: string, l: Locale): string {
  return new Date(iso).toLocaleDateString(loc(l), { day: 'numeric', month: 'long', year: 'numeric' });
}

export function number(n: number, l: Locale, digits = 0): string {
  return n.toLocaleString(loc(l), { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
