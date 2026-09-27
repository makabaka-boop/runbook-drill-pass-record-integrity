/**
 * IndexedDB 封装：只保存“当前代际与安装状态”一条记录。
 * 手册正文与任何资源都不写入 IndexedDB——离线读取由 Service Worker + Cache Storage 负责。
 * 该模块同时被页面与 Service Worker 使用。
 */
import type { PersistedState } from './types';
import { INITIAL_PERSISTED_STATE } from './types';

const DB_NAME = 'manual-kiosk-db';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'current';

type IDBFactoryLike = IDBFactory;

export function openStateDb(idbFactory: IDBFactoryLike = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

export async function readState(db?: IDBDatabase): Promise<PersistedState> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!stored || typeof stored !== 'object') {
      return { ...INITIAL_PERSISTED_STATE };
    }
    const s = stored as Partial<PersistedState>;
    return {
      activeVersion: typeof s.activeVersion === 'string' ? s.activeVersion : null,
      activeCacheName: typeof s.activeCacheName === 'string' ? s.activeCacheName : null,
      pending:
        s.pending && typeof s.pending === 'object' && typeof s.pending.version === 'string'
          ? {
              version: s.pending.version,
              cacheName: String(s.pending.cacheName),
              startedAt: Number(s.pending.startedAt) || 0,
            }
          : null,
    };
  } finally {
    if (owned) handle.close();
  }
}

export async function writeState(state: PersistedState, db?: IDBDatabase): Promise<void> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}
