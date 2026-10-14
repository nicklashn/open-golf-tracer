import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');

/** A synthetic down-the-line shot with known truth (generated once). */
export function sampleVideo(): string {
  const out = resolve(ROOT, 'tests/out/e2e.mp4');
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true });
    const py = resolve(ROOT, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
    execFileSync(existsSync(py) ? py : 'python3', [resolve(ROOT, 'tests/make_synthetic.py'), out], { stdio: 'pipe' });
  }
  return out;
}

/** The onboarding tour can appear at any moment after the editor opens; dismiss it whenever it does. */
export async function skipOnboarding(page: Page) {
  await page.addLocatorHandler(page.getByTestId('onboarding'), async () => {
    await page.getByText('Skip', { exact: true }).click();
  });
}
