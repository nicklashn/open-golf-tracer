/**
 * Proves that the preview (Chromium) and the export (Node) draw the same overlay pixels:
 * every channel within ±1 (in practice identical – both run packages/render's rasteriser).
 */
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Surface, renderOverlay } from '@golf/render';
import { loadFonts } from '../../apps/exporter/src/canvas';
import { scene, SIZE, TIMES } from './scene';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
let bundle = '';

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [resolve(here, 'browser-entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  });
  bundle = out.outputFiles[0].text;
  await loadFonts();
});

function nodeRender(t: number): Uint8ClampedArray {
  const s = new Surface(SIZE.width, SIZE.height);
  renderOverlay(s, { project: scene(), ...SIZE, locale: 'da', images: new Map() }, t);
  return s.toRGBA({ x: 0, y: 0, ...{ w: SIZE.width, h: SIZE.height } })!.data;
}

test('rendering is deterministic', () => {
  expect(Buffer.from(nodeRender(TIMES[1])).equals(Buffer.from(nodeRender(TIMES[1])))).toBe(true);
});

for (const t of TIMES) {
  test(`browser and exporter match at t=${t}s`, async ({ page }) => {
    await page.route('http://parity.local/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/fonts/')) {
        return route.fulfill({ body: readFileSync(resolve(ROOT, 'assets/fonts/static', url.pathname.slice(7))), contentType: 'font/ttf' });
      }
      return route.fulfill({ body: `<!doctype html><html><body><script>${bundle}</script></body></html>`, contentType: 'text/html' });
    });
    await page.goto('http://parity.local/');
    const b64 = await page.evaluate((tt) => window.renderAt(tt), t);
    const browser = Buffer.from(b64, 'base64');
    const node = nodeRender(t);
    let over1 = 0;
    let maxDiff = 0;
    let drawn = 0;
    for (let i = 0; i < node.length; i++) {
      const d = Math.abs(node[i] - browser[i]);
      if (d > 1) over1++;
      if (d > maxDiff) maxDiff = d;
      if (i % 4 === 3 && node[i] > 0) drawn++;
    }
    const frac = over1 / node.length;
    console.log(`t=${t}: drawn px ${drawn}, channels off by >1: ${over1} (${(frac * 100).toFixed(4)} %), max diff ${maxDiff}`);
    mkdirSync(resolve(ROOT, 'test-results/parity'), { recursive: true });
    writeFileSync(resolve(ROOT, `test-results/parity/overlay_${t}.rgba`), Buffer.from(node));
    expect(drawn).toBeGreaterThan(1000);
    expect(maxDiff).toBeLessThanOrEqual(1);
    expect(frac).toBe(0);
  });
}
