/**
 * Generates the icons and the web manifest in apps/web/public from vector sources:
 *   node scripts/make-brand.mjs
 * icon.svg, favicon.ico (16+32+48), apple-touch-icon.png, icon-192/512.png, manifest.webmanifest.
 * Rasterised with Playwright's Chromium; favicon.ico is packed by hand (PNG-in-ICO).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'apps/web/public');

// App icon: the logo mark (ball + tracer arc) on a graphite tile, readable down to 16 px.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#18181B"/>
  <path d="M10 54 C 18 30, 30 16, 43 19" fill="none" stroke="#F04438" stroke-width="6" stroke-linecap="round"/>
  <circle cx="45" cy="21" r="11" fill="#fff"/>
  <circle cx="42" cy="18.5" r="1.7" fill="#D4D4D8"/>
  <circle cx="48" cy="18.5" r="1.7" fill="#D4D4D8"/>
  <circle cx="45" cy="24" r="1.7" fill="#D4D4D8"/>
</svg>
`;

/** ICO container with embedded PNGs (supported by every current browser and Windows). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

const browser = await chromium.launch();
const page = await browser.newPage();

async function renderSvg(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

writeFileSync(join(PUB, 'icon.svg'), ICON);
for (const [file, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  writeFileSync(join(PUB, file), await renderSvg(ICON, size));
}
const small = [];
for (const size of [16, 32, 48]) small.push({ size, data: await renderSvg(ICON, size) });
writeFileSync(join(PUB, 'favicon.ico'), ico(small));

await browser.close();

writeFileSync(
  join(PUB, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'Open Golf Tracer',
      short_name: 'Open Golf Tracer',
      description: 'Shot tracer for your golf videos',
      start_url: '/app',
      display: 'standalone',
      background_color: '#111113',
      theme_color: '#111113',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log('wrote icons and manifest to apps/web/public');
