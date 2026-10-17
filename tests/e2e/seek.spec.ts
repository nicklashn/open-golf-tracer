import { expect, test, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { sampleVideo, skipOnboarding } from './helpers';

/** Adds a video to a project the way the app's chunked upload does. */
async function uploadInto(page: Page, projectId: string, file: string) {
  const size = statSync(file).size;
  const up = await (await page.request.post('/api/uploads', { data: { filename: basename(file), size, kind: 'video', projectId } })).json();
  const bytes = readFileSync(file);
  for (let i = 0; i < up.chunks; i++)
    expect((await page.request.put(`/api/uploads/${up.id}/chunks/${i}`, { data: bytes.subarray(i * up.chunkSize, (i + 1) * up.chunkSize) })).ok()).toBe(true);
  const done = await (await page.request.post(`/api/uploads/${up.id}/complete`)).json();
  return done.media.id as string;
}

/** The video on screen in the preview: which one and where it is. */
const onScreen = (page: Page) =>
  page.evaluate(() => {
    const v = [...document.querySelectorAll<HTMLVideoElement>('video[data-media]')].find((x) => x.style.visibility === 'visible');
    return v ? { media: v.dataset.media!, t: v.currentTime, paused: v.paused } : null;
  });

/** The playhead is inside the visible part of the timeline. */
const playheadInView = (page: Page) =>
  page.evaluate(() => {
    const x = document.querySelector('[data-testid="playhead"]')!.getBoundingClientRect().x;
    const r = document.querySelector('[data-testid="timeline-scroller"]')!.getBoundingClientRect();
    return x >= r.left && x <= r.right;
  });

test('clicking a shot shows it: playhead, timeline and the preview frame, in any clip', async ({ page }, info) => {
  test.setTimeout(4 * 60_000);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Try a sample video' }).first().click();
  await page.waitForURL('**/app/projects/**');
  await skipOnboarding(page);
  const projectId = page.url().split('/').pop()!;
  const shots = page.getByTestId('shots-panel').locator('li [role=button]');
  await expect(shots).toHaveCount(2);

  // A second clip joins the round; the demo's shots then sit in a clip that is not first.
  const other = await uploadInto(page, projectId, sampleVideo());
  await expect(page.getByTestId('clip')).toHaveCount(2, { timeout: 90_000 });
  const doc = async () => (await (await page.request.get(`/api/projects/${projectId}`)).json()).document;
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });
  let d = await doc();
  if (d.clips[0].mediaId !== other) {
    await page.getByTestId('clip').first().click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });
    d = await doc();
  }
  expect(d.clips[1].mediaId).not.toBe(other);
  const demo = d.clips[1].mediaId as string;
  const own = (d.shots as { id: string; mediaId: string; impactTime: number }[]).filter((s) => s.mediaId === demo);
  expect(own).toHaveLength(2);
  const impacts = own.map((s) => s.impactTime);
  // By id: the other clip's analysis may add shots (and renumber them) while this runs.
  const row = (i: number) => page.locator(`[data-testid="shots-panel"] [data-shot="${own[i].id}"]`);

  // Zoomed in, the second shot is far outside the visible timeline.
  await page.getByTestId('timeline-scroller').hover();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom in' }).click();

  for (const [i, impact] of impacts.entries()) {
    await row(i).click();
    // The frame just before the strike of that clip, on screen; the timeline follows.
    await expect.poll(async () => (await onScreen(page))?.media).toBe(demo);
    await expect.poll(async () => Math.abs((await onScreen(page))!.t - (impact - 0.6))).toBeLessThan(0.05);
    expect(await playheadInView(page)).toBe(true);
    await info.attach(`shot-${i + 1}`, { body: await page.screenshot(), contentType: 'image/png' });
  }

  // The tracer bars in the timeline do the same.
  await page.locator(`[data-testid="timeline"] button[data-shot="${own[0].id}"]`).click();
  await expect.poll(async () => Math.abs((await onScreen(page))!.t - (impacts[0] - 0.6))).toBeLessThan(0.05);

  // While playing, a click moves playback to the shot and it plays on.
  await page.getByTestId('play').click();
  await row(1).click();
  await expect.poll(async () => (await onScreen(page))!.paused).toBe(false);
  await expect.poll(async () => (await onScreen(page))!.t).toBeGreaterThan(impacts[1] - 0.6);
  expect((await onScreen(page))!.t).toBeLessThan(impacts[1] + 2);
  await page.getByTestId('play').click();

  // A shot whose clip was removed: said so, and one click puts it back.
  await page.getByTestId('clip').nth(1).click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await row(0).click();
  await expect(page.getByText('The shot is not on the timeline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Put it back' }).click();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  await expect.poll(async () => (await onScreen(page))?.media).toBe(demo);
  await expect.poll(async () => Math.abs((await onScreen(page))!.t - (impacts[0] - 0.6))).toBeLessThan(0.05);

  // The demo is a range session: the scorecard says why there are no holes.
  await page.getByRole('tab', { name: 'Score' }).click();
  await expect(page.getByTestId('score-empty')).toBeVisible();
});
