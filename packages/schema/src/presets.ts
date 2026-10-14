import { TracerStyle } from './project';

/**
 * Built-in tracer looks. Names are translated in the UI by id.
 *
 * `classic` follows the look of today's shot-tracer clips on YouTube and Shorts: the line rises
 * softly out of the ball, runs red into warm gold over the top, with a soft glow and no hard
 * white core. `tvGold` is the broadcast look (solid gold, landing marker).
 */
export const TRACER_PRESETS = {
  classic: TracerStyle.parse({ preset: 'classic', color: '#ff4520', color2: '#ffd23f', glow: 0.3, width: 4.5, fadeIn: 0.3, core: 0.3 }),
  tvGold: TracerStyle.parse({ preset: 'tvGold', color: '#ffc83d', glow: 0.7, width: 1.15, landingMarker: true, fadeIn: 0.08, core: 0.6 }),
  neon: TracerStyle.parse({ preset: 'neon', color: '#39ff88', glow: 1, width: 0.9, impactFlash: true, core: 0.8 }),
  minimalWhite: TracerStyle.parse({ preset: 'minimalWhite', color: '#ffffff', glow: 0.15, width: 0.7, ballHead: false, fadeIn: 0.1, core: 0 }),
  gradient: TracerStyle.parse({ preset: 'gradient', color: '#ff3b30', color2: '#ffc83d', glow: 0.6, width: 1.1, core: 0.8 }),
  comet: TracerStyle.parse({ preset: 'comet', color: '#ffffff', color2: '#ff3b30', glow: 0.8, comet: 0.8, afterLanding: 'fade', core: 0.8 }),
} as const;

export type TracerPresetId = keyof typeof TRACER_PRESETS;
export const TRACER_PRESET_IDS = Object.keys(TRACER_PRESETS) as TracerPresetId[];

export const DEFAULT_TRACER_STYLE = TRACER_PRESETS.classic;
