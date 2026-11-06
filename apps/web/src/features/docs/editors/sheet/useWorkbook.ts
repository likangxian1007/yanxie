import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { prepareWorkbook } from './model/migrate';
import { sheetTypes, type SheetTypes } from './model/schema';
import { Workbook } from './model/workbook';

/**
 * 工作簿 + 订阅：Yjs 任何变化（本地、其他成员、agent）都会让 version + 1，组件重绘。
 * 打开时做旧结构迁移 / 建默认表（确定 id，多人同时打开不会重复）。
 */
export function useWorkbook(doc: Y.Doc, synced: boolean) {
  const wb = useMemo(() => new Workbook(doc), [doc]);
  useEffect(() => () => wb.destroy(), [wb]);
  // 同步完成后再迁移：避免在拿到服务端状态之前建出一张多余的空表
  useEffect(() => {
    if (synced) prepareWorkbook(doc);
  }, [doc, synced]);
  const version = useSyncExternalStore(wb.subscribe, wb.getVersion, wb.getVersion);
  return { wb, version };
}

function partsOf(t: SheetTypes): Y.AbstractType<Y.YEvent<never>>[] {
  return [t.rows, t.cols, t.cells, t.fmt, t.rowp, t.colp, t.merges, t.view, t.cache] as never[];
}

/**
 * 每人自己的撤销 / 重做（Y.UndoManager 只追踪本编辑器的 origin，别人的修改不会被撤掉）。
 * 新出现的工作表动态加进追踪范围。
 */
export function useSheetUndo(wb: Workbook, origin: unknown, version: number) {
  const umRef = useRef<Y.UndoManager | null>(null);
  const scoped = useRef(new Set<string>());
  const [state, setState] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const t = wb.t;
    const um = new Y.UndoManager([t.order, t.info, t.styles] as never[], {
      trackedOrigins: new Set([origin]),
      captureTimeout: 400,
    });
    umRef.current = um;
    scoped.current = new Set();
    const sync = () =>
      setState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 });
    um.on('stack-item-added', sync);
    um.on('stack-item-popped', sync);
    um.on('stack-cleared', sync);
    return () => {
      um.destroy();
      if (umRef.current === um) umRef.current = null;
    };
  }, [wb, origin]);
  // 工作表列表变化时补充追踪范围（包括所有曾经出现过的表，撤销删除表也能恢复内容）
  useEffect(() => {
    const um = umRef.current;
    if (!um) return;
    const ids = new Set([...wb.sheetIds(), ...wb.t.info.keys()]);
    for (const id of ids) {
      if (scoped.current.has(id)) continue;
      scoped.current.add(id);
      um.addToScope(partsOf(sheetTypes(wb.doc, id)));
    }
  }, [wb, version]);
  return useMemo(
    () => ({
      ...state,
      undo: () => umRef.current?.undo(),
      redo: () => umRef.current?.redo(),
      stopCapturing: () => umRef.current?.stopCapturing(),
      /** 新建表后立即把它加入追踪（否则第一次修改不会被记录） */
      track: (id: string) => {
        const um = umRef.current;
        if (!um || scoped.current.has(id)) return;
        scoped.current.add(id);
        um.addToScope(partsOf(sheetTypes(wb.doc, id)));
      },
    }),
    [state, wb],
  );
}
