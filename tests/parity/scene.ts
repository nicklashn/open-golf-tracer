/** A scene exercising every overlay element; shared by the Node and browser sides of the parity test. */
import { migrateProject, type Project } from '@golf/schema';
import shots from '../../packages/physics/test/fixtures/shot-sample.json' with { type: 'json' };

export function scene(): Project {
  const base = (id: string, type: string, x: number, y: number, props: Record<string, unknown>) => ({
    id,
    type,
    name: id,
    start: 0,
    end: 20,
    keyframes: [{ t: 0, x, y, scale: 1, rotation: 0, opacity: 1, easing: 'linear' }],
    animIn: { preset: 'none', duration: 0 },
    animOut: { preset: 'none', duration: 0 },
    hidden: false,
    locked: false,
    props,
  });
  return migrateProject({
    schemaVersion: 1,
    name: 'Parity',
    media: {
      m1: {
        id: 'm1',
        kind: 'video',
        name: 'a',
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 25,
        hdr: false,
        hasAudio: true,
        geo: null,
        place: null,
        recordedAt: null,
      },
    },
    clips: [{ id: 'c', kind: 'video', mediaId: 'm1', in: 0, out: 25, speed: 1 }],
    shots: (shots as { shots: Record<string, unknown>[] }).shots.slice(0, 2).map((s, i) => ({
      ...s,
      mediaId: 'm1',
      style:
        i === 0
          ? { preset: 'gradient', color: '#ff3b30', color2: '#ffc83d', landingMarker: true, impactFlash: true }
          : { preset: 'neon', color: '#39ff88', comet: 0.8 },
    })),
    layers: [
      base('text', 'text', 0.5, 0.1, { text: 'Parity 212 m', font: 'inter', weight: 800, size: 0.06 }),
      base('stat', 'statCard', 0.2, 0.35, { shotId: null }),
      base('shape', 'shape', 0.8, 0.8, { shape: 'ellipse', w: 0.1, h: 0.06, fill: '#ff3b30', stroke: '#ffffff' }),
      base('arrow', 'arrow', 0.75, 0.45, { dx: 0.15, dy: -0.1, bend: 0.3 }),
      base('lt', 'lowerThird', 0.3, 0.85, { title: 'Anna Jensen', subtitle: 'Hul 7 · Driver' }),
      base('hole', 'holeInfo', 0.82, 0.12, { hole: 7, par: 4, length: 365, club: 'Driver' }),
      base('dist', 'distance', 0.62, 0.62, { shotId: null, label: 'Carry' }),
    ],
  });
}

export const SIZE = { width: 960, height: 540 };
export const TIMES = [2.6, 5.2, 9.0];
