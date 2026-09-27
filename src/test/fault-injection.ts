/**
 * 测试专用故障注入（仅在 window.__MANUAL_FAULTS__ 存在时生效）。
 * 生产环境该标志永远不存在，fetch 行为零变化。
 *
 * 原因：Playwright 的网络路由不会拦截 Service Worker 内发起的 fetch；
 * 而安装请求与离线手册读取都经过 SW。为了确定性地模拟“断网 / 校验失败 / 挂起”，
 * 在 SW 作用域内对 fetch 做最薄的一层包装，规则由测试经 postMessage 下发。
 */
export interface FaultRule {
  /** URL 子串匹配，如 /manuals/v2/manifest.json */
  match: string;
  /**
   * abort：断网；tamper：返回被篡改内容；hang：永不返回；
   * gate：阻塞直到该规则被移除（用于控制两个页面的下载/校验完成顺序）；http:<status>
   */
  behavior: 'abort' | 'tamper' | 'hang' | 'gate' | 'http';
  status?: number;
}

declare global {
  interface Window {
    __MANUAL_FAULTS__?: { rules: FaultRule[] };
  }
}

const swSource = `
self.__MANUAL_FAULT_RULES__ = self.__MANUAL_FAULT_RULES__ || [];
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.__type !== 'manual-faults') return;
  self.__MANUAL_FAULT_RULES__ = Array.isArray(data.rules) ? data.rules : [];
  // 回执：页面据此确认规则已生效
  if (event.source) {
    event.source.postMessage({ __type: 'manual-faults-ack', count: self.__MANUAL_FAULT_RULES__.length });
  }
});
(function () {
  if (self.__MANUAL_FAULT_PATCHED__) return;
  self.__MANUAL_FAULT_PATCHED__ = true;
  const originalFetch = self.fetch.bind(self);
  self.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const rules = self.__MANUAL_FAULT_RULES__ || [];
    const rule = rules.find((r) => typeof url === 'string' && url.includes(r.match));
    if (rule) {
      if (rule.behavior === 'abort') {
        const err = new TypeError('Failed to fetch (fault:abort)');
        throw err;
      }
      if (rule.behavior === 'hang') {
        return await new Promise(function () {});
      }
      if (rule.behavior === 'gate') {
        // 阻塞直到该 gate 规则被移除（轮询规则表），随后放行真实请求。
        // 测试借此暂停一个页面的下载，控制两个页面安装的完成顺序。
        for (;;) {
          const current = self.__MANUAL_FAULT_RULES__ || [];
          const stillGated = current.some(function (r) {
            return r.behavior === 'gate' && url.includes(r.match);
          });
          if (!stillGated) break;
          await new Promise(function (resolve) { setTimeout(resolve, 50); });
        }
        return originalFetch(input, init);
      }
      if (rule.behavior === 'http') {
        return new Response(JSON.stringify({ fault: true }), {
          status: rule.status || 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (rule.behavior === 'tamper') {
        const res = await originalFetch(input, init);
        const text = await res.text();
        return new Response(text + '\\n{"tampered":true}', {
          status: 200,
          headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
        });
      }
    }
    return originalFetch(input, init);
  };
})();
`;

export const FAULT_MESSAGE = 'manual-faults';

/** 向已激活的 SW 下发故障规则（空数组即恢复）。 */
export async function setFaultRules(rules: FaultRule[]): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const target = registration.active ?? navigator.serviceWorker.controller;
  if (!target) throw new Error('Service Worker 未激活，无法下发故障规则');
  target.postMessage({ __type: FAULT_MESSAGE, rules });
  // 等待消息循环处理
  await new Promise((r) => setTimeout(r, 150));
}

export const faultPatchSource = swSource;
