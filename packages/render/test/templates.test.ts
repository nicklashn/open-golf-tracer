import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateProject, type Project } from '@golf/schema';
import { applyTemplate, relayoutTemplate } from '../src';

const fixture = JSON.parse(readFileSync(new URL('../../physics/test/fixtures/shot-sample.json', import.meta.url), 'utf8'));
const m = fixture.media;
const KEYS = [
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

function project(): Project {
  return migrateProject({
    schemaVersion: 1,
    name: 'T',
    media: {
      v: {
        id: 'v',
        kind: 'video',
        name: 'v.mp4',
        width: m.width,
        height: m.height,
        fps: m.fps,
        duration: m.duration,
        hdr: false,
        hasAudio: true,
        geo: null,
        place: null,
        recordedAt: null,
      },
    },
    clips: [{ id: 'c', kind: 'video', mediaId: 'v', in: 0, out: m.duration, speed: 1, volume: 1, muted: false }],
    shots: fixture.shots.map((s: Record<string, unknown>) => ({ ...Object.fromEntries(Object.entries(s).filter(([k]) => KEYS.includes(k))), mediaId: 'v' })),
    format: { aspect: '16:9' },
  });
}

describe('template layout follows the format', () => {
  it('rebuilds template layers for portrait and keeps the user’s texts', () => {
    const landscape = applyTemplate(project(), 'range', 'da');
    expect(landscape.template).toBe('range');
    const card = landscape.layers.find((l) => l.type === 'statCard')!;
    expect(card.type === 'statCard' && card.props.width).toBe(0.26);

    // The user retitles the lower third, then switches to 9:16.
    const edited: Project = {
      ...landscape,
      layers: landscape.layers.map((l) => (l.type === 'lowerThird' ? { ...l, props: { ...l.props, title: 'Min drive' } } : l)),
    };
    const portrait = relayoutTemplate(edited, { ...edited, format: { ...edited.format, aspect: '9:16' } }, 'da');
    const pCard = portrait.layers.find((l) => l.type === 'statCard')!;
    expect(pCard.type === 'statCard' && pCard.props.width).toBe(0.62);
    expect(pCard.keyframes[0].x).toBe(0.5);
    const lt = portrait.layers.find((l) => l.type === 'lowerThird')!;
    expect(lt.type === 'lowerThird' && lt.props.title).toBe('Min drive');
    expect(portrait.layers.length).toBe(landscape.layers.length);
  });

  it('leaves the project alone without an orientation change or template', () => {
    const p = applyTemplate(project(), 'range', 'da');
    const square = { ...p, format: { ...p.format, aspect: '16:9' as const } };
    expect(relayoutTemplate(p, square, 'da')).toBe(square);
    const plain = project();
    const tall = { ...plain, format: { ...plain.format, aspect: '9:16' as const } };
    expect(relayoutTemplate(plain, tall, 'da')).toBe(tall);
  });
});
