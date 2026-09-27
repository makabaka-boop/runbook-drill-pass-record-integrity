/// <reference lib="webworker" />
/**
 * 机房手册 Service Worker。
 *
 * 职责划分（满足需求）：
 * - 离线读取：手册资源只从“当前激活代际”的 Cache Storage 出；
 *   任何半包/暂存缓存一律不对外提供（见缓存命名前缀）。
 * - 应用壳（同源构建产物）在 install 时预缓存，导航请求离线回退到 /index.html。
 * - IndexedDB 只读取当前代际与安装状态（与页面共享同一条记录）。
 * 构建期由 plugins/sw-build.ts 通过 esbuild define 注入 SW_VERSION / SW_PRECACHE。
 */
import { readState } from '../core/idb';

declare const SW_VERSION: string;
declare const SW_PRECACHE: { url: string; revision: string }[];

const sw = self as unknown as ServiceWorkerGlobalScope & { __WB_MANIFEST?: unknown };

const SHELL_CACHE = `shell:${SW_VERSION}`;
const STAGE_PREFIX = 'manual:stage:';

const PRECACHE_URLS = new Set(SW_PRECACHE.map((e) => e.url).concat(['/', '/index.html']));
const PRECACHE_MAP = new Map(SW_PRECACHE.map((e) => [e.url, e.revision]));

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐条预缓存；失败不阻塞 SW 安装（手册离线能力由激活缓存保证）。
      await Promise.all(
        SW_PRECACHE.map(async ({ url, revision }) => {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) {
              const headers = new Headers(res.headers);
              headers.set('x-sw-revision', revision);
              await cache.put(
                url,
                new Response(res.body, { status: res.status, statusText: res.statusText, headers }),
              );
            }
          } catch {
            // 单条失败忽略，activate/运行时仍有网络回退。
          }
        }),
      );
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清理旧代际的应用壳缓存；手册缓存由页面协调器按 IDB 指针精确回收。
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('shell:') && k !== SHELL_CACHE).map((k) => caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

/** 判断请求 URL 是否命中任一内置手册的同源资源路径。 */
const isManualResource = (url: URL): boolean =>
  url.origin === sw.location.origin && url.pathname.startsWith('/manuals/');

/** 手册资源：仅从 IDB 指向的当前激活代际缓存出；暂存/半包缓存永不可见。 */
const serveActiveManual = async (request: Request): Promise<Response | undefined> => {
  const state = await readState();
  if (!state.activeCacheName) return undefined;
  // 激活缓存命名形如 manual:stage:<version>:<attempt>，但任何带 stage 前缀的缓存
  // 是否可见，完全取决于 IDB 中的指针；半包没有指针，因此天然不可见。
  if (!state.activeCacheName.startsWith(STAGE_PREFIX)) return undefined;
  const cache = await caches.open(state.activeCacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit ?? undefined;
};

const networkThenCachePut = async (request: Request, cache: Cache): Promise<Response> => {
  const res = await fetch(request);
  if (res.ok && request.method === 'GET') {
    cache.put(request, res.clone()).catch(() => undefined);
  }
  return res;
};

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  // 1) 手册资源：严格“只出激活代际”。
  //    安装请求（带 x-manual-install 标记）强制走网络重新下载，绝不从当前激活缓存读，
  //    从而“重装/升级”确实重新下载校验；离线时安装请求应失败（而非读旧内容）。
  const isInstallRequest = request.headers.get('x-manual-install') === '1';
  if (isManualResource(url)) {
    event.respondWith(
      (async () => {
        if (!isInstallRequest) {
          const active = await serveActiveManual(request);
          if (active) return active;
        }
        // 网络结果绝不写入缓存，避免半包经 SW 泄露给后续读取。
        return fetch(request, { cache: 'no-store' });
      })(),
    );
    return;
  }

  // 2) 开发模式（无预缓存）：网络优先并顺手写缓存，保证 HMR 正常。
  if (SW_PRECACHE.length === 0) {
    event.respondWith(
      caches.open(SHELL_CACHE).then((cache) =>
        networkThenCachePut(request, cache).catch(async () =>
          request.mode === 'navigate'
            ? (await cache.match('/index.html')) ?? Response.error()
            : (await cache.match(request)) ?? Response.error(),
        ),
      ),
    );
    return;
  }

  // 3) 应用壳：导航请求缓存优先，未命中走网络并运行时缓存。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit =
          (await cache.match('/index.html')) ??
          (await cache.match('/')) ??
          (await caches.match(request));
        if (hit) return hit;
        try {
          return await networkThenCachePut(request, cache);
        } catch {
          return (await cache.match('/index.html')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // 4) 预缓存的静态资源：缓存优先，缺失走网络（并缓存）。
  if (PRECACHE_URLS.has(url.pathname) || PRECACHE_MAP.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          return await networkThenCachePut(request, cache);
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }

  // 5) 其他同源 GET（HMR 等）：网络优先，离线尝试缓存。
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      networkThenCachePut(request, cache).catch(() => caches.match(request).then((r) => r ?? Response.error())),
    ),
  );
});
