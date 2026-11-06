import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { tr } from '@/lib/i18n';

/** 文末脚注列表：按出现顺序编号，点编号回到正文里的脚注位置 */
export function FootnoteList({ editor }: { editor: Editor }) {
  const notes = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const out: { pos: number; content: string }[] = [];
      e.state.doc.descendants((node, pos) => {
        if (node.type.name === 'footnote')
          out.push({ pos, content: String(node.attrs.content ?? '') });
        return true;
      });
      return out;
    },
    equalityFn: (a, b) =>
      !!a &&
      !!b &&
      a.length === b.length &&
      a.every((n, i) => n.pos === b[i]!.pos && n.content === b[i]!.content),
  });
  if (!notes || notes.length === 0) return null;
  return (
    <section aria-label={tr('脚注')} className="rich-footnote-list">
      <ol>
        {notes.map((n, i) => (
          <li key={`${n.pos}-${i}`}>
            <button
              type="button"
              className="rich-footnote-list__num"
              aria-label={tr('回到脚注 {value}', { value: i + 1 })}
              onClick={() => {
                const { view } = editor;
                const pos = Math.min(n.pos + 1, editor.state.doc.content.size);
                view.dispatch(
                  editor.state.tr
                    .setSelection(TextSelection.create(editor.state.doc, pos))
                    .scrollIntoView(),
                );
                view.focus();
              }}
            >
              {i + 1}
            </button>
            <span className={n.content ? undefined : 'text-fg-subtle'}>
              {n.content || tr('（空脚注）')}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
