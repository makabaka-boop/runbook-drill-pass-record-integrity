import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

test.describe('首次安装失败', () => {
  test('首次资源即被网络中断：显示无可用离线包，离线刷新也无手册', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByTestId('no-package')).toContainText('无可用离线包');

    await setFaultRules(page, [{ match: '/manuals/v1/manifest.json', behavior: 'abort' }]);
    await page.getByTestId('install-1.0.0').click();
    await expect(page.getByTestId('fail-1.0.0')).toContainText('下载中断');
    await expect(page.getByTestId('no-package')).toContainText('无可用离线包');
    expect(await page.getByTestId('step-list').count()).toBe(0);

    // 断网刷新后仍然没有可用手册（没有任何完整版本被激活）。
    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('no-package')).toContainText('无可用离线包');
    expect(await page.getByTestId('step-list').count()).toBe(0);
    await context.setOffline(false);
  });
});
