import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ChecksumError,
  HttpError,
  InstallerCoordinator,
  QuotaError,
  stageCacheNameFor,
  type InstallerPorts,
  type ManualCacheLike,
} from './installer';
import type { CatalogEntry, PersistedState, ResourceRef, SyncMessage } from './types';
import { INITIAL_PERSISTED_STATE } from './types';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const makeRef = (version: string, name: 'manifest.json' | 'faults.json', body: string): ResourceRef => ({
  url: `/manuals/v${version === '1.0.0' ? '1' : '2'}/${name}`,
  sha256: sha(body),
  kind: name === 'manifest.json' ? 'manual' : 'faults',
});

const makeEntry = (version: '1.0.0' | '2.0.0'): { entry: CatalogEntry; bodies: Map<string, string> } => {
  const manifestBody = JSON.stringify({ version, steps: [{ order: 1, action: 'a', detail: 'd' }] });
  const faultsBody = JSON.stringify({ version, entries: [] });
  const bodies = new Map<string, string>();
  const r1 = makeRef(version, 'manifest.json', manifestBody);
  const r2 = makeRef(version, 'faults.json', faultsBody);
  bodies.set(r1.url, manifestBody);
  bodies.set(r2.url, faultsBody);
  return {
    entry: {
      version,
      releasedAt: '2026-01-01',
      title: `v${version}`,
      stepCount: 1,
      resources: [r1, r2],
    },
    bodies,
  };
};

type Route =
  | { mode: 'ok' }
  | { mode: 'network' }
  | { mode: 'http' }
  | { mode: 'checksum' }
  | { mode: 'hang' }
  | { mode: 'quotaOnPut' };

/**
 * 模拟“同一浏览器”的共享环境：一份 IndexedDB 状态、一组 Cache Storage、
 * 一把跨页面安装锁、一条 BroadcastChannel 总线。多个协调器共用即模拟多个标签页。
 */
interface SharedEnv {
  store: PersistedState;
  caches: Map<string, Map<string, Response>>;
  lockHeld: boolean;
  bus: Set<(message: SyncMessage) => void>;
}

const makeEnv = (): SharedEnv => ({
  store: JSON.parse(JSON.stringify(INITIAL_PERSISTED_STATE)) as PersistedState,
  caches: new Map(),
  lockHeld: false,
  bus: new Set(),
});

interface FakePorts extends InstallerPorts {
  store: PersistedState;
  caches: Map<string, Map<string, Response>>;
  bodies: Map<string, string>;
  routes: Map<string, Route>;
  calls: string[];
  setRoute(url: string, route: Route): void;
  pendingFetch: Map<string, { resolve: () => void; reject: (e: unknown) => void }>;
}

const makePorts = (bodies: Map<string, string>, env: SharedEnv = makeEnv()): FakePorts => {
  let myHandler: ((message: SyncMessage) => void) | null = null;
  const ports: FakePorts = {
    get store() {
      return env.store;
    },
    set store(value: PersistedState) {
      env.store = value;
    },
    caches: env.caches,
    bodies,
    routes: new Map(),
    calls: [],
    pendingFetch: new Map(),

    setRoute(url, route) {
      this.routes.set(url, route);
    },

    async loadState() {
      return JSON.parse(JSON.stringify(env.store)) as PersistedState;
    },
    async saveState(state) {
      this.calls.push('save');
      env.store = JSON.parse(JSON.stringify(state)) as PersistedState;
    },

    async fetchResource(ref, signal) {
      const route = this.routes.get(ref.url) ?? { mode: 'ok' };
      if (route.mode === 'network') {
        throw new TypeError('Failed to fetch');
      }
      if (route.mode === 'http') {
        throw new HttpError(500);
      }
      if (route.mode === 'hang') {
        return await new Promise((resolve, reject) => {
          const deliver = () => {
            const body = this.bodies.get(ref.url) ?? '{}';
            resolve({ bytes: new TextEncoder().encode(body), contentType: 'application/json' });
          };
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort);
            this.pendingFetch.set(ref.url, { resolve: deliver, reject: onAbort });
          }
        });
      }
      let body = this.bodies.get(ref.url) ?? '{}';
      if (route.mode === 'checksum') body = `${body}-tampered`;
      const bytes = new TextEncoder().encode(body);
      return { bytes, contentType: 'application/json' };
    },

    async sha256(bytes) {
      return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    },

    async openCache(name): Promise<ManualCacheLike> {
      let map = env.caches.get(name);
      if (!map) {
        map = new Map();
        env.caches.set(name, map);
      }
      return {
        put: async (url, bytes, contentType) => {
          const route = this.routes.get(url);
          if (route?.mode === 'quotaOnPut') throw new QuotaError();
          // 用字节重建 Response 模拟 Cache 存储
          map!.set(
            url,
            new Response(bytes, { headers: { 'Content-Type': contentType } }),
          );
        },
      };
    },

    async deleteCache(name) {
      return env.caches.delete(name);
    },

    async listManualCaches() {
      return [...env.caches.keys()].filter((k) => k.startsWith('manual:'));
    },

    now: () => 1000,

    async tryWithInstallLock(fn) {
      // 与 Web Locks ifAvailable 语义一致：锁被持有则不排队，立即失败。
      if (env.lockHeld) return { acquired: false };
      env.lockHeld = true;
      try {
        return { acquired: true, value: await fn() };
      } finally {
        env.lockHeld = false;
      }
    },

    postSync(message) {
      // BroadcastChannel 语义：投递给除发送方外的所有页面，异步送达。
      for (const handler of [...env.bus]) {
        if (handler !== myHandler) queueMicrotask(() => handler(message));
      }
    },

    onSync(handler) {
      myHandler = handler;
      env.bus.add(handler);
      return () => {
        env.bus.delete(handler);
      };
    },
  };
  return ports;
};

const activeCacheNameOf = (ports: FakePorts) => {
  const name = ports.store.activeCacheName!;
  expect(ports.caches.has(name)).toBe(true);
  return name;
};

const waitFor = async (predicate: () => boolean, label = 'condition') => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时: ${label}`);
};

describe('InstallerCoordinator 状态协调', () => {
  it('首次完整安装：全部资源校验通过后才提交激活，状态为 installing→activated', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const seen: string[] = [];
    c.subscribe((s) => seen.push(s.status.kind));
    await c.init();

    await c.install(v1.entry);

    expect(ports.store.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    const cacheName = ports.store.activeCacheName!;
    const cache = ports.caches.get(cacheName)!;
    expect(cache.size).toBe(2);
    // 只有在第二份资源入缓存之后才出现 activated
    expect(seen).toContain('installing');
    expect(seen[seen.length - 1]).toBe('activated');
    // 无多余孤儿缓存
    expect(await ports.listManualCaches()).toEqual([cacheName]);
  });

  it('首次失败：无激活版本，快照显示失败且界面语义为“无可用离线包”', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'network' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    const snap = c.getSnapshot();
    expect(snap.activeVersion).toBeNull();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(ports.store.activeVersion).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('校验失败：标记 checksum，清理未激活缓存，已激活版本保留', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[1].url, { mode: 'checksum' });
    await c.install(v2.entry);

    const snap = c.getSnapshot();
    expect(snap.status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(snap.activeVersion).toBe('1.0.0');
    // v2 暂存缓存被清理，v1 激活缓存保留
    expect(ports.caches.has(v1Cache)).toBe(true);
    const stageV2 = [...ports.caches.keys()].filter((k) => k.includes(':2.0.0:'));
    expect(stageV2.length).toBe(0);
  });

  it('断网（下载中途）：标记 network，旧版继续可用', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v2.entry.resources[0].url, { mode: 'network' });
    await c.install(v2.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'network' });
    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('配额异常：标记 quota，未激活缓存清理', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'quotaOnPut' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    await c.install(v1.entry);

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'quota' });
    expect(ports.store.activeVersion).toBeNull();
    // 配额失败后暂存缓存被整体删除
    expect(ports.caches.size).toBe(0);
  });

  it('取消安装：AbortSignal 中止下载，标记 canceled 且清理暂存缓存', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const done = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing', 'installing');
    expect(c.getSnapshot().status).toMatchObject({ cancelRequested: false });

    await c.cancel();
    await done;

    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(ports.store.pending).toBeNull();
    expect(await ports.listManualCaches()).toEqual([]);
  });

  it('安装中关闭后重开：pending 半包被清除，继续展示此前完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const first = new InstallerCoordinator(ports);
    await first.init();
    await first.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 模拟浏览器在 v2 安装中途被杀掉：IDB 留下 pending，暂存缓存有半包内容。
    const leftover = stageCacheNameFor('2.0.0', 'leftover');
    ports.store = {
      ...ports.store,
      pending: { version: '2.0.0', cacheName: leftover, startedAt: 900 },
    };
    const halfCache = new Map<string, Response>();
    halfCache.set(v2.entry.resources[0].url, new Response('partial'));
    ports.caches.set(leftover, halfCache);

    const reopened = new InstallerCoordinator(ports);
    await reopened.init();
    const snap = reopened.getSnapshot();

    expect(snap.activeVersion).toBe('1.0.0');
    expect(ports.store.pending).toBeNull();
    expect(ports.caches.has(leftover)).toBe(false);
    expect(ports.caches.has(v1Cache)).toBe(true);
  });

  it('同版本重装失败：旧激活缓存必须保留，仍展示该完整版本', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    ports.setRoute(v1.entry.resources[0].url, { mode: 'checksum' });
    await c.install(v1.entry);

    expect(c.getSnapshot().activeVersion).toBe('1.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });
    expect(ports.store.activeCacheName).toBe(v1Cache);
    expect(ports.caches.has(v1Cache)).toBe(true);
    const cachesForV1 = [...ports.caches.keys()].filter((k) => k.includes(':1.0.0:'));
    expect(cachesForV1).toEqual([v1Cache]);
  });

  it('成功升级：新代际激活后旧版缓存与其他孤儿缓存全部回收', async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const ports = makePorts(new Map([...v1.bodies, ...v2.bodies]));
    const c = new InstallerCoordinator(ports);
    await c.init();
    await c.install(v1.entry);
    const v1Cache = activeCacheNameOf(ports);

    // 无关孤儿缓存
    ports.caches.set('manual:stage:2.0.0-orphan', new Map());

    await c.install(v2.entry);

    expect(c.getSnapshot().activeVersion).toBe('2.0.0');
    expect(c.getSnapshot().status).toMatchObject({ kind: 'activated' });
    const names = await ports.listManualCaches();
    expect(names).toEqual([ports.store.activeCacheName]);
    expect(names).not.toContain(v1Cache);
  });

  it('重复发起安装被忽略，同一时刻只有一个安装', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    ports.setRoute(v1.entry.resources[0].url, { mode: 'hang' });
    const c = new InstallerCoordinator(ports);
    await c.init();

    const first = c.install(v1.entry);
    await waitFor(() => c.getSnapshot().status.kind === 'installing');
    // 第二次立即返回，不产生新流程
    await c.install(v1.entry);
    await c.cancel();
    await first;
    expect(ports.pendingFetch.size).toBe(1);
  });

  it('订阅者收到不可变快照，失败与激活版本字段一致', async () => {
    const v1 = makeEntry('1.0.0');
    const ports = makePorts(v1.bodies);
    const c = new InstallerCoordinator(ports);
    const snapshots: { active: string | null; status: string }[] = [];
    c.subscribe((s) => snapshots.push({ active: s.activeVersion, status: s.status.kind }));
    await c.init();
    ports.setRoute(v1.entry.resources[0].url, { mode: 'http' });
    await c.install(v1.entry);

    expect(snapshots[0].active).toBeNull();
    const failedSnap = snapshots[snapshots.length - 1];
    expect(failedSnap).toEqual({ active: null, status: 'failed' });
  });
});

describe('跨页面并发安装（同一浏览器两个标签页）', () => {
  /** 两个协调器共享同一套环境（IDB/缓存/锁/总线），模拟同一浏览器的两个页面。 */
  const setupTwoPages = async () => {
    const v1 = makeEntry('1.0.0');
    const v2 = makeEntry('2.0.0');
    const bodies = new Map([...v1.bodies, ...v2.bodies]);
    const env = makeEnv();
    const portsA = makePorts(bodies, env);
    const portsB = makePorts(bodies, env);
    const A = new InstallerCoordinator(portsA);
    const B = new InstallerCoordinator(portsB);
    await A.init();
    await B.init();
    await A.install(v1.entry);
    const v1Cache = env.store.activeCacheName!;
    return { v1, v2, bodies, env, portsA, portsB, A, B, v1Cache };
  };

  it('并行安装不同版本：锁保证唯一安装，落败者零写入，两页收敛到胜出版本', async () => {
    const { v1, v2, env, portsA, portsB, A, B, v1Cache } = await setupTwoPages();

    // A 开始安装 v2，挂在第一个资源上
    portsA.setRoute(v2.entry.resources[0].url, { mode: 'hang' });
    const installA = A.install(v2.entry);
    await waitFor(() => A.getSnapshot().status.kind === 'installing', 'A installing');

    // B 通过广播跟随到 A 的进度
    await waitFor(() => B.getSnapshot().status.kind === 'installing', 'B follows');
    expect(B.getSnapshot().status).toMatchObject({ version: '2.0.0', completed: 0 });
    expect(B.getSnapshot().activeVersion).toBe('1.0.0');

    // B 发起 v1 重装：落败，不写 IndexedDB、不创建任何缓存
    const savesBefore = portsB.calls.filter((c) => c === 'save').length;
    await B.install(v1.entry);
    expect(portsB.calls.filter((c) => c === 'save').length).toBe(savesBefore);
    expect(env.store.pending?.version).toBe('2.0.0');
    expect([...env.caches.keys()].filter((k) => k.includes(':1.0.0:'))).toEqual([v1Cache]);

    // A 完成下载并提交 v2
    portsA.pendingFetch.get(v2.entry.resources[0].url)!.resolve();
    await installA;
    expect(A.getSnapshot().status).toMatchObject({ kind: 'activated', version: '2.0.0' });

    // B 收敛到胜出版本；缓存集合只剩胜者缓存，IDB 指针有效
    await waitFor(() => B.getSnapshot().activeVersion === '2.0.0', 'B converges');
    expect(B.getSnapshot().status).toMatchObject({ kind: 'activated', version: '2.0.0' });
    expect(env.store.activeVersion).toBe('2.0.0');
    expect(await portsA.listManualCaches()).toEqual([env.store.activeCacheName]);
    expect(env.caches.has(v1Cache)).toBe(false);
    expect(env.caches.get(env.store.activeCacheName!)!.size).toBe(2);
  });

  it('他页安装进行中时打开的新页面：不清理其暂存缓存与 pending，随后收敛', async () => {
    const { v2, bodies, env, portsA, A, v1Cache } = await setupTwoPages();

    portsA.setRoute(v2.entry.resources[0].url, { mode: 'hang' });
    const installA = A.install(v2.entry);
    await waitFor(() => env.store.pending?.version === '2.0.0', 'pending written');
    const stageName = env.store.pending!.cacheName;
    await waitFor(() => env.caches.has(stageName), 'staging cache created');

    // 模拟安装中途又打开一个页面：新协调器执行启动恢复
    const portsC = makePorts(bodies, env);
    const C = new InstallerCoordinator(portsC);
    await C.init();

    // 未清理：pending 与暂存缓存原样保留，C 展示此前的完整版本
    expect(env.store.pending?.version).toBe('2.0.0');
    expect(env.caches.has(stageName)).toBe(true);
    expect(env.caches.has(v1Cache)).toBe(true);
    expect(C.getSnapshot().activeVersion).toBe('1.0.0');

    // A 完成后 C 收敛到新版，缓存集合唯一
    portsA.pendingFetch.get(v2.entry.resources[0].url)!.resolve();
    await installA;
    await waitFor(() => C.getSnapshot().activeVersion === '2.0.0', 'C converges');
    expect(await portsC.listManualCaches()).toEqual([env.store.activeCacheName]);
  });

  it('跟随页可取消他页进行中的安装，两页都回到已激活版本', async () => {
    const { v2, env, portsA, A, B, v1Cache } = await setupTwoPages();

    portsA.setRoute(v2.entry.resources[0].url, { mode: 'hang' });
    const installA = A.install(v2.entry);
    await waitFor(() => B.getSnapshot().status.kind === 'installing', 'B follows');

    // B 未持有安装：cancel 转为跨页取消请求
    await B.cancel();
    await installA;

    expect(A.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    await waitFor(() => B.getSnapshot().status.kind === 'failed', 'B sees failure');
    expect(B.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'canceled' });
    expect(env.store.activeVersion).toBe('1.0.0');
    expect(env.caches.has(v1Cache)).toBe(true);
    expect(await portsA.listManualCaches()).toEqual([v1Cache]);
  });

  it('一页安装失败不影响他页与旧版；另一页随后安装成功并双向收敛', async () => {
    const { v2, env, portsA, A, B, v1Cache } = await setupTwoPages();

    // A 安装 v2 校验失败
    portsA.setRoute(v2.entry.resources[1].url, { mode: 'checksum' });
    await A.install(v2.entry);
    expect(A.getSnapshot().status).toMatchObject({ kind: 'failed', code: 'checksum' });

    // B 同步失败状态，旧版完整保留
    await waitFor(() => B.getSnapshot().status.kind === 'failed', 'B sees failure');
    expect(B.getSnapshot().activeVersion).toBe('1.0.0');
    expect(env.store.activeVersion).toBe('1.0.0');
    expect(env.caches.has(v1Cache)).toBe(true);
    expect(await portsA.listManualCaches()).toEqual([v1Cache]);

    // B 随后安装成功（B 的下载路由正常），A 经广播收敛
    await B.install(v2.entry);
    expect(B.getSnapshot().status).toMatchObject({ kind: 'activated', version: '2.0.0' });
    await waitFor(() => A.getSnapshot().activeVersion === '2.0.0', 'A converges');
    expect(A.getSnapshot().status).toMatchObject({ kind: 'activated', version: '2.0.0' });
    expect(await portsA.listManualCaches()).toEqual([env.store.activeCacheName]);
  });

  it('两个安装先后完成：后者安全取代前者，IDB 指针永不悬空', async () => {
    const { v1, v2, env, portsA, A, B } = await setupTwoPages();

    // A 安装 v2 → B 收敛
    await A.install(v2.entry);
    await waitFor(() => B.getSnapshot().activeVersion === '2.0.0', 'B converges to v2');
    const v2Cache = env.store.activeCacheName!;

    // B 紧接着装回 v1 → A 收敛；任何时刻 IDB 指针都指向存在的缓存
    await B.install(v1.entry);
    await waitFor(() => A.getSnapshot().activeVersion === '1.0.0', 'A converges to v1');

    expect(env.store.activeVersion).toBe('1.0.0');
    expect(env.caches.has(env.store.activeCacheName!)).toBe(true);
    expect(env.caches.has(v2Cache)).toBe(false);
    expect(await portsA.listManualCaches()).toEqual([env.store.activeCacheName]);
  });
});

// 让未使用的类型导入保持显式（ChecksumError 在映射逻辑中间接验证）
void ChecksumError;
