import type { Dict } from './i18n';
import { fmt } from './i18n';

/**
 * The worker and API report job progress in plain English ("Queued", "Looking for the ball",
 * "Analysing shot 2"). This puts the known ones in the user's language; anything else (already
 * localised, e.g. the compose job's own text, or new) is shown as it is.
 */
export function jobMessage(message: string | null | undefined, t: Dict): string {
  const m = (message ?? '').trim();
  if (!m) return '';
  const T = t.jobs.messages;
  const fixed: Record<string, string> = {
    Queued: T.queued,
    Retrying: T.retrying,
    Starter: T.starting,
    Starting: T.starting,
    'Reading the video': T.probe,
    'Listening for strikes': T.audio,
    'Finding shots': T.strikes,
    'Looking for the ball': T.scan,
    'Making the preview': T.preview,
    'Tracking the shot': T.tracking,
    'Out of memory – trying again with gentler settings': T.oom,
    Done: T.done,
  };
  if (m in fixed) return fixed[m];
  const shot = /^Analysing shot (.+)$/.exec(m);
  if (shot) return fmt(T.shot, { n: shot[1] });
  const found = /^(\d+) shots found$/.exec(m);
  if (found) return found[1] === '1' ? T.oneFound : fmt(T.found, { n: found[1] });
  return m;
}
