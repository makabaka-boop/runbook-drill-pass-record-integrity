import { describe, expect, it } from 'vitest';
import {
  buildPassRecord,
  checkNext,
  isActionUnlocked,
  passCode,
  searchEntries,
  selectEntry,
  startDrill,
  terminateOnVersionSwitch,
  type DrillSession,
} from './drill';
import type { FaultEntry } from './types';

const entry = (id: string, versionPrefix = 'v1'): FaultEntry => ({
  id,
  title: id === 'ups' ? 'UPS 过载告警' : '列头柜跳闸',
  keywords: id === 'ups' ? ['UPS', '过载', '旁路'] : ['PDU', '跳闸', '断路器'],
  symptoms: id === 'ups' ? '负载率超过 100%，鸣响' : '某列机柜失电',
  actions: ['步骤甲', '步骤乙', '步骤丙'],
});

describe('searchEntries 搜索当前版故障条目', () => {
  const entries = [entry('ups'), entry('pdu')];

  it('空白查询返回全部', () => {
    expect(searchEntries(entries, '   ').map((e) => e.id)).toEqual(['ups', 'pdu']);
  });

  it('支持标题、症状、关键词的大小写不敏感匹配', () => {
    expect(searchEntries(entries, 'ups').map((e) => e.id)).toEqual(['ups']);
    expect(searchEntries(entries, '旁路').map((e) => e.id)).toEqual(['ups']);
    expect(searchEntries(entries, '失电').map((e) => e.id)).toEqual(['pdu']);
    expect(searchEntries(entries, '不存在')).toEqual([]);
  });
});

describe('依序勾选', () => {
  const e = entry('ups');

  it('未选择条目前任何步骤都锁定', () => {
    const s = startDrill('1.0.0');
    expect(isActionUnlocked(s, 0)).toBe(false);
  });

  it('只有第 0 步解锁，越序勾选被拒绝', () => {
    let s = selectEntry(startDrill('1.0.0'), e);
    expect(isActionUnlocked(s, 0)).toBe(true);
    expect(isActionUnlocked(s, 1)).toBe(false);
    const rejected = checkNext(s, e, 1);
    expect(rejected).toBe(s);

    s = checkNext(s, e, 0);
    expect(s.checkedUpTo).toBe(1);
    expect(isActionUnlocked(s, 1)).toBe(true);
    s = checkNext(s, e, 1);
    s = checkNext(s, e, 2);
    expect(s.checkedUpTo).toBe(3);
    expect(s.passed).toBe(true);
  });

  it('通过后不能继续勾选', () => {
    let s: DrillSession = selectEntry(startDrill('1.0.0'), e);
    s = checkNext(s, e, 0);
    s = checkNext(s, e, 1);
    s = checkNext(s, e, 2);
    expect(checkNext(s, e, 2)).toBe(s);
  });

  it('重新选择条目会重置进度', () => {
    let s = selectEntry(startDrill('1.0.0'), e);
    s = checkNext(s, e, 0);
    s = selectEntry(s, entry('pdu'));
    expect(s.checkedUpTo).toBe(0);
    expect(s.passed).toBe(false);
    expect(s.selectedEntryId).toBe('pdu');
  });

  it('通过结论与版本绑定，且包含确定性结论码', () => {
    let s = selectEntry(startDrill('2.0.0'), e);
    s = checkNext(s, e, 0);
    s = checkNext(s, e, 1);
    s = checkNext(s, e, 2);
    const record = buildPassRecord(s, e, 123456);
    expect(record).not.toBeNull();
    expect(record!.version).toBe('2.0.0');
    expect(record!.code).toBe(passCode('2.0.0', 'ups', 123456));
    expect(record!.code).toMatch(/^[0-9a-f]{8}$/);

    // 未通过时不产生结论
    const unfinished = selectEntry(startDrill('2.0.0'), e);
    expect(buildPassRecord(unfinished, e, 1)).toBeNull();
  });
});

describe('切换版本终止未完成演练', () => {
  const e = entry('ups');

  it('同版本保留会话', () => {
    let s = selectEntry(startDrill('1.0.0'), e);
    s = checkNext(s, e, 0);
    expect(terminateOnVersionSwitch(s, '1.0.0')).toBe(s);
  });

  it('不同版本终止未完成演练（返回 null）', () => {
    let s = selectEntry(startDrill('1.0.0'), e);
    s = checkNext(s, e, 0);
    expect(terminateOnVersionSwitch(s, '2.0.0')).toBeNull();
  });

  it('没有会话时保持 null', () => {
    expect(terminateOnVersionSwitch(null, '2.0.0')).toBeNull();
  });
});
