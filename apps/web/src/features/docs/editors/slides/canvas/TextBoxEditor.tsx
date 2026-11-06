import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { SlidesCollab, slideTextExtensions } from './textExtensions';

export interface TextBoxEditorProps {
  fragment: Y.XmlFragment;
  awareness: Awareness | null;
  editing: boolean;
  label: string;
  onUndo: () => void;
  onRedo: () => void;
  /** 进入编辑时把光标放在哪：'end' 或点击位置（页面 client 坐标） */
  focusAt: { x: number; y: number } | 'end' | null;
  onEditor: (editor: Editor | null) => void;
  /** 内容高度变化（CSS px，未缩放），用于“随文字增高” */
  onContentHeight?: (px: number) => void;
}

/**
 * 文本框里的 Tiptap 编辑器。当前页的每个文本框都挂一个（不在编辑时 editable = false），
 * 这样别人在文本框里打字、他们的光标和选区都能实时看到；双击进入编辑。
 */
export function TextBoxEditor({
  fragment,
  awareness,
  editing,
  label,
  onUndo,
  onRedo,
  focusAt,
  onEditor,
  onContentHeight,
}: TextBoxEditorProps) {
  // onUndo / onRedo 是稳定的（整份幻灯片一个撤销管理器），直接交给扩展
  const cb = useRef({ onContentHeight });
  useEffect(() => {
    cb.current = { onContentHeight };
  });
  const editor = useEditor(
    {
      extensions: [
        ...slideTextExtensions(),
        SlidesCollab.configure({
          fragment,
          awareness,
          onUndo,
          onRedo,
        }),
      ],
      editable: false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'sl-text-body',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label,
        },
      },
    },
    [fragment, awareness, onUndo, onRedo],
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editing, false);
    if (editing) {
      onEditor(editor);
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        if (focusAt && focusAt !== 'end') {
          const pos = editor.view.posAtCoords({ left: focusAt.x, top: focusAt.y });
          if (pos) {
            editor.commands.focus();
            editor.commands.setTextSelection(pos.pos);
            return;
          }
        }
        editor.commands.focus('end');
      });
      return () => onEditor(null);
    }
    return undefined;
    // focusAt 只在进入编辑时用一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editing]);

  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !editing || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => cb.current.onContentHeight?.(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editing]);

  return (
    <div ref={boxRef} className="sl-editor-wrap" data-editing={editing || undefined}>
      <EditorContent editor={editor} />
    </div>
  );
}
