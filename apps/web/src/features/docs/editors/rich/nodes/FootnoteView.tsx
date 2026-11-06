import { useState } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { Trash2 } from 'lucide-react';
import { Button, IconButton, Popover, Textarea } from '@/components/ui';
import { ICON_STROKE } from '../components/icons';
import { footnoteToOpen } from '../word/schema';
import { tr } from '@/lib/i18n';

/**
 * 脚注引用：正文里是上标编号（CSS 计数器按出现顺序编号），点开编辑脚注内容；文末有脚注列表（FootnoteList）。
 * 新插入的空脚注自动打开编辑框。
 */
function FootnoteView({ node, editor, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const content = String(node.attrs.content ?? '');
  const editable = editor.isEditable;
  const [open, setOpen] = useState(() => {
    if (!editable || footnoteToOpen.id !== node.attrs.id) return false;
    footnoteToOpen.id = null;
    return true;
  });
  const [draft, setDraft] = useState(content);
  const save = () => {
    if (draft !== content) updateAttributes({ content: draft.trim() });
  };
  return (
    <NodeViewWrapper
      as="sup"
      className="rich-footnote"
      data-footnote-id={String(node.attrs.id ?? '')}
    >
      <Popover
        label={tr('脚注')}
        open={open}
        onOpenChange={(o) => {
          if (o) setDraft(content);
          else if (editable) save();
          setOpen(o);
        }}
        trigger={
          <button
            type="button"
            data-node-interactive
            className="rich-footnote__ref"
            aria-label={content ? tr('脚注：{content}', { content }) : tr('脚注（空）')}
            title={content || tr('脚注')}
          />
        }
      >
        {(close) => (
          <div
            className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
            data-node-interactive
          >
            <span className="text-caption text-fg-subtle">{tr('脚注')}</span>
            {editable ? (
              <>
                <Textarea
                  data-autofocus
                  value={draft}
                  rows={3}
                  placeholder={tr('写下脚注内容')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      save();
                      close();
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <IconButton
                    size="sm"
                    label={tr('删除脚注')}
                    className="hover:bg-danger-soft hover:text-danger"
                    onClick={() => {
                      close();
                      deleteNode();
                    }}
                  >
                    <Trash2 strokeWidth={ICON_STROKE} />
                  </IconButton>
                  <Button
                    size="sm"
                    onClick={() => {
                      save();
                      close();
                    }}
                  >
                    {tr('完成')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-small whitespace-pre-wrap text-fg">{content || tr('（空）')}</p>
            )}
          </div>
        )}
      </Popover>
    </NodeViewWrapper>
  );
}

export const FootnoteNodeView = ReactNodeViewRenderer(FootnoteView, {
  as: 'span',
  className: 'rich-footnote-host',
  stopEvent: ({ event }) =>
    event.target instanceof Element && !!event.target.closest('[data-node-interactive]'),
  ignoreMutation: () => true,
});
