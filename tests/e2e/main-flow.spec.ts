import { expect, test } from '@playwright/test';
import { statSync } from 'node:fs';
import { sampleVideo, skipOnboarding } from './helpers';

test.describe.configure({ mode: 'serial' });

test('open app → upload → analysis → fix tracer → add text → export → download', async ({ page }) => {
  test.setTimeout(6 * 60_000);

  // No sign-up: the app opens straight away.
  await page.goto('/app');
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: /Upload videos|Choose videos/ })
    .first()
    .click();
  await (await chooser).setFiles(sampleVideo());
  await page.waitForURL('**/app/projects/**', { timeout: 60_000 });
  await skipOnboarding(page);

  // Analysis finds the shot and it appears while the editor is open.
  const shot = page.getByTestId('shots-panel').getByText('Shot 1', { exact: true });
  await expect(shot).toBeVisible({ timeout: 180_000 });
  await shot.click();
  await expect(page.getByTestId('shot-inspector')).toBeVisible();

  // Drag the landing handle: the flight refits and the change is saved and undoable.
  const landing = page.getByTestId('handle-landing');
  await expect(landing).toBeVisible();
  const box = (await landing.boundingBox())!;
  const carryBefore = await page.getByTestId('shot-inspector').locator('dd').first().textContent();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 3);
  await page.mouse.up();
  await expect.poll(async () => page.getByTestId('shot-inspector').locator('dd').first().textContent(), { timeout: 15_000 }).not.toBe(carryBefore);
  await expect(page.getByTestId('save-state')).toHaveText(/saved/, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => page.getByTestId('shot-inspector').locator('dd').first().textContent()).toBe(carryBefore);
  await page.getByRole('button', { name: 'Redo' }).click();

  // Add a text layer and change its text.
  await page.getByRole('tab', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text' }).click();
  await expect(page.getByTestId('layer-inspector')).toBeVisible();
  const text = page.getByTestId('layer-inspector').getByRole('textbox', { name: 'Text' });
  await text.fill('First drive of the year');
  await expect(page.getByTestId('save-state')).toHaveText(/saved/, { timeout: 15_000 });

  // Export and download.
  await page.getByTestId('open-export').click();
  await page.getByRole('radio', { name: /Original/ }).click();
  await page.getByTestId('start-export').click();
  const status = page.getByTestId('export-status');
  await expect(status.getByText('Your video is ready')).toBeVisible({ timeout: 180_000 });
  // Where the file goes, and a way to watch it and find it again.
  await expect(status.getByTestId('export-saved-to')).toContainText('Downloads folder');
  await expect(status.getByRole('link', { name: 'Play' })).toBeVisible();
  await expect(status.getByRole('link', { name: 'My videos' })).toHaveAttribute('href', '/app/exports');
  const download = page.waitForEvent('download');
  await status.getByRole('link', { name: 'Download' }).click();
  const file = await (await download).path();
  expect(statSync(file!).size).toBeGreaterThan(50_000);
});
