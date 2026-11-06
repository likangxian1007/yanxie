import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { AnyYType } from '../../shared/yStore';

/**
 * 整份幻灯片一个 Y.UndoManager（每个用户自己的）：追踪编辑器的本地 origin（画布操作）
 * 和 ySyncPluginKey（文本框里打字，由 Tiptap 的 ySyncPlugin 写入），
 * 所以 Ctrl+Z 在文本框里、在画布上都是同一个撤销栈；别人（和 agent）的修改不会被撤掉。
 */
export function useSlidesUndo(arr: AnyYType, meta: AnyYType, origin: unknown) {
  const umRef = useRef<Y.UndoManager | null>(null);
  const [state, setState] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const um = new Y.UndoManager([arr, meta], {
      trackedOrigins: new Set([origin, ySyncPluginKey]),
      captureTimeout: 500,
    });
    umRef.current = um;
    const sync = () =>
      setState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 });
    um.on('stack-item-added', sync);
    um.on('stack-item-popped', sync);
    um.on('stack-cleared', sync);
    return () => {
      um.destroy();
      if (umRef.current === um) umRef.current = null;
    };
  }, [arr, meta, origin]);
  const actions = useMemo(
    () => ({
      undo: () => {
        umRef.current?.undo();
      },
      redo: () => {
        umRef.current?.redo();
      },
      stopCapturing: () => umRef.current?.stopCapturing(),
    }),
    [],
  );
  return { ...state, ...actions };
}
