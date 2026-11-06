import { useEffect, useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { ListTree, Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ICON_STROKE } from '../components/icons';
import { collectHeadings, type HeadingEntry } from '../lib/outline';
import { pageNumberAt } from '../word/pagination';
import { tr } from '@/lib/i18n';

/** 目录条目加上 Word 式多级编号（1、1.1、1.1.1…，从最高一级开始数） */
export function numberHeadings(items: HeadingEntry[], maxLevel: number) {
  const shown = items.filter((h) => h.level <= maxLevel);
  const top = shown.length ? Math.min(...shown.map((h) => h.level)) : 1;
  const counters: number[] = [];
  return shown.map((h) => {
    const depth = h.level - top;
    counters.length = depth + 1;
    for (let i = 0; i < depth; i += 1) counters[i] ??= 1;
    counters[depth] = (counters[depth] ?? 0) + 1;
    return { ...h, depth, number: counters.join('.') };
  });
}

function useHeadings(editor: Editor): HeadingEntry[] {
  const [items, setItems] = useState(() => collectHeadings(editor.state.doc));
  useEffect(() => {
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!editor.isDestroyed) setItems(collectHeadings(editor.state.doc));
      }, 200);
    };
    editor.on('update', update);
    return () => {
      window.clearTimeout(timer);
      editor.off('update', update);
    };
  }, [editor]);
  return items;
}

/** 目录块：随标题实时更新，点击跳到对应标题；分页视图下显示页码 */
function TocView({ node, editor, selected, deleteNode }: ReactNodeViewProps) {
  const maxLevel = Number(node.attrs.maxLevel) || 3;
  const items = numberHeadings(useHeadings(editor), maxLevel);
  const editable = editor.isEditable;
  const jump = (pos: number) => {
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  return (
    <NodeViewWrapper
      data-type="toc"
      className={cn(
        'rich-toc my-2 rounded-lg border border-line bg-surface px-4 py-3',
        selected && editable && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
      )}
      contentEditable={false}
    >
      <div className="mb-2 flex items-center gap-2">
        <ListTree size={16} strokeWidth={ICON_STROKE} aria-hidden className="text-fg-muted" />
        <span className="flex-1 text-body font-semibold text-fg">{tr('目录')}</span>
        {editable && (
          <span data-node-interactive>
            <IconButton
              size="sm"
              label={tr('删除目录')}
              className="hover:bg-danger-soft hover:text-danger"
              onClick={() => deleteNode()}
            >
              <Trash2 strokeWidth={ICON_STROKE} />
            </IconButton>
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-small text-fg-subtle">
          {tr('文档里还没有标题，加上标题后目录会自动更新。')}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0" data-node-interactive>
          {items.map((h) => {
            const page = pageNumberAt(editor, h.pos);
            return (
              <li key={`${h.pos}`} style={{ paddingLeft: `${h.depth * 1.25}em` }}>
                <button
                  type="button"
                  onClick={() => jump(h.pos)}
                  className={cn(
                    'rich-toc-entry flex w-full min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-small hover:bg-subtle',
                    h.depth === 0 ? 'text-fg' : 'text-fg-muted',
                  )}
                >
                  <span className="shrink-0 tabular-nums text-fg-subtle">{h.number}</span>
                  <span className="min-w-0 truncate">{h.heading}</span>
                  <span aria-hidden className="rich-toc-leader min-w-4 flex-1" />
                  {page !== null && (
                    <span className="shrink-0 tabular-nums text-fg-subtle">{page}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </NodeViewWrapper>
  );
}

export const TocNodeView = ReactNodeViewRenderer(TocView, {
  stopEvent: ({ event }) =>
    event.target instanceof Element && !!event.target.closest('[data-node-interactive]'),
  ignoreMutation: () => true,
});
