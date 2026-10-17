import { expect, test } from '@playwright/test';
import { skipOnboarding } from './helpers';

test('make a video for me: preference in, finished project out (no AI)', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Try a sample video' }).first().click();
  await page.waitForURL('**/app/projects/**');
  await skipOnboarding(page);

  // A raw clip with shots: making the video is the main action, export comes after.
  await expect(page.getByTestId('open-auto')).toHaveClass(/bg-accent/);
  await page.getByTestId('open-auto').click();
  const dialog = page.getByTestId('auto-video');
  // One clip: nothing to pick. The format is a card; the free text adds to it.
  await expect(dialog.getByTestId('auto-clips')).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: /YouTube video/ })).toBeChecked();
  await expect(dialog.getByText('No AI', { exact: false })).toBeVisible();
  await dialog.getByText('Highlight short', { exact: true }).click();
  await dialog.getByRole('textbox').fill('only the best shots');
  await dialog.getByTestId('auto-start').click();

  // The demo has no doubts, so it runs to the end without asking.
  const done = page.getByTestId('auto-done');
  await expect(done).toBeVisible({ timeout: 90_000 });
  await expect(done.getByText('Your video is ready')).toBeVisible();
  await expect(done.getByText(/press Export/)).toBeVisible();
  const open = done.getByRole('link', { name: /^Open video/ });
  const href = await open.getAttribute('href');
  const id = href!.split('/').pop()!;
  // A highlight short: vertical, with a stat card for each of the demo's two drives.
  const made = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(made.document.format.aspect).toBe('9:16');
  expect(made.document.layers.filter((l: { type: string }) => l.type === 'statCard')).toHaveLength(2);
  await open.click();
  await page.waitForURL(`**/app/projects/${id}`);
  // The dialog closes with the old project; in the made video, export is the main action.
  await expect(page.getByTestId('auto-video')).toBeHidden();
  await expect(page.getByTestId('open-export')).toHaveClass(/bg-accent/);
});
