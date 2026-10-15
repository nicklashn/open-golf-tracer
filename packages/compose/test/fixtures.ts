/** Test projects for the generators: the bundled demo (as the API creates it) and a round of two clips. */
import { readFileSync } from 'node:fs';
import { migrateProject, type Project } from '@golf/schema';

const SHOT_KEYS = [
  'id',
  'source',
  'kind',
  'impactTime',
  'confidence',
  'warnings',
  'camera',
  'anchor',
  'track',
  'params',
  'rmsPx',
  'auto',
  'slowmo',
  'visible',
  'label',
];

/** The demo project as `create_demo_project` builds it: one landscape clip, two drives. */
export function demoProject(): Project {
  const analysis = JSON.parse(readFileSync(new URL('../../../assets/demo/demo.analysis.json', import.meta.url), 'utf8'));
  const m = analysis.media;
  return migrateProject({
    schemaVersion: 1,
    name: 'Example: drive at the range',
    media: { med_demo: { id: 'med_demo', kind: 'video', name: 'demo.mp4', ...m, recordedAt: null } },
    clips: [{ id: 'clip_demo', kind: 'video', mediaId: 'med_demo', in: 0, out: m.duration, speed: 1, volume: 1, muted: false }],
    shots: analysis.shots.map((s: Record<string, unknown>) => ({
      ...Object.fromEntries(Object.entries(s).filter(([k]) => SHOT_KEYS.includes(k))),
      id: `_demo_${s.id}`,
      mediaId: 'med_demo',
    })),
  });
}

// A real flight (6.7 s) from the physics parity fixtures, in a 1080x1920 portrait clip.
const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];
const shot = (id: string, mediaId: string, impactTime: number) => ({
  id,
  mediaId,
  impactTime,
  camera: { cx: 540, cy: 960 },
  anchor: { x: 526, y: 1472 },
  params,
  auto: { params, anchor: { x: 526, y: 1472 }, impactTime },
});
const media = (id: string, recordedAt: string, hole: string) => ({
  id,
  kind: 'video',
  name: `${id}.mov`,
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 30,
  recordedAt,
  place: { course: 'Testbane', hole, par: 4, fromTee: 0, toGreen: 300, line: [] },
});

/** Two clips of a round, on the timeline in the wrong order; hole 2 has two shots close together
 *  and a measured course map. */
export function roundProject(): Project {
  return migrateProject({
    schemaVersion: 1,
    name: 'Runde',
    media: { b: media('b', '2026-06-16T11:10:00+0200', '2'), a: media('a', '2026-06-16T10:50:00+0200', '1') },
    clips: [
      { id: 'cb', kind: 'video', mediaId: 'b', in: 0, out: 30 },
      { id: 'ca', kind: 'video', mediaId: 'a', in: 0, out: 30 },
    ],
    shots: [shot('s3', 'b', 14), shot('s1', 'a', 10), shot('s2', 'b', 5)],
    layers: [
      {
        id: 'map_s3',
        type: 'courseMap',
        name: 'Map',
        start: 0,
        end: 5,
        keyframes: [{ t: 0, x: 0.86, y: 0.6 }],
        props: { shotId: 's3', features: [{ k: 'green', p: [0, 0, 10, 0, 10, 10] }], landing: { x: 0, y: 180 }, title: 'Hul 2' },
      },
    ],
  });
}

/**
 * Runs `fn` with deterministic random bytes, so `newId` gives the same ids on every run
 * (it draws from crypto.getRandomValues).
 */
export function withStableIds<T>(fn: () => T): T {
  const c = globalThis.crypto;
  const real = c.getRandomValues.bind(c);
  let n = 0;
  c.getRandomValues = (<A extends ArrayBufferView | null>(a: A): A => {
    if (a instanceof Uint8Array) for (let i = 0; i < a.length; i++) a[i] = (n++ * 37 + 11) % 256;
    return a;
  }) as typeof c.getRandomValues;
  try {
    return fn();
  } finally {
    c.getRandomValues = real;
  }
}

/** Stable JSON for comparing documents (key order as built). */
export const stable = (p: unknown) => JSON.parse(JSON.stringify(p));
