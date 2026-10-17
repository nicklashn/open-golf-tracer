/** Builds a project document for one video plus its analysis (as written by shottracer.analyze_video). */
import { migrateProject, type Project } from '@golf/schema';
import type { MediaFile } from './plan';

const SHOT_KEYS = new Set([
  'id',
  'source',
  'kind',
  'putt',
  'impactTime',
  'confidence',
  'warnings',
  'camera',
  'anchor',
  'track',
  'params',
  'rmsPx',
  'auto',
  'constraints',
  'timing',
  'slowmo',
  'style',
  'visible',
  'label',
]);

export function projectFromAnalysis(media: MediaFile, analysis: { shots?: Record<string, unknown>[] }, name = 'Projekt'): Project {
  const shots = (analysis.shots ?? []).map((s) => ({ ...Object.fromEntries(Object.entries(s).filter(([k]) => SHOT_KEYS.has(k))), mediaId: media.id }));
  return migrateProject({
    schemaVersion: 1,
    name,
    media: {
      [media.id]: {
        id: media.id,
        kind: 'video',
        name: media.path.split(/[\\/]/).pop() ?? 'video.mp4',
        width: media.width,
        height: media.height,
        fps: media.fps,
        duration: media.duration,
        hdr: media.hdr,
        hasAudio: media.hasAudio,
      },
    },
    clips: [{ id: 'c1', kind: 'video', mediaId: media.id, in: 0, out: media.duration, speed: 1, volume: 1, muted: false }],
    shots,
    format: { aspect: '16:9' },
  });
}
