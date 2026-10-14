import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const path of ['/app', '/app/settings', '/does-not-exist']) {
  test(`page ${path} renders without accessibility violations`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(path === '/does-not-exist' ? 404 : 200);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).exclude('video').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
}

test('the root goes straight to the app', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
});

test('the app works on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('danish locale', async ({ page, context }) => {
  await context.addCookies([{ name: 'gt_locale', value: 'da', url: 'http://localhost:3000' }]);
  await page.goto('/app');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projekter');
});
