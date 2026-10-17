import { CHATGPT_USAGE_URL, parseAiError } from '@golf/compose';
import type { Dict } from './i18n';
import { fmt } from './i18n';

/**
 * A job's error in the user's language. The exporter reports AI failures as a code with the
 * facts to fill in (see `aiErrorJson` in @golf/compose); anything else is shown as it is.
 * `limit` says whether to offer the link to ChatGPT's usage settings.
 */
export function aiErrorText(error: string | null | undefined, t: Dict): { text: string; limit: boolean } {
  const e = parseAiError(error);
  if (!e) return { text: error ?? '', limit: !!error?.includes(CHATGPT_USAGE_URL) };
  const T = t.aiErrors;
  const v = {
    what: e.what ?? 'AI',
    model: e.model ?? '',
    status: e.status ?? '',
    seconds: e.seconds ?? '',
    origin: e.origin ?? '',
    max: e.max ?? '',
  };
  const pick = (group: Record<string, string>) => fmt(group[e.reason ?? ''] ?? group.other, v);
  let text: string;
  switch (e.code) {
    case 'config':
      text = pick(T.config);
      break;
    case 'network':
      text = pick(T.network);
      break;
    case 'auth':
      text = pick(T.auth);
      break;
    case 'model':
      text = pick(T.model);
      break;
    case 'http':
      text = pick(T.http);
      break;
    case 'refused':
      text = fmt(T.refused, v);
      break;
    case 'limit':
      text = fmt(T.limit, v);
      break;
    case 'vision':
      text = fmt(T.vision, v);
      break;
    case 'budget':
      text = fmt(T.budget, v);
      break;
    default:
      text = T.invalid;
  }
  // The provider's own words (English) help when the code alone does not say enough.
  const detail = e.detail && (e.code === 'http' || e.code === 'model') ? ` ${fmt(T.detail, { detail: e.detail })}` : '';
  return { text: text + detail, limit: e.code === 'limit' };
}
