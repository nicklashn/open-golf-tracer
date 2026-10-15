/**
 * A short of one shot: vertical, trimmed around the swing and the flight, slow motion through
 * impact, framed on the ball.
 */
import { shotHandles } from '@golf/physics';
import { relayoutTemplate, shotStats } from '@golf/render';
import { migrateProject, newId, type Clip, type Project, type ReframeKey, type Shot } from '@golf/schema';

const BEFORE = 2.2;
const AFTER_LAND = 1.2;
const SLOW = 0.4;

export function shortFor(doc: Project, shot: Shot, name: string, locale: 'da' | 'en' = 'en'): Project {
  const media = doc.media[shot.mediaId];
  const st = shotStats(shot);
  const impact = shot.impactTime + shot.timing.launchOffset;
  const flight = ((st?.flightTimeS ?? 4) / shot.timing.speed) * shot.slowmo;
  const a = Math.max(0, impact - BEFORE);
  const b = Math.min(media?.duration ?? impact + flight + AFTER_LAND, impact + flight + AFTER_LAND);
  const slowEnd = Math.min(b, impact + Math.min(1.2, flight * 0.3));
  const slowStart = Math.max(a, impact - 0.25);
  const clips: Clip[] = [];
  const v = (from: number, to: number, speed = 1): Clip => ({
    id: newId('c_'),
    kind: 'video',
    mediaId: shot.mediaId,
    in: from,
    out: to,
    speed,
    volume: 1,
    muted: false,
  });
  if (slowStart > a + 0.05) clips.push(v(a, slowStart));
  clips.push(v(slowStart, slowEnd, SLOW));
  if (b > slowEnd + 0.05) clips.push(v(slowEnd, b));
  // Freeze on the last frame while the ball lands if the video ends early.
  const landSource = impact + flight;
  if (media && landSource > media.duration - 0.05)
    clips.push({
      id: newId('c_'),
      kind: 'freeze',
      mediaId: shot.mediaId,
      at: Math.max(0, media.duration - 0.05),
      duration: Math.min(8, landSource - media.duration + AFTER_LAND),
    });

  // Timeline times of launch/apex/landing in the new edit, for the framing keys.
  const toTimeline = (src: number) => {
    let t = 0;
    for (const c of clips) {
      if (c.kind === 'video') {
        if (src <= c.out) return t + Math.max(0, src - c.in) / c.speed;
        t += (c.out - c.in) / c.speed;
      } else t += c.duration;
    }
    return t;
  };
  const keys: ReframeKey[] = [];
  if (media) {
    const anchor = shot.constraints.start ?? shot.anchor;
    const h = shotHandles(shot);
    keys.push({ t: 0, cx: anchor.x / media.width, cy: Math.max(0, anchor.y / media.height - 0.1), zoom: 1 });
    keys.push({ t: toTimeline(impact + 0.1), cx: anchor.x / media.width, cy: Math.max(0, anchor.y / media.height - 0.1), zoom: 1 });
    if (h) {
      keys.push({ t: toTimeline(impact + h.apexT * shot.slowmo * 0.9), cx: h.apex.x / media.width, cy: Math.min(1, h.apex.y / media.height + 0.15), zoom: 1 });
      keys.push({ t: toTimeline(impact + h.landingT * shot.slowmo), cx: h.landing.x / media.width, cy: h.landing.y / media.height, zoom: 1 });
    }
  }
  const short = migrateProject({
    ...doc,
    name,
    clips,
    shots: [shot],
    format: {
      aspect: '9:16',
      reframe: { mode: 'auto', keyframes: keys.map((k) => ({ ...k, cx: Math.min(1, Math.max(0, k.cx)), cy: Math.min(1, Math.max(0, k.cy)) })) },
    },
    // Graphics that referred to other shots would be wrong here; keep only shot-independent ones.
    layers: doc.layers
      .filter((l) => !('shotId' in l.props) || l.props.shotId === null || l.props.shotId === shot.id)
      .map((l) => ({ ...l, start: 0, end: 9999 })),
  });
  // Template graphics are rebuilt for the short's own timing and the 9:16 frame.
  return relayoutTemplate(doc, short, locale, true);
}
