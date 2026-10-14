import { Layer } from '@golf/schema';
import { describe, expect, it } from 'vitest';
import { Painter, Surface, drawLayer, type LayerEnv } from '../src';

const layer = Layer.parse({
  id: 'map',
  start: 0,
  end: 10,
  type: 'courseMap',
  keyframes: [{ t: 0, x: 0.5, y: 0.5 }],
  animIn: { preset: 'none', duration: 0 },
  animOut: { preset: 'none', duration: 0 },
  props: {
    features: [{ k: 'green', p: [-15, 85, 15, 85, 15, 115, -15, 115] }],
    landing: { x: 0, y: 100 },
    showDistance: false,
    attribution: '',
    size: 0.9,
  },
});

function render(progress: number) {
  const W = 400;
  const H = 400;
  const s = new Surface(W, H);
  const env: LayerEnv = { width: W, height: H, locale: 'da', units: 'm', images: new Map(), shotStats: () => null, flightProgress: () => progress };
  drawLayer(new Painter(s), layer, 1, env);
  const px = s.toRGBA({ x: 0, y: 0, w: W, h: H })!.data;
  return (x: number, y: number) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
}

describe('course map layer', () => {
  // Card 360 px high centred in 400 px; the map spans the shot bottom-to-top along x = 200.
  it('draws the green and, once landed, the shot in the accent colour up the middle', () => {
    const at = render(1);
    const greenish = at(230, 120);
    expect(greenish[1]).toBeGreaterThan(greenish[0]); // course colours are green
    const mid = at(200, 200);
    expect(mid[0]).toBeGreaterThan(200); // #ff3b30 line
    expect(mid[1]).toBeLessThan(120);
  });

  it('has not drawn the solid line near the landing before the ball gets there', () => {
    const early = render(0.2)(200, 150);
    expect(early[0] > 200 && early[1] < 120).toBe(false);
  });
});
