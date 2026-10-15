/**
 * A new layer of each type, placed and styled the way the editor adds one by hand: the
 * generators use these too, so a generated video looks like one edited in the app.
 */
import { holeFacts } from '@golf/render';
import { newId, timelineDuration, type Layer, type LayerType, type Project } from '@golf/schema';

/** Layer names as the layer panel shows them (the UI's translations of the types), plus the
 *  default texts (`textDefault`, `lowerThirdDefault`, `lowerThirdSub`, `distanceLabel`). */
export type LayerNames = Readonly<Record<string, string>>;

export function layerDefaults(type: LayerType, t: LayerNames, doc: Project, time: number, locale: 'da' | 'en' = 'en'): Layer {
  const dur = timelineDuration(doc);
  const start = Math.min(time, Math.max(0, dur - 0.5));
  const end = Math.min(dur, start + 4);
  const portrait = (() => {
    const m = doc.clips[0] ? doc.media[doc.clips[0].mediaId] : null;
    const a = doc.format.aspect;
    return a === '9:16' || a === '4:5' || (a === 'original' && m ? m.height > m.width : false);
  })();
  const base = {
    id: newId('l_'),
    name: t[type] ?? type,
    start,
    end,
    keyframes: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, easing: 'easeInOut' as const }],
    animIn: { preset: 'fade' as const, duration: 0.4 },
    animOut: { preset: 'fade' as const, duration: 0.3 },
    hidden: false,
    locked: false,
  };
  const at = (x: number, y: number) => ({ ...base, keyframes: [{ ...base.keyframes[0], x, y }] });
  switch (type) {
    case 'text':
      return {
        ...at(0.5, 0.15),
        type,
        animIn: { preset: 'slideUp', duration: 0.4 },
        props: {
          text: t.textDefault,
          font: 'inter',
          weight: 800,
          size: portrait ? 0.035 : 0.06,
          color: '#ffffff',
          align: 'center',
          background: null,
          backgroundOpacity: 0.8,
          uppercase: false,
          letterSpacing: 0,
          shadow: true,
        },
      };
    case 'statCard':
      return {
        ...at(portrait ? 0.5 : 0.2, portrait ? 0.72 : 0.3),
        type,
        animIn: { preset: 'slideUp', duration: 0.45 },
        props: { shotId: null, fields: ['carry', 'apex', 'ballSpeed', 'launch'], theme: 'dark', title: '', accent: '#ff3b30', width: portrait ? 0.6 : 0.26 },
      };
    case 'shape':
      return {
        ...at(0.5, 0.5),
        type,
        props: { shape: 'rect', w: 0.2, h: 0.1, fill: '#ffffff', fillOpacity: 0.9, stroke: null, strokeWidth: 0.004, radius: 0.01 },
      };
    case 'arrow':
      return {
        ...at(0.5, 0.5),
        type,
        animIn: { preset: 'wipe', duration: 0.4 },
        props: { dx: 0.2, dy: -0.08, bend: 0.25, color: '#ffffff', width: 0.006, head: true, dashed: false },
      };
    case 'image':
      return { ...at(0.85, 0.12), type, props: { mediaId: '', w: 0.16, radius: 0 } };
    case 'lowerThird':
      return {
        ...at(portrait ? 0.5 : 0.25, portrait ? 0.86 : 0.85),
        type,
        animIn: { preset: 'wipe', duration: 0.5 },
        props: { title: t.lowerThirdDefault, subtitle: t.lowerThirdSub, accent: '#ff3b30', style: 'bar', font: 'barlow' },
      };
    case 'holeInfo':
      return {
        ...at(portrait ? 0.5 : 0.16, portrait ? 0.12 : 0.13),
        type,
        animIn: { preset: 'slideRight', duration: 0.45 },
        props: { ...holeFacts({ project: doc, locale }), unit: doc.units, accent: '#ff3b30', font: 'barlow' },
      };
    case 'distance':
      return {
        ...at(0.6, 0.4),
        type,
        animIn: { preset: 'pop', duration: 0.4 },
        props: { shotId: null, value: null, unit: doc.units, label: t.distanceLabel, color: '#ffffff', accent: '#ff3b30' },
      };
    case 'courseMap':
      return {
        ...at(portrait ? 0.76 : 0.86, portrait ? 0.7 : 0.6),
        type,
        animIn: { preset: 'slideLeft', duration: 0.45 },
        props: {
          shotId: null,
          features: [],
          landing: { x: 0, y: 150 },
          title: '',
          size: portrait ? 0.3 : 0.48,
          theme: 'dark',
          accent: '#ff3b30',
          showDistance: true,
          unit: doc.units,
          attribution: '© OpenStreetMap',
        },
      };
  }
}
