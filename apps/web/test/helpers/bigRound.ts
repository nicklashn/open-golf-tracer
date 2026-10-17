/** A long round for editor tests and benchmarks: 10 videos, 30 clips, 60 shots, 24 graphics layers. */
import { layerDefaults } from '@golf/compose';
import { migrateProject, type Project } from '@golf/schema';
import type { MediaInfo } from '@/editor/store';

const params = [59.38, 0.557, 0.2887, 0.002126, -0.0008, 0.2177, -0.4986, 7.6239, 0.0059];

export function bigRound(opts: { videos?: number; clipsPerVideo?: number; shotsPerClip?: number; layers?: number } = {}): {
  doc: Project;
  media: MediaInfo[];
} {
  const videos = opts.videos ?? 10;
  const per = opts.clipsPerVideo ?? 3;
  const shotsPer = opts.shotsPerClip ?? 2;
  const media: MediaInfo[] = [];
  const docMedia: Record<string, unknown> = {};
  const clips: unknown[] = [];
  const shots: unknown[] = [];
  for (let v = 0; v < videos; v++) {
    const id = `m${v}`;
    const duration = 90;
    media.push({
      id,
      kind: 'video',
      name: `IMG_${1000 + v}.mov`,
      width: 1920,
      height: 1080,
      fps: 60,
      duration,
      hdr: false,
      hasAudio: true,
      status: 'ready',
      urls: { proxy: `/m/${id}.mp4`, thumbs: `/m/${id}.jpg` },
      thumbs: { count: 90, cols: 10, rows: 9, width: 160, height: 90, interval: 1 },
    });
    docMedia[id] = { id, kind: 'video', name: `IMG_${1000 + v}.mov`, width: 1920, height: 1080, fps: 60, duration, recordedAt: null };
    for (let c = 0; c < per; c++) {
      const a = c * 30 + 4;
      clips.push({ id: `c${v}_${c}`, kind: 'video', mediaId: id, in: a, out: a + 20, speed: 1, volume: 1, muted: false });
      for (let s = 0; s < shotsPer; s++) {
        const impactTime = a + 5 + s * 7;
        shots.push({
          id: `s${v}_${c}_${s}`,
          mediaId: id,
          impactTime,
          camera: { cx: 960, cy: 540 },
          anchor: { x: 900, y: 900 },
          params,
          auto: { params, anchor: { x: 900, y: 900 }, impactTime },
        });
      }
    }
  }
  let doc = migrateProject({ schemaVersion: 1, name: 'Big round', media: docMedia, clips, shots });
  const layers = [];
  const n = opts.layers ?? 24;
  for (let i = 0; i < n; i++) {
    const l = layerDefaults(i % 2 ? 'text' : 'statCard', {}, doc, (i * 25) % 590);
    layers.push({ ...l, id: `l${i}` });
  }
  doc = { ...doc, layers };
  return { doc, media };
}
