/**
 * 离线演练纯逻辑（Vitest 覆盖）。
 * 规则：
 * - 只能搜索“当前版”故障条目；
 * - 条目的动作必须依序勾选，后续动作在前置动作完成前锁定；
 * - 只有所有动作依序完成，才给出与版本绑定的通过结论；
 * - 切换版本会终止未完成演练（清空进度与结论）。
 */
import type { FaultEntry } from './types';

export interface DrillSession {
  version: string;
  selectedEntryId: string | null;
  /** 已勾选到第几步（0..actions.length），严格依序。 */
  checkedUpTo: number;
  passed: boolean;
}

export const startDrill = (version: string): DrillSession => ({
  version,
  selectedEntryId: null,
  checkedUpTo: 0,
  passed: false,
});

/** 标题、症状、关键词的不区分大小写子串匹配；空白查询返回全部。 */
export function searchEntries(entries: FaultEntry[], query: string): FaultEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const hay = [e.title, e.symptoms, ...e.keywords].join('\n').toLowerCase();
    return hay.includes(q);
  });
}

export const selectEntry = (session: DrillSession, entry: FaultEntry): DrillSession => ({
  version: session.version,
  selectedEntryId: entry.id,
  checkedUpTo: 0,
  passed: false,
});

export const isActionUnlocked = (session: DrillSession, index: number): boolean =>
  session.selectedEntryId !== null && index === session.checkedUpTo && !session.passed;

/**
 * 勾选第 index 步：只有“当前应执行的下一步”可勾选。
 * 越序勾选被拒绝（返回原会话）；完成最后一步即产生绑定版本的通过结论。
 */
export function checkNext(
  session: DrillSession,
  entry: FaultEntry,
  index: number,
): DrillSession {
  if (!session.selectedEntryId || session.passed) return session;
  if (entry.id !== session.selectedEntryId) return session;
  if (index !== session.checkedUpTo) return session;
  const checkedUpTo = index + 1;
  return {
    ...session,
    checkedUpTo,
    passed: checkedUpTo >= entry.actions.length,
  };
}

/** 切换版本：终止未完成演练（完成的结论由调用方按版本另行归档）。 */
export const terminateOnVersionSwitch = (
  session: DrillSession | null,
  newVersion: string,
): DrillSession | null => {
  if (!session) return null;
  if (session.version === newVersion) return session;
  return null;
};

/** 与版本绑定的通过结论记录。 */
export interface PassRecord {
  version: string;
  entryId: string;
  entryTitle: string;
  totalActions: number;
  passedAt: number;
  /** 绑定版本与条目的结论码（FNV-1a），便于核对结论确实属于当前版。 */
  code: string;
}

export const passCode = (version: string, entryId: string, passedAt: number): string => {
  const input = `${version}|${entryId}|${passedAt}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

export const buildPassRecord = (
  session: DrillSession,
  entry: FaultEntry,
  now: number,
): PassRecord | null => {
  if (!session.passed || session.version === '' || entry.id !== session.selectedEntryId) {
    return null;
  }
  const passedAt = now;
  return {
    version: session.version,
    entryId: entry.id,
    entryTitle: entry.title,
    totalActions: entry.actions.length,
    passedAt,
    code: passCode(session.version, entry.id, passedAt),
  };
};
