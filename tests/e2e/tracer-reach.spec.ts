import { expect, test, type Page } from '@playwright/test';
import { fitThrough, shotHandles } from '../../packages/physics/src';
import { skipOnboarding } from './helpers';

/** The sample project with its first shot's flight (and auto flight) thrown far outside the
 *  picture – apex three frame heights up, landing five frame widths right – in a 9:16 crop. */
async function brokenSample(page: Page) {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Try a sample video' }).first().click();
  await page.waitForURL('**/app/projects/**');
  const id = page.url().split('/').pop()!;
  const res = await (await page.request.get(`/api/projects/${id}`)).json();
  const doc = res.document;
  const s = doc.shots[0];
  const { width: W, height: H, fps } = doc.media[s.mediaId];
  const shot = { ...s, constraints: { start: null, apex: null, landing: null, points: [], carry: null, curve: null, flightTime: null } };
  const wild = fitThrough(shot, s.anchor, { x: 0.57 * W, y: -3 * H }, { x: 5 * W, y: 0.4 * H }, { fps, longSide: Math.max(W, H) }).params;
  doc.shots[0] = { ...s, params: wild, auto: { ...s.auto, params: wild } };
  doc.format = { ...doc.format, aspect: '9:16' };
  const put = await page.request.put(`/api/projects/${id}/document`, { data: { document: doc, baseVersion: res.docVersion, force: true } });
  expect(put.ok()).toBe(true);
  await page.reload();
  await skipOnboarding(page);
  return { id, shotId: s.id as string, W, H };
}

test('a tracer far outside the picture can always be brought back and redrawn', async ({ page }, info) => {
  test.setTimeout(3 * 60_000);
  const { id, shotId } = await brokenSample(page);
  const row = page.locator(`[data-testid="shots-panel"] [data-shot="${shotId}"]`);
  await expect(row).toContainText('Check this');
  await row.click();
  await expect(page.getByTestId('shot-inspector')).toBeVisible();

  // The handles are off screen: markers at the edge of the preview, a notice and a bar.
  await expect(page.getByTestId('offscreen-apex')).toBeVisible();
  await expect(page.getByTestId('offscreen-landing')).toBeVisible();
  await expect(page.getByTestId('handle-apex')).toHaveCount(0);
  await expect(page.getByTestId('offview-notice')).toBeVisible();
  await expect(page.getByTestId('offview-bar')).toBeVisible();
  await info.attach('off-screen', { body: await page.screenshot(), contentType: 'image/png' });

  // Drag the landing marker into the picture: the real handle follows the pointer.
  const preview = (await page.getByTestId('preview-overlay').boundingBox())!;
  const m = (await page.getByTestId('offscreen-landing').boundingBox())!;
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  const target = { x: preview.x + preview.width * 0.35, y: preview.y + preview.height * 0.45 };
  for (let i = 1; i <= 8; i++) await page.mouse.move(m.x + (target.x - m.x) * (i / 8), m.y + (target.y - m.y) * (i / 8));
  await page.mouse.up();
  await expect(page.getByTestId('handle-landing')).toBeVisible();
  await expect(page.getByTestId('offscreen-landing')).toHaveCount(0);
  const h = (await page.getByTestId('handle-landing').boundingBox())!;
  expect(Math.hypot(h.x + h.width / 2 - target.x, h.y + h.height / 2 - target.y)).toBeLessThan(12);
  await info.attach('dragged-in', { body: await page.screenshot(), contentType: 'image/png' });

  // Undo, then one click on "Bring the path into view".
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('offscreen-apex')).toBeVisible();
  await page.getByTestId('offview-notice').getByRole('button', { name: 'Bring the path into view' }).click();
  await expect(page.getByTestId('offscreen-apex')).toHaveCount(0);
  await expect(page.getByTestId('handle-apex')).toBeVisible();
  await expect(page.getByTestId('handle-landing')).toBeVisible();
  await info.attach('in-view', { body: await page.screenshot(), contentType: 'image/png' });

  // Reset to auto does not throw it back out.
  await page.getByRole('button', { name: 'Reset to auto' }).click();
  await expect(page.getByTestId('handle-apex')).toBeVisible();
  await expect(page.getByTestId('offscreen-apex')).toHaveCount(0);

  // Draw the path: start, top, landing.
  await page.getByRole('button', { name: 'Draw the path' }).click();
  await expect(page.getByTestId('preview-hint')).toContainText('1/3');
  const v = (await page.getByTestId('preview-overlay').boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: v.x + 24 + (v.width - 48) * fx, y: v.y + 24 + (v.height - 48) * fy });
  const clicks = [at(0.55, 0.85), at(0.4, 0.15), at(0.25, 0.45)];
  for (const [i, c] of clicks.entries()) {
    await page.mouse.click(c.x, c.y);
    if (i < 2) await expect(page.getByTestId('preview-hint')).toContainText(`${i + 2}/3`);
  }
  await expect(page.getByTestId('preview-hint')).toHaveCount(0);
  for (const [i, k] of (['start', 'apex', 'landing'] as const).entries()) {
    const b = (await page.getByTestId(`handle-${k}`).boundingBox())!;
    expect(Math.hypot(b.x + b.width / 2 - clicks[i].x, b.y + b.height / 2 - clicks[i].y)).toBeLessThan(14);
  }
  await info.attach('drawn', { body: await page.screenshot(), contentType: 'image/png' });

  // Saved: the stored flight is in the crop.
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });
  const saved = (await (await page.request.get(`/api/projects/${id}`)).json()).document.shots.find((s: { id: string }) => s.id === shotId);
  expect(shotHandles(saved)).not.toBeNull();
  expect(saved.constraints.apex).not.toBeNull();
});
