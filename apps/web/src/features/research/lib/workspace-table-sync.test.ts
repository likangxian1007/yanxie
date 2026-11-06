import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearClosedTableSessions,
  clearTablePending,
  closeTableSession,
  hasPendingTable,
  markTablePending,
  rememberTableSynced,
  tableSyncKey,
} from './workspace-table-sync';

describe('协作表格未同步标记', () => {
  const key = tableSyncKey('u', 'p', 'r', 'i');
  beforeEach(() => {
    localStorage.clear();
    clearTablePending(key, 'one');
    clearTablePending(key, 'two');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const reset = new Y.Doc();
    const snapshot = Y.encodeSnapshot(Y.snapshot(reset));
    markTablePending(key, 'two', snapshot, false);
    rememberTableSynced(key, snapshot);
    clearTablePending(key, 'two');
    reset.destroy();
  });
  it('一个会话同步后不能清除另一个会话的未同步标记', () => {
    const doc = new Y.Doc();
    const vector = Y.encodeSnapshot(Y.snapshot(doc));
    markTablePending(key, 'one', vector, false);
    markTablePending(key, 'two', vector, false);
    clearTablePending(key, 'one');
    expect(hasPendingTable(key)).toBe(true);
    clearTablePending(key, 'two');
    expect(hasPendingTable(key)).toBe(false);
    doc.destroy();
  });
  it('关闭的旧会话只有在恢复并同步包含其修改后才能清除', () => {
    const edited = new Y.Doc();
    edited.getText('x').insert(0, '待同步');
    const other = new Y.Doc();
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(edited)), false);
    closeTableSession(key, 'one');
    clearClosedTableSessions(key, 'two', Y.encodeSnapshot(Y.snapshot(other)));
    expect(hasPendingTable(key)).toBe(true);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(edited));
    clearClosedTableSessions(key, 'two', Y.encodeSnapshot(Y.snapshot(other)));
    expect(hasPendingTable(key)).toBe(false);
    edited.destroy();
    other.destroy();
  });
  it('只推进删除集的修改也必须被恢复并确认', () => {
    const edited = new Y.Doc();
    edited.getText('x').insert(0, '删除');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(edited));
    edited.getText('x').delete(0, 2);
    expect(Y.encodeStateVector(edited)).toEqual(Y.encodeStateVector(other));
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(edited)), false);
    closeTableSession(key, 'one');
    clearClosedTableSessions(key, 'two', Y.encodeSnapshot(Y.snapshot(other)));
    expect(hasPendingTable(key)).toBe(true);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(edited));
    clearClosedTableSessions(key, 'two', Y.encodeSnapshot(Y.snapshot(other)));
    expect(hasPendingTable(key)).toBe(false);
    edited.destroy();
    other.destroy();
  });
  it('无 Web Lock 时旧会话的修改被确认后可恢复，新修改仍会阻止运行', () => {
    const old = new Y.Doc();
    old.getText('x').insert(0, '原修改');
    const recovered = new Y.Doc();
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(old)), false);
    rememberTableSynced(key, Y.encodeSnapshot(Y.snapshot(recovered)));
    expect(hasPendingTable(key)).toBe(true);
    Y.applyUpdate(recovered, Y.encodeStateAsUpdate(old));
    rememberTableSynced(key, Y.encodeSnapshot(Y.snapshot(recovered)));
    expect(hasPendingTable(key)).toBe(false);
    old.getText('x').delete(0, 1);
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(old)), false);
    expect(hasPendingTable(key)).toBe(true);
    clearTablePending(key, 'one');
    old.destroy();
    recovered.destroy();
  });
  it('读取时优先使用跨标签页更新后的存储标记', () => {
    const doc = new Y.Doc();
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(doc)), false);
    localStorage.removeItem(`${key}one`);
    expect(hasPendingTable(key)).toBe(false);
    clearTablePending(key, 'one');
    doc.destroy();
  });
  it('本机存储写入失败时优先使用更新的内存标记，而不是旧值', () => {
    const doc = new Y.Doc();
    const initial = Y.encodeSnapshot(Y.snapshot(doc));
    markTablePending(key, 'one', initial, false);
    rememberTableSynced(key, initial);
    doc.getText('x').insert(0, '新的未同步修改');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(doc)), false)).toBe(false);
    expect(hasPendingTable(key)).toBe(true);
    clearTablePending(key, 'one');
    doc.destroy();
  });
  it('已同步快照写入失败时使用本页最新确认状态', () => {
    const doc = new Y.Doc();
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(doc)), false);
    rememberTableSynced(key, Y.encodeSnapshot(Y.snapshot(doc)));
    doc.getText('x').insert(0, '已确认');
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(doc)), false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    rememberTableSynced(key, Y.encodeSnapshot(Y.snapshot(doc)));
    expect(hasPendingTable(key)).toBe(false);
    clearTablePending(key, 'one');
    doc.destroy();
  });
  it('不同账号或项目互不干扰', () => {
    const doc = new Y.Doc();
    markTablePending(key, 'one', Y.encodeSnapshot(Y.snapshot(doc)), false);
    expect(hasPendingTable(tableSyncKey('other', 'p', 'r', 'i'))).toBe(false);
    clearTablePending(key, 'one');
    doc.destroy();
  });
});
