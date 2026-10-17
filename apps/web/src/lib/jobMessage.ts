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
    // Exports (apps/exporter/src/run.ts, plan.ts and main.ts).
    'Preparing graphics': T.exportPrepare,
    Exporting: T.exportRender,
    'Mixing the sound': T.exportAudio,
    'Finishing the video': T.exportFinish,
    'Canceled by the user': T.canceled,
    'The project has no clips': T.noClips,
    'The video is missing': T.missingVideo,
    'The video is too short to export': T.tooShort,
  };
  if (m in fixed) return fixed[m];
  if (/^Clip \d+ is missing its video$/.test(m)) return T.missingVideo;
  // ffmpeg's own error text is for the log, not for the user.
  if (m.startsWith('ffmpeg failed')) return T.exportFailed;
  const shot = /^Analysing shot (.+)$/.exec(m);
  if (shot) return fmt(T.shot, { n: shot[1] });
  const found = /^(\d+) shots found$/.exec(m);
  if (found) return found[1] === '1' ? T.oneFound : fmt(T.found, { n: found[1] });
  return m;
}
