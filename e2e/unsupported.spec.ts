import { expect, test } from '@playwright/test';

test('能力缺失时显示 UNSUPPORTED', async ({ browser }) => {
  const context = await browser.newContext({
    // 禁用 JS 能力对象之一不易直接模拟；改用 init script 删除 caches。
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'caches', { value: undefined, configurable: true });
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('unsupported')).toBeVisible();
  await expect(page.locator('body')).toContainText('UNSUPPORTED');
  await expect(page.getByTestId('unsupported-reason')).toContainText('Cache Storage');
  await context.close();
});
