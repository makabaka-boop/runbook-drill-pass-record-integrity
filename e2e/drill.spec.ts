import { expect, test } from '@playwright/test';

const installV1 = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await page.getByTestId('install-1.0.0').click();
  await expect(page.getByTestId('current-version')).toContainText('1.0.0');
};

test.describe('离线演练', () => {
  test.beforeEach(async ({ page }) => {
    await installV1(page);
    await page.getByTestId('tab-drill').click();
  });

  test('搜索当前版条目、依序勾选，得到绑定版本的通过结论', async ({ page }) => {
    await page.getByTestId('fault-search').fill('UPS');
    await expect(page.getByTestId('fault-v1-ups-overload')).toBeVisible();
    await expect(page.getByTestId('fault-v1-pdu-trip')).toHaveCount(0);

    await page.getByTestId('fault-v1-ups-overload').click();
    const actions = page.getByTestId('action-list').locator('li');
    await expect(actions).toHaveCount(4);

    // 第二步在第一步完成前禁用
    await expect(page.getByTestId('action-v1-ups-overload-1')).toBeDisabled();
    await page.getByTestId('action-v1-ups-overload-0').click();
    await expect(page.getByTestId('action-v1-ups-overload-1')).toBeEnabled();
    await page.getByTestId('action-v1-ups-overload-1').click();
    await page.getByTestId('action-v1-ups-overload-2').click();
    await page.getByTestId('action-v1-ups-overload-3').click();

    const pass = page.getByTestId('pass-box');
    await expect(pass).toBeVisible();
    await expect(pass).toContainText('绑定版本 1.0.0');
    await expect(page.getByTestId('pass-code')).toContainText('PASS-1.0.0-');
  });

  test('切换到新版会终止未完成演练；完成的演练结论带版本标识', async ({ page }) => {
    // v1 做两步（未完成）
    await page.getByTestId('fault-v1-pdu-trip').click();
    await page.getByTestId('action-v1-pdu-trip-0').click();

    // 安装并激活 v2
    await page.getByTestId('tab-steps').click();
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('switch-notice')).toContainText('未完成演练已终止');

    await page.getByTestId('tab-drill').click();
    await expect(page.getByTestId('drill-terminated')).toBeVisible();
    // 新版条目：搜不到 v1 条目，搜得到 v2 条目
    await page.getByTestId('fault-search').fill('STS');
    await expect(page.getByTestId('fault-v2-sts-failover')).toBeVisible();
    await expect(page.getByTestId('fault-v1-ups-overload')).toHaveCount(0);

    await page.getByTestId('fault-v2-sts-failover').click();
    for (let i = 0; i < 4; i++) {
      await page.getByTestId(`action-v2-sts-failover-${i}`).click();
    }
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 2.0.0');
    await expect(page.getByTestId('pass-code')).toContainText('PASS-2.0.0-');
  });

  test('离线状态下演练照常进行（SW 提供当前版条目）', async ({ page, context }) => {
    await page.getByTestId('fault-search').fill('跳闸');
    await page.getByTestId('fault-v1-pdu-trip').click();

    // 先在在线完成 v1 激活；切离线后重开演练页
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('fault-search').fill('跳闸');
    await expect(page.getByTestId('fault-v1-pdu-trip')).toBeVisible();
    await page.getByTestId('fault-v1-pdu-trip').click();
    for (let i = 0; i < 4; i++) {
      await page.getByTestId(`action-v1-pdu-trip-${i}`).click();
    }
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
    await context.setOffline(false);
  });
});
