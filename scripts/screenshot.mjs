import { chromium } from '@playwright/test';
const [, , url, out, w = '1200', h = '800'] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: +h } });
await p.goto(url);
await p.waitForTimeout(500);
await p.screenshot({ path: out, fullPage: true });
await b.close();
