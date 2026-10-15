import { expect, test } from '@playwright/test';
import { skipOnboarding } from './helpers';

test('make a video for me: preference in, finished project out (no AI)', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Try a sample video' }).first().click();
  await page.waitForURL('**/app/projects/**');
  await skipOnboarding(page);

  await page.getByTestId('open-auto').click();
  const dialog = page.getByTestId('auto-video');
  await expect(dialog.getByTestId('auto-clips').getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByText('No AI', { exact: false })).toBeVisible();
  await dialog.getByRole('textbox').fill('a vertical highlight of the best shots');
  await dialog.getByTestId('auto-start').click();

  // The demo has no doubts, so it runs to the end without asking.
  const done = page.getByTestId('auto-done');
  await expect(done).toBeVisible({ timeout: 90_000 });
  await expect(done.getByText('Your video is ready')).toBeVisible();
  const href = await done.getByRole('link', { name: 'Open' }).getAttribute('href');
  const id = href!.split('/').pop()!;
  // A highlight short: vertical, with a stat card for each of the demo's two drives.
  const made = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(made.document.format.aspect).toBe('9:16');
  expect(made.document.layers.filter((l: { type: string }) => l.type === 'statCard')).toHaveLength(2);
  await done.getByRole('link', { name: 'Open' }).click();
  await page.waitForURL(`**/app/projects/${id}`);
});
