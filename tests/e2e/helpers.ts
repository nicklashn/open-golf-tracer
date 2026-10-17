import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

/** A synthetic down-the-line shot with known truth (generated once; parallel workers each write
 *  their own copy and rename it into place, the video last, so none reads a half-written file). */
export function sampleVideo(): string {
  const out = resolve(ROOT, 'tests/out/e2e.mp4');
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true });
    const py = resolve(ROOT, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    const tmp = resolve(ROOT, `tests/out/e2e.${process.pid}.mp4`);
    execFileSync(existsSync(py) ? py : 'python3', [resolve(ROOT, 'tests/make_synthetic.py'), tmp], { stdio: 'pipe' });
    for (const ext of ['.truth.json', '.wav', '.mp4']) {
      const from = tmp.replace(/\.mp4$/, ext);
      if (existsSync(from)) renameSync(from, out.replace(/\.mp4$/, ext));
    }
  }
  return out;
}

/** The onboarding tour can appear at any moment after the editor opens; dismiss it whenever it does. */
export async function skipOnboarding(page: Page) {
  await page.addLocatorHandler(page.getByTestId('onboarding'), async () => {
    await page.getByText('Skip', { exact: true }).click();
  });
}
