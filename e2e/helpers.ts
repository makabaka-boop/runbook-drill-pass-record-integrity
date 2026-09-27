import type { Page } from '@playwright/test';
import type { FaultRule } from '../src/test/fault-injection';

/**
 * 通过 postMessage 向 Service Worker 下发故障规则，并等待其回执，确保规则生效。
 */
export async function setFaultRules(page: Page, rules: FaultRule[]): Promise<void> {
  await page.evaluate(async (incoming) => {
    let target: ServiceWorker | null = null;
    for (let i = 0; i < 50; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      target = reg?.active ?? navigator.serviceWorker.controller;
      if (target) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!target) throw new Error('SW 未激活，无法下发故障规则');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', onAck);
        reject(new Error('故障规则下发未收到回执'));
      }, 5000);
      const onAck = (event: MessageEvent) => {
        if (event.data?.__type === 'manual-faults-ack') {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message', onAck);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener('message', onAck);
      target!.postMessage({ __type: 'manual-faults', rules: incoming });
    });
  }, rules);
}

export const clearFaultRules = (page: Page) => setFaultRules(page, []);
