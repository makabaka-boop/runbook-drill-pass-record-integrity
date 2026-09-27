import { useEffect, useState, useSyncExternalStore } from 'react';
import { InstallerCoordinator } from '../core/installer';
import { readState } from '../core/idb';
import { findEntry } from '../manuals';
import { createBrowserPorts } from '../platform/browser-ports';
import type { PersistedState, Snapshot } from '../core/types';

const coordinator = new InstallerCoordinator(createBrowserPorts());

/**
 * 端到端测试钩子：以编程方式触发与界面按钮完全相同的安装/取消路径，
 * 用于在两个页面间制造确定性的并发竞争；persisted 用于核对 IndexedDB 当前代际。
 * 与故障注入一样，生产构建中同样存在但不会被调用，不影响正常行为。
 */
declare global {
  interface Window {
    __manualKiosk?: {
      install: (version: string) => Promise<void>;
      cancel: () => Promise<void>;
      persisted: () => Promise<PersistedState>;
    };
  }
}

window.__manualKiosk = {
  install: (version: string) => {
    const entry = findEntry(version);
    return entry ? coordinator.install(entry) : Promise.resolve();
  },
  cancel: () => coordinator.cancel(),
  persisted: () => readState(),
};

/** 单例协调器：整个应用共享同一份安装状态；挂载时执行一次启动恢复。 */
export function useInstaller(): { snapshot: Snapshot; ready: boolean } {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    coordinator
      .init()
      .catch(() => undefined)
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const snapshot = useSyncExternalStore(
    (onChange) => coordinator.subscribe(() => onChange()),
    () => coordinator.getSnapshot(),
    () => coordinator.getSnapshot(),
  );

  return { snapshot, ready };
}

export { coordinator };
