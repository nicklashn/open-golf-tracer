import { Surface, fonts, renderOverlay } from '@golf/render';
import { scene, SIZE } from './scene';

declare global {
  interface Window {
    renderAt: (t: number) => Promise<string>;
  }
}

const ready = fonts.loadAll(async (file) => (await fetch(`/fonts/${file}`)).arrayBuffer());

window.renderAt = async (t: number) => {
  await ready;
  const s = new Surface(SIZE.width, SIZE.height);
  renderOverlay(s, { project: scene(), width: SIZE.width, height: SIZE.height, locale: 'da', images: new Map() }, t);
  // Draw through a real canvas, as the editor does, and read the pixels back.
  const c = document.createElement('canvas');
  c.width = SIZE.width;
  c.height = SIZE.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const out = s.toRGBA({ x: 0, y: 0, w: SIZE.width, h: SIZE.height })!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), SIZE.width, SIZE.height), 0, 0);
  const data = new Uint8ClampedArray(out.data);
  let str = '';
  for (let i = 0; i < data.length; i += 0x8000) str += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(str);
};
