import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

/**
 * 多标签页并行安装验收：
 * 两个页面共用同一浏览器上下文（共享 Service Worker / IndexedDB / Cache Storage /
 * Web Locks / BroadcastChannel），用故障注入的 gate 规则控制下载与校验完成顺序，
 * 覆盖：不同版本竞争、一方失败、胜出后断网重载，并核对当前版本、缓存集合、
 * 页面步骤与演练状态在所有页面间一致。
 */

interface PersistedLike {
  activeVersion: string | null;
  activeCacheName: string | null;
  pending: unknown;
}

/** 打开页面 A 并安装 v1，再打开页面 B（启动即应收敛到 v1）。 */
const openPair = async (context: BrowserContext): Promise<{ pageA: Page; pageB: Page }> => {
  const pageA = await context.newPage();
  await pageA.goto('/');
  await pageA.getByTestId('install-1.0.0').click();
  await expect(pageA.getByTestId('current-version')).toContainText('1.0.0');
  await expect(pageA.getByTestId('step-1')).toContainText('书面断电许可');

  const pageB = await context.newPage();
  await pageB.goto('/');
  await expect(pageB.getByTestId('current-version')).toContainText('1.0.0');
  await expect(pageB.getByTestId('step-1')).toContainText('书面断电许可');
  return { pageA, pageB };
};

const manualCaches = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('manual:')));

const persisted = (page: Page): Promise<PersistedLike> =>
  page.evaluate(() => window.__manualKiosk!.persisted());

const installViaHook = (page: Page, version: string): Promise<void> =>
  page.evaluate((v) => window.__manualKiosk!.install(v), version);

test.describe('多标签页并行安装', () => {
  test('不同版本竞争：唯一胜出版本，落败请求零副作用，全页收敛且断网可读', async ({ context }) => {
    const { pageA, pageB } = await openPair(context);

    // pageB 在 v1 上完成一次演练（形成历史记录），再开始一次未完成演练。
    await pageB.getByTestId('tab-drill').click();
    await pageB.getByTestId('fault-v1-ups-overload').click();
    for (let i = 0; i < 4; i++) {
      await pageB.getByTestId(`action-v1-ups-overload-${i}`).click();
    }
    await expect(pageB.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
    await pageB.getByTestId('fault-v1-pdu-trip').click();
    await pageB.getByTestId('action-v1-pdu-trip-0').click();

    // pageA 安装 v2，用 gate 规则把下载拦在第一个资源上。
    await setFaultRules(pageA, [{ match: '/manuals/v2/manifest.json', behavior: 'gate' }]);
    await pageA.getByTestId('install-2.0.0').click();
    await expect(pageA.getByTestId('installing-banner')).toContainText('正在安装版本 2.0.0');
    // pageB 未参与安装，但同步看到进行中的安装。
    await expect(pageB.getByTestId('installing-banner')).toContainText('正在安装版本 2.0.0');
    // A 的暂存缓存已建立（v1 激活缓存 + v2 暂存缓存）。
    await expect.poll(() => manualCaches(pageA)).toHaveLength(2);

    // pageB 在 A 安装期间发起 v1 重装（模拟两个页面近乎同时点击的竞争）：
    // 请求落败，不创建任何新缓存、不改写当前版本。
    await installViaHook(pageB, '1.0.0');
    const cachesDuring = await manualCaches(pageB);
    expect(cachesDuring).toHaveLength(2);
    expect(cachesDuring.filter((n) => n.includes(':1.0.0:'))).toHaveLength(1);
    await expect(pageB.getByTestId('current-version')).toContainText('1.0.0');

    // 放行下载：A 完成校验并激活 v2，两个页面都收敛到 v2。
    await clearFaultRules(pageA);
    await expect(pageA.getByTestId('activated-banner')).toContainText('2.0.0');
    await expect(pageA.getByTestId('current-version')).toContainText('2.0.0');
    await expect(pageB.getByTestId('current-version')).toContainText('2.0.0');

    // pageB 步骤切到 v2；未完成演练被终止；已完成历史记录保持 v1 归属。
    await pageB.getByTestId('tab-steps').click();
    await expect(pageB.getByTestId('step-9')).toContainText('接地线并复核保留段');
    await expect(pageB.getByTestId('step-1')).toContainText('双总线');
    await pageB.getByTestId('tab-drill').click();
    await expect(pageB.getByTestId('drill-terminated')).toBeVisible();
    await expect(pageB.getByTestId('pass-history')).toContainText('版本 1.0.0');
    await pageB.getByTestId('fault-search').fill('STS');
    await expect(pageB.getByTestId('fault-v2-sts-failover')).toBeVisible();
    await expect(pageB.getByTestId('fault-v1-ups-overload')).toHaveCount(0);

    // IndexedDB 当前代际与缓存集合：唯一、完整、指针有效。
    const state = await persisted(pageB);
    expect(state.activeVersion).toBe('2.0.0');
    expect(state.pending).toBeNull();
    const cachesAfter = await manualCaches(pageA);
    expect(cachesAfter).toEqual([state.activeCacheName]);

    // 胜出后断网重载两个页面：都是完整的 v2 步骤。
    await context.setOffline(true);
    await pageA.reload();
    await expect(pageA.getByTestId('current-version')).toContainText('2.0.0');
    await expect(pageA.getByTestId('step-9')).toBeVisible();
    await pageB.reload();
    await expect(pageB.getByTestId('current-version')).toContainText('2.0.0');
    await expect(pageB.getByTestId('step-1')).toContainText('双总线');
    await expect(pageB.getByTestId('step-9')).toBeVisible();
    await context.setOffline(false);
  });

  test('一方校验失败：两页都保留原有可用版本，缓存集合干净，断网重载一致', async ({ context }) => {
    const { pageA, pageB } = await openPair(context);

    // pageA 安装 v2 时第二个资源被篡改 → SHA-256 校验失败。
    await setFaultRules(pageA, [{ match: '/manuals/v2/faults.json', behavior: 'tamper' }]);
    await pageA.getByTestId('install-2.0.0').click();
    await expect(pageA.getByTestId('failed-banner')).toContainText('校验失败');

    // pageB 同步失败状态，并继续展示原有可用版本。
    await expect(pageB.getByTestId('failed-banner')).toContainText('校验失败');
    await expect(pageB.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageB.getByTestId('step-1')).toContainText('书面断电许可');

    // 失败的安装不留下任何缓存：只剩 v1 激活缓存，IDB 指针不变。
    const state = await persisted(pageA);
    expect(state.activeVersion).toBe('1.0.0');
    expect(await manualCaches(pageB)).toEqual([state.activeCacheName]);

    await clearFaultRules(pageA);
    await context.setOffline(true);
    await pageA.reload();
    await expect(pageA.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageA.getByTestId('step-8')).toBeVisible();
    await pageB.reload();
    await expect(pageB.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageB.getByTestId('step-1')).toContainText('书面断电许可');
    await context.setOffline(false);
  });

  test('两个安装先后完成：跨页串行安全，双方页面始终收敛到同一版本', async ({ context }) => {
    const { pageA, pageB } = await openPair(context);

    // A 安装 v2 → B 不刷新即收敛到 v2。
    await pageA.getByTestId('install-2.0.0').click();
    await expect(pageA.getByTestId('activated-banner')).toContainText('2.0.0');
    await expect(pageB.getByTestId('current-version')).toContainText('2.0.0');
    await expect(pageB.getByTestId('step-1')).toContainText('双总线');

    // B 随后装回 v1 → A 不刷新即收敛到 v1。
    await pageB.getByTestId('install-1.0.0').click();
    await expect(pageB.getByTestId('activated-banner')).toContainText('1.0.0');
    await expect(pageA.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageA.getByTestId('step-1')).toContainText('书面断电许可');
    await expect(pageA.getByTestId('step-1')).not.toContainText('双总线');

    // 最终版本唯一且完整：IDB 指针有效，缓存集合恰为当前代际。
    const state = await persisted(pageA);
    expect(state.activeVersion).toBe('1.0.0');
    expect(await manualCaches(pageB)).toEqual([state.activeCacheName]);

    await context.setOffline(true);
    await pageA.reload();
    await expect(pageA.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageA.getByTestId('step-8')).toBeVisible();
    await pageB.reload();
    await expect(pageB.getByTestId('current-version')).toContainText('1.0.0');
    await expect(pageB.getByTestId('step-8')).toBeVisible();
    await context.setOffline(false);
  });
});
