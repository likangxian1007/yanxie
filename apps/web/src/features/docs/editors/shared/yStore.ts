import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';

/**
 * 把一个 Yjs 共享类型变成 React 外部 store：observeDeep 触发时标脏，下次 getSnapshot 再读。
 * 本地、远端（其他成员、agent 工具）的修改都会走到这里，所以编辑器永远显示最新内容。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs 的事件类型参数是逆变的，只能用 any 接住所有共享类型
export type AnyYType = Y.AbstractType<any>;

export interface YStore<T> {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => T;
}

export function createYStore<T>(type: AnyYType, read: () => T): YStore<T> {
  let snapshot: T | undefined;
  let dirty = true;
  const listeners = new Set<() => void>();
  const onChange = () => {
    dirty = true;
    listeners.forEach((l) => l());
  };
  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        type.observeDeep(onChange);
        // 订阅前的空窗期里可能有改动：强制下一次重新读
        dirty = true;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          type.unobserveDeep(onChange);
          dirty = true;
        }
      };
    },
    getSnapshot() {
      if (dirty) {
        snapshot = read();
        dirty = false;
      }
      return snapshot as T;
    },
  };
}

/** 订阅 Yjs 类型，返回 read() 的快照；read 应只依赖 type（用模块级函数或 useCallback）。 */
export function useYSnapshot<T, Y2 extends AnyYType>(type: Y2, read: (type: Y2) => T): T {
  const store = useMemo(() => createYStore(type, () => read(type)), [type, read]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** 每个编辑器实例一个 origin：本地事务带上它，UndoManager 只追踪它。 */
export function useLocalOrigin(name: string): { editor: string } {
  return useMemo(() => ({ editor: name }), [name]);
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Y.UndoManager（只追踪本地 origin）。返回 undo/redo 函数和可用状态。
 * 在 effect 里创建、卸载时销毁（StrictMode 安全）。
 */
export function useYUndo(scope: Array<AnyYType>, origin: unknown, captureTimeout = 500) {
  const umRef = useRef<Y.UndoManager | null>(null);
  const [state, setState] = useState<UndoState>({ canUndo: false, canRedo: false });
  // scope 是数组：按成员身份比较
  const [first, second, third] = scope;
  useEffect(() => {
    const types = [first, second, third].filter((t): t is AnyYType => Boolean(t));
    if (types.length === 0) return;
    const um = new Y.UndoManager(types, {
      trackedOrigins: new Set([origin]),
      captureTimeout,
    });
    umRef.current = um;
    const sync = () =>
      setState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 });
    um.on('stack-item-added', sync);
    um.on('stack-item-popped', sync);
    um.on('stack-cleared', sync);
    return () => {
      um.off('stack-item-added', sync);
      um.off('stack-item-popped', sync);
      um.off('stack-cleared', sync);
      um.destroy();
      if (umRef.current === um) umRef.current = null;
    };
  }, [first, second, third, origin, captureTimeout]);

  const actions = useMemo(
    () => ({
      undo: () => {
        umRef.current?.undo();
      },
      redo: () => {
        umRef.current?.redo();
      },
      /** 结束当前合并窗口：下一次修改单独成为一步撤销 */
      stopCapturing: () => umRef.current?.stopCapturing(),
    }),
    [],
  );
  return { ...state, ...actions };
}
