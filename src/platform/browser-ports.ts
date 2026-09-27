/** 浏览器端 InstallerPorts 实现：Cache Storage + fetch + WebCrypto + Web Locks + BroadcastChannel。 */
import type { PersistedState, ResourceRef, SyncMessage } from '../core/types';
import {
  HttpError,
  QuotaError,
  type InstallerPorts,
  type ManualCacheLike,
} from '../core/installer';
import { readState, writeState } from '../core/idb';

/** 跨页面安装互斥锁名（Web Locks，按源隔离，同源所有标签页共享）。 */
const INSTALL_LOCK_NAME = 'manual-kiosk-install';
/** 跨页面状态同步频道名。 */
const SYNC_CHANNEL_NAME = 'manual-kiosk-sync';

const isQuotaError = (err: unknown): boolean => {
  if (!err) return false;
  const e = err as { name?: string; message?: string; code?: number };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (typeof e.code === 'number' && e.code === 22) ||
    /quota|exceeded/i.test(e.message ?? '')
  );
};

export function createBrowserPorts(): InstallerPorts {
  // 惰性创建频道：能力缺失的浏览器应显示 UNSUPPORTED，而不是在模块加载时抛错。
  let syncChannel: BroadcastChannel | null = null;
  const channel = () => (syncChannel ??= new BroadcastChannel(SYNC_CHANNEL_NAME));

  return {
    loadState: () => readState(),
    saveState: (state: PersistedState) => writeState(state),

    async fetchResource(ref: ResourceRef, signal: AbortSignal) {
      const response = await fetch(ref.url, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
        // 安装专用标记：SW 据此绕过当前激活代际缓存，强制真正下载（离线重装应失败而非读旧缓存）。
        headers: { 'x-manual-install': '1' },
      });
      if (!response.ok) {
        throw new HttpError(response.status);
      }
      const buffer = await response.arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    },

    async sha256(bytes: Uint8Array) {
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    },

    async openCache(name: string): Promise<ManualCacheLike> {
      const cache = await caches.open(name);
      return {
        async put(url: string, bytes: Uint8Array, contentType: string) {
          try {
            // 用已校验字节重建响应并写入，no-store 避免任何 HTTP 缓存语义影响代际内容。
            const response = new Response(bytes as BodyInit, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
              },
            });
            await cache.put(url, response);
          } catch (err) {
            if (isQuotaError(err)) throw new QuotaError();
            throw err;
          }
        },
      };
    },

    deleteCache: (name: string) => caches.delete(name),

    async listManualCaches() {
      const keys = await caches.keys();
      return keys.filter((k) => k.startsWith('manual:'));
    },

    now: () => Date.now(),

    async tryWithInstallLock<T>(fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
      let acquired = false;
      let value: T | undefined;
      // ifAvailable：锁被他页持有时不排队，立即以 lock=null 返回（调用方转为跟随）。
      await navigator.locks.request(INSTALL_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        acquired = true;
        value = await fn();
      });
      return acquired ? { acquired, value } : { acquired };
    },

    postSync(message: SyncMessage) {
      channel().postMessage(message);
    },

    onSync(handler: (message: SyncMessage) => void) {
      const listener = (event: MessageEvent) => handler(event.data as SyncMessage);
      channel().addEventListener('message', listener);
      return () => channel().removeEventListener('message', listener);
    },
  };
}
