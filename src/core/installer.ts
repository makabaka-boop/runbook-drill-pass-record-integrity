/**
 * 安装状态协调器（框架无关的纯核心，Vitest 直接覆盖）。
 *
 * 不变量：
 * 1. 一个版本的所有资源“全部下载 + SHA-256 校验通过”后，才写入新的激活代际。
 * 2. 半包（pending）在任何路径下都不会被激活；取消、断网、校验失败、配额异常
 *    以及安装中关闭后重开，都只清理该未激活缓存。
 * 3. 已激活的完整版本在失败/中断期间继续保留并可读；从无成功安装则 activeVersion=null，
 *    界面显示“无可用离线包”。
 * 4. IndexedDB 的代际切换先于旧缓存删除（崩溃也只会留下孤儿缓存，下次启动回收）。
 * 5. 多标签页并发：安装与启动清理都在跨页面互斥锁（Web Locks）内进行，同一时刻
 *    全浏览器只有一个安装临界区。未获得锁的安装请求直接落败——不写 IndexedDB、
 *    不触碰任何缓存——转为跟随胜者的广播进度；因此并行安装只会留下唯一、完整、
 *    可离线读取的最终版本，落败/失败的安装不会删除胜出版本与原有可用版本。
 * 6. 每次状态变更经 BroadcastChannel 广播；未持有锁的页面收到后重读 IndexedDB
 *    收敛，版本切换后所有已打开页面都收敛到同一版本。
 */
import type {
  CatalogEntry,
  FailureCode,
  InstallerStatus,
  PersistedState,
  ResourceRef,
  Snapshot,
  SyncMessage,
} from './types';
import { INITIAL_PERSISTED_STATE } from './types';

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}
export class ChecksumError extends Error {
  constructor(public readonly url: string) {
    super(`校验失败: ${url}`);
    this.name = 'ChecksumError';
  }
}
export class QuotaError extends Error {
  constructor() {
    super('配额不足');
    this.name = 'QuotaError';
  }
}
export class Canceled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Canceled';
  }
}

/** 平台端口：浏览器实现由 src/platform 提供，测试用内存假实现。 */
export interface InstallerPorts {
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  /** 下载单个资源；AbortSignal 触发时应拒绝 AbortError/Canceled。 */
  fetchResource(
    ref: ResourceRef,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  sha256(bytes: Uint8Array): Promise<string>;
  openCache(name: string): Promise<ManualCacheLike>;
  deleteCache(name: string): Promise<boolean>;
  /** 列出当前所有代际缓存键名（前缀 manual:）。 */
  listManualCaches(): Promise<string[]>;
  now(): number;
  /**
   * 跨页面互斥锁（浏览器侧为 Web Locks）：锁空闲则在锁内执行 fn 并在结束后释放；
   * 锁被他页持有则不执行 fn，立即返回 acquired=false。
   * 安装与启动清理都必须在该锁内进行，保证任何缓存回收都不会误删他页
   * 正在下载或刚激活的资源。
   */
  tryWithInstallLock<T>(fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
  /** 向其他页面广播同步消息（BroadcastChannel）。 */
  postSync(message: SyncMessage): void;
  /** 订阅其他页面的同步消息；返回退订函数。 */
  onSync(handler: (message: SyncMessage) => void): () => void;
}

export interface ManualCacheLike {
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 每次安装尝试使用唯一暂存缓存名；只有提交后代际指针才指向它。 */
export const stageCacheNameFor = (version: string, attemptId: number | string) =>
  `manual:stage:${version}:${attemptId}`;


type Listener = (snapshot: Snapshot) => void;

const toFailureCode = (err: unknown): FailureCode => {
  if (err instanceof ChecksumError) return 'checksum';
  if (err instanceof Canceled) return 'canceled';
  if (err instanceof QuotaError) return 'quota';
  if (err instanceof HttpError) return 'network';
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'Canceled') return 'canceled';
    if (
      name === 'QuotaExceededError' ||
      /quota|exceeded/i.test(err.message)
    ) {
      return 'quota';
    }
    if (name === 'TypeError' || name === 'NetworkError') return 'network';
  }
  return 'unknown';
};

const normalizeHash = (hex: string) => hex.trim().toLowerCase().replace(/^sha256-/, '');

export class InstallerCoordinator {
  private state: PersistedState = { ...INITIAL_PERSISTED_STATE };
  private snapshot: Snapshot = { activeVersion: null, status: { kind: 'idle' } };
  private currentController: AbortController | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;
  /** 本页持有安装锁期间即状态权威来源，忽略他页广播的状态快照。 */
  private holdsLock = false;
  /** 单调序号：丢弃乱序完成的远程状态采用（广播到达有序，但 IndexedDB 重读是异步的）。 */
  private syncSeq = 0;

  constructor(private readonly ports: InstallerPorts) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private emit() {
    for (const fn of this.listeners) fn(this.snapshot);
  }

  /** 本地状态变更：更新快照、通知订阅者，并广播给其他页面（idle 不广播）。 */
  private setStatus(status: Snapshot['status']) {
    this.snapshot = { activeVersion: this.state.activeVersion, status };
    this.emit();
    if (status.kind !== 'idle') {
      this.ports.postSync({ type: 'status', status });
    }
  }

  /**
   * 启动恢复：若存在 pending 半包（含“安装中关闭后重开”），丢弃其缓存与状态，
   * 继续展示此前的完整版本；若无完整版本则界面显示“无可用离线包”。
   * 清理与孤儿缓存回收都在跨页面安装锁内进行：若另一页面正在安装（锁被持有），
   * 本页不做任何清理，只读取当前状态，随后由广播驱动收敛。
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initOnce();
    return this.initPromise;
  }

  private async initOnce(): Promise<void> {
    this.ports.onSync((message) => this.handleSync(message));
    const { acquired } = await this.ports.tryWithInstallLock(async () => {
      const state = await this.ports.loadState();
      if (state.pending) {
        await this.safeDelete(state.pending.cacheName);
        state.pending = null;
        await this.ports.saveState(state);
      }
      this.state = state;
      await this.reconcileCaches();
    });
    if (!acquired) {
      // 另一页面正在安装：其暂存缓存与 pending 记录都归它所有，原样保留。
      this.state = await this.ports.loadState();
    }
    this.snapshot = { activeVersion: this.state.activeVersion, status: { kind: 'idle' } };
    this.emit();
  }

  /** 处理他页广播：取消请求仅在本页持有安装时生效；状态快照驱动本页收敛。 */
  private handleSync(message: SyncMessage): void {
    if (message.type === 'cancel-request') {
      const controller = this.currentController;
      if (this.holdsLock && controller && !controller.signal.aborted) {
        const status = this.snapshot.status;
        if (status.kind === 'installing') {
          this.setStatus({ ...status, cancelRequested: true });
        }
        controller.abort();
      }
      return;
    }
    if (this.holdsLock) return;
    void this.adoptRemote(message.status);
  }

  /** 跟随他页状态：以 IndexedDB 为准确认当前代际，并采用广播来的瞬态状态。 */
  private async adoptRemote(status: InstallerStatus): Promise<void> {
    const seq = ++this.syncSeq;
    let state: PersistedState;
    try {
      state = await this.ports.loadState();
    } catch {
      return;
    }
    if (seq !== this.syncSeq || this.holdsLock) return; // 已有更新的广播，或本页已开始安装
    this.state = state;
    this.snapshot = { activeVersion: state.activeVersion, status };
    this.emit();
  }

  private async reconcileCaches() {
    const keep = this.state.activeCacheName;
    let names: string[] = [];
    try {
      names = await this.ports.listManualCaches();
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name !== keep && name.startsWith('manual:'))
        .map((name) => this.safeDelete(name)),
    );
  }

  private async safeDelete(name: string) {
    try {
      await this.ports.deleteCache(name);
    } catch {
      // 删除失败不改变状态正确性：该缓存既不在 IDB 中被引用，后续仍会被回收。
    }
  }

  async install(entry: CatalogEntry): Promise<void> {
    if (this.currentController) {
      // 本页已有安装流程；重复点击直接忽略。
      return;
    }
    const version = entry.version;
    // 每次尝试使用全新暂存缓存：即便与当前激活版本相同，也绝不先破坏旧版。
    const cacheName = stageCacheNameFor(version, `${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const controller = new AbortController();
    this.currentController = controller;

    try {
      await this.ports.tryWithInstallLock(async () => {
        this.holdsLock = true;
        try {
          await this.runInstall(entry, cacheName, controller);
        } finally {
          this.holdsLock = false;
        }
      });
      // 未获得锁：另一页面正在安装。本次请求落败——不写 IndexedDB、不触碰任何
      // 缓存，保持当前快照并跟随胜者的广播进度收敛。
    } finally {
      this.currentController = null;
    }
  }

  /**
   * 锁内执行的安装流程：下载→校验→原子提交→回收。
   * 调用方必须已持有跨页面安装锁，因此临界区内不存在他页的缓存增删。
   */
  private async runInstall(
    entry: CatalogEntry,
    cacheName: string,
    controller: AbortController,
  ): Promise<void> {
    const total = entry.resources.length;
    const version = entry.version;

    try {
      // 锁内重新读取：他页可能在本页等待期间刚提交过新代际。
      this.state = await this.ports.loadState();

      // 清理可能的同名残留（理论上唯一，防御性处理）。
      await this.safeDelete(cacheName);

      this.state = {
        ...this.state,
        pending: { version, cacheName, startedAt: this.ports.now() },
      };
      await this.ports.saveState(this.state);
      this.setStatus({
        kind: 'installing',
        version,
        progress: 0,
        completed: 0,
        total,
        cancelRequested: false,
      });

      const cache = await this.ports.openCache(cacheName);
      for (let i = 0; i < entry.resources.length; i++) {
        if (controller.signal.aborted) throw new Canceled();
        const ref = entry.resources[i];
        const { bytes, contentType } = await this.ports.fetchResource(ref, controller.signal);
        if (controller.signal.aborted) throw new Canceled();
        const actual = normalizeHash(await this.ports.sha256(bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        await cache.put(ref.url, bytes, contentType);
        if (controller.signal.aborted) throw new Canceled();
        this.setStatus({
          kind: 'installing',
          version,
          completed: i + 1,
          total,
          progress: Math.round(((i + 1) / total) * 100),
          cancelRequested: false,
        });
      }

      // 原子切换：全部资源校验入缓存后才提交新代际。
      this.state = {
        activeVersion: version,
        activeCacheName: cacheName,
        pending: null,
      };
      await this.ports.saveState(this.state);

      // 代际已提交，再回收旧版与任何其他孤儿缓存（仅保留新激活缓存）。
      await this.reconcileCaches();

      this.setStatus({ kind: 'activated', version });
    } catch (err) {
      await this.failInstallation(version, cacheName, err);
    }
  }

  private async failInstallation(failedVersion: string, failedCacheName: string, err: unknown) {
    const code = toFailureCode(err);
    // 失败绝不触碰已激活代际；只登记并清除本次未激活缓存。
    this.state = { ...this.state, pending: null };
    await this.ports.saveState(this.state);
    await this.safeDelete(failedCacheName);
    await this.reconcileCaches();
    this.setStatus({ kind: 'failed', version: failedVersion, code });
  }

  async cancel(): Promise<void> {
    const controller = this.currentController;
    if (controller && !controller.signal.aborted) {
      const status = this.snapshot.status;
      if (status.kind === 'installing') {
        this.setStatus({ ...status, cancelRequested: true });
      }
      controller.abort();
      return;
    }
    // 本页未持有安装但正处于安装状态：安装在他页进行，转发取消请求。
    if (this.snapshot.status.kind === 'installing') {
      this.ports.postSync({ type: 'cancel-request' });
    }
  }
}
