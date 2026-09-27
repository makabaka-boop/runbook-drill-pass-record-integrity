import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

/**
 * 核心验收：
 * 中断新版安装后离线刷新仍打开旧版；完整重装并激活后才只显示新版步骤。
 * 半包更新绝不能在刷新后替换旧手册。
 */
test.describe('中断安装与离线重载', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('install-1.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
  });

  test('v2 安装停在第一资源时刷新+断网：仍是 v1，且暂存缓存已被清理', async ({ page, context }) => {
    // 让 v2 第一个资源永远挂起，安装停在“进行中”（模拟下载中关闭页面）。
    await setFaultRules(page, [{ match: '/manuals/v2/manifest.json', behavior: 'hang' }]);
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('installing-banner')).toContainText('正在安装版本 2.0.0');
    await expect(page.getByTestId('installing-2.0.0')).toContainText('0/2');

    // “安装中关闭后重开”：新页面刷新（故障规则仍由已注册的 SW 持有，直到清除）。
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-1')).not.toContainText('双总线');

    // 解除挂起，然后断网再刷新：旧版依然完整可读。
    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(page.getByTestId('step-8')).toBeVisible();
    await expect(page.getByTestId('installing-banner')).toHaveCount(0);

    // 暂存缓存必须清理，只剩一个 manual:* 缓存（v1 激活缓存）。
    const cacheNames = await page.evaluate(async () => caches.keys());
    const manualCaches = cacheNames.filter((n) => n.startsWith('manual:'));
    expect(manualCaches.length).toBe(1);
    await context.setOffline(false);
  });

  test('取消 v2 安装：失败提示为已取消，离线刷新仍只读 v1', async ({ page, context }) => {
    await setFaultRules(page, [{ match: '/manuals/v2/manifest.json', behavior: 'hang' }]);
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('installing-2.0.0')).toContainText('0/2');
    await page.getByTestId('cancel-2.0.0').click();

    await expect(page.getByTestId('failed-banner')).toContainText('安装已取消');
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');

    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');
    await context.setOffline(false);
  });

  test('v2 校验失败：旧版保留；随后完整安装并激活才只显示新版步骤', async ({ page, context }) => {
    // 破坏第二个资源内容，触发 SHA-256 失败。
    await setFaultRules(page, [{ match: '/manuals/v2/faults.json', behavior: 'tamper' }]);
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('failed-banner')).toContainText('校验失败');
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('step-1')).toContainText('书面断电许可');

    // 恢复真实内容（解除故障），完整重装
    await clearFaultRules(page);
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('activated-banner')).toContainText('2.0.0');
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');

    // 只显示新版步骤：v2 有 9 步且含双总线内容，v1 第 8 步内容已不存在。
    await expect(page.getByTestId('step-9')).toContainText('接地线并复核保留段');
    await expect(page.getByText('通知调度并取得书面断电许可')).toHaveCount(0);
    await expect(page.getByText('通知调度并取得双总线书面断电许可')).toHaveCount(1);

    // 激活后离线刷新，仍是新版。
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-1')).toContainText('双总线');
    await expect(page.getByTestId('step-9')).toBeVisible();
    await context.setOffline(false);
  });
});
