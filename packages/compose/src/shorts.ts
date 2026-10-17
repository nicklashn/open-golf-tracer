/**
 * A short of one shot: vertical, trimmed around the swing and the flight, slow motion through
 * impact, framed on the ball.
 */
import { shotHandles } from '@golf/physics';
import { relayoutTemplate, shotStats } from '@golf/render';
import { migrateProject, newId, timelineDuration, type Clip, type Project, type ReframeKey, type Shot } from '@golf/schema';
import { cleanSpan, dipToBlack, type Span } from './clean';

const BEFORE = 2.2;
const AFTER_LAND = 1.2;
/** After the landing for shots analysed before clean windows (`shot.clean`): a little less. */
const AFTER_LAND_UNSURE = 0.9;
const SLOW = 0.4;

/** Source seconds of a shot's short: launch, landing and the cut [a, b] inside its clean window. */
export function shortSpan(doc: Project, shot: Shot): Span & { impact: number; flight: number } {
  const media = doc.media[shot.mediaId];
  const st = shotStats(shot);
  const impact = shot.impactTime + shot.timing.launchOffset;
  const flight = ((st?.flightTimeS ?? 4) / shot.timing.speed) * shot.slowmo;
  const after = shot.clean ? AFTER_LAND : AFTER_LAND_UNSURE;
  const end = impact + flight + after;
  return { impact, flight, ...cleanSpan(shot, Math.max(0, impact - BEFORE), Math.min(media?.duration ?? end, end), impact, impact + flight) };
}

export function shortFor(doc: Project, shot: Shot, name: string, locale: 'da' | 'en' = 'en'): Project {
  const media = doc.media[shot.mediaId];
  const { impact, flight, a, b, forced } = shortSpan(doc, shot);
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
  const out = relayoutTemplate(doc, short, locale, true);
  // Cut short by the clean window: fade out rather than stop on whatever came next.
  return forced ? migrateProject({ ...out, layers: [...out.layers, dipToBlack(out, timelineDuration(out), true)] }) : out;
}

/** Seconds a putt rolls when the analysis gave no end. */
const PUTT_ROLL_S = 4;
/** Seconds kept before a putt's stroke (the backswing) ... */
export const PUTT_LEAD_S = 0.7;
/** ... and after its ball stops or drops. */
export const PUTT_TAIL_S = 1;

/** Source seconds when a putt's ball stopped or dropped. */
export function puttEnd(putt: Shot): number {
  return Math.max(putt.impactTime, putt.putt?.end ?? putt.impactTime + PUTT_ROLL_S * putt.slowmo);
}

/** A short of one putt: vertical, from just before the stroke to a second after the ball stops, no tracer. */
export function puttShort(doc: Project, putt: Shot, name: string): Project {
  const media = doc.media[putt.mediaId];
  const { a, b } = cleanSpan(
    putt,
    Math.max(0, putt.impactTime - PUTT_LEAD_S * putt.slowmo),
    Math.min(media?.duration ?? Infinity, puttEnd(putt) + PUTT_TAIL_S * putt.slowmo),
    putt.impactTime,
    puttEnd(putt),
  );
  const clips: Clip[] = [{ id: newId('c_'), kind: 'video', mediaId: putt.mediaId, in: a, out: Math.max(b, a + 0.5), speed: 1, volume: 1, muted: false }];
  // Framed on the ball at address, then where it was last seen.
  const keys: ReframeKey[] = [];
  if (media) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const n = putt.track.u.length;
    const end = n ? { x: putt.track.u[n - 1], y: putt.track.v[n - 1] } : putt.anchor;
    keys.push({ t: 0, cx: clamp(putt.anchor.x / media.width), cy: clamp(putt.anchor.y / media.height), zoom: 1 });
    keys.push({ t: Math.max(0.1, b - a), cx: clamp(end.x / media.width), cy: clamp(end.y / media.height), zoom: 1 });
  }
  return migrateProject({
    ...doc,
    name,
    clips,
    shots: [putt],
    format: { aspect: '9:16', reframe: { mode: 'auto', keyframes: keys } },
    layers: [],
  });
}
