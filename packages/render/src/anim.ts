import type { Anim, Easing, Keyframe, Layer } from '@golf/schema';

export function ease(kind: Easing, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  switch (kind) {
    case 'linear':
      return x;
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3);
    case 'hold':
      return 0;
    default:
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
}

export interface Pose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** Keyframed pose at local time lt (seconds since the layer start). Easing belongs to the
 *  segment's start keyframe. */
export function poseAt(keys: readonly Keyframe[], lt: number): Pose {
  const k = keys.length > 1 ? [...keys].sort((a, b) => a.t - b.t) : keys;
  const pick = (q: Keyframe): Pose => ({ x: q.x, y: q.y, scale: q.scale, rotation: q.rotation, opacity: q.opacity });
  if (lt <= k[0].t) return pick(k[0]);
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1];
    const b = k[i];
    if (lt <= b.t) {
      const u = ease(a.easing, (lt - a.t) / Math.max(1e-6, b.t - a.t));
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        scale: a.scale + (b.scale - a.scale) * u,
        rotation: a.rotation + (b.rotation - a.rotation) * u,
        opacity: a.opacity + (b.opacity - a.opacity) * u,
      };
    }
  }
  return pick(k[k.length - 1]);
}

export interface AnimState {
  /** 0..1 progress of in/out animation (1 = fully shown). */
  p: number;
  preset: Anim['preset'];
  phase: 'in' | 'out' | 'hold';
}

export function animState(layer: Pick<Layer, 'start' | 'end' | 'animIn' | 'animOut'>, t: number): AnimState {
  const dur = layer.end - layer.start;
  const lt = t - layer.start;
  const dIn = Math.min(layer.animIn.duration, dur / 2);
  const dOut = Math.min(layer.animOut.duration, dur / 2);
  if (layer.animIn.preset !== 'none' && dIn > 0 && lt < dIn) return { p: lt / dIn, preset: layer.animIn.preset, phase: 'in' };
  if (layer.animOut.preset !== 'none' && dOut > 0 && lt > dur - dOut) return { p: (dur - lt) / dOut, preset: layer.animOut.preset, phase: 'out' };
  return { p: 1, preset: 'none', phase: 'hold' };
}

const outBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Applies the in/out animation to a pose. Returns the pose, a wipe fraction and a text reveal fraction. */
export function applyAnim(pose: Pose, a: AnimState): { pose: Pose; wipe: number; reveal: number } {
  const p = Math.min(1, Math.max(0, a.p));
  const e = ease('easeOut', p);
  const out = { ...pose };
  let wipe = 1;
  let reveal = 1;
  switch (a.preset) {
    case 'fade':
      out.opacity *= e;
      break;
    case 'slideUp':
      out.y += (1 - e) * 0.06;
      out.opacity *= e;
      break;
    case 'slideLeft':
      out.x += (1 - e) * 0.08;
      out.opacity *= e;
      break;
    case 'slideRight':
      out.x -= (1 - e) * 0.08;
      out.opacity *= e;
      break;
    case 'pop':
      out.scale *= a.phase === 'in' ? 0.5 + 0.5 * outBack(p) : 0.85 + 0.15 * e;
      out.opacity *= Math.min(1, p * 2);
      break;
    case 'typewriter':
      reveal = p;
      break;
    case 'wipe':
      wipe = e;
      break;
  }
  return { pose: out, wipe, reveal };
}
