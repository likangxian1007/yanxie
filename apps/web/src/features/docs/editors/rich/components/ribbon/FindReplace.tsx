import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ICON_STROKE } from '../icons';
import { getSearchState, type SearchOptions } from '../../word/search';
import { tr } from '@/lib/i18n';

/**
 * 查找与替换面板（Ctrl+F 查找、Ctrl+H 替换）：浮在正文右上角，不挡编辑。
 * 区分大小写 / 全字匹配 / 正则；Enter 下一个，Shift+Enter 上一个，Esc 关闭。
 */
export function FindReplace({
  editor,
  withReplace,
  onClose,
}: {
  editor: Editor;
  withReplace: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    const sel = empty ? '' : editor.state.doc.textBetween(from, to, ' ');
    return sel.length <= 100 && !sel.includes('\n') ? sel : '';
  });
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(withReplace);
  const [options, setOptions] = useState<SearchOptions>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const { count, current } = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const s = getSearchState(e.state);
      return { count: s.matches.length, current: s.current };
    },
  });
  const readOnly = !editor.isEditable;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [withReplace]);
  useEffect(() => {
    if (!editor.isDestroyed) editor.commands.setSearch(query, options);
  }, [editor, query, options]);
  useEffect(
    () => () => {
      if (!editor.isDestroyed) editor.commands.clearSearch();
    },
    [editor],
  );

  const toggle = (k: keyof SearchOptions) => setOptions((o) => ({ ...o, [k]: !o[k] }));
  const status = !query ? '' : count === 0 ? tr('无结果') : `${current + 1} / ${count}`;

  return (
    <div
      role="search"
      aria-label={tr('查找与替换')}
      className="flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 rounded-md border border-line bg-elevated p-2 shadow-md"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          editor.commands.focus();
        }
      }}
    >
      <div className="flex items-center gap-1">
        {!readOnly && (
          <IconButton
            size="sm"
            label={replaceOpen ? tr('收起替换') : tr('展开替换')}
            aria-expanded={replaceOpen}
            onClick={() => setReplaceOpen((o) => !o)}
          >
            <Replace strokeWidth={ICON_STROKE} />
          </IconButton>
        )}
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            aria-label={tr('查找内容')}
            placeholder={tr('查找')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) editor.commands.findPrevious();
                else editor.commands.findNext();
              }
            }}
            className="h-8 w-full rounded-sm border border-line-strong bg-surface pr-14 pl-2 text-small text-fg outline-none focus:border-accent"
          />
          <span
            aria-live="polite"
            className={cn(
              'pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-caption tabular-nums',
              count === 0 && query ? 'text-danger' : 'text-fg-subtle',
            )}
          >
            {status}
          </span>
        </div>
        <IconButton
          size="sm"
          label={tr('上一个')}
          shortcut="Shift+Enter"
          disabled={count === 0}
          onClick={() => editor.commands.findPrevious()}
        >
          <ChevronUp strokeWidth={ICON_STROKE} />
        </IconButton>
        <IconButton
          size="sm"
          label={tr('下一个')}
          shortcut="Enter"
          disabled={count === 0}
          onClick={() => editor.commands.findNext()}
        >
          <ChevronDown strokeWidth={ICON_STROKE} />
        </IconButton>
        <IconButton size="sm" label={tr('关闭查找')} shortcut="Esc" onClick={onClose}>
          <X strokeWidth={ICON_STROKE} />
        </IconButton>
      </div>
      <div className="flex items-center gap-1 pl-9">
        {(
          [
            ['caseSensitive', 'Aa', tr('区分大小写')],
            ['wholeWord', 'ab', tr('全字匹配')],
            ['regex', '.*', tr('正则表达式')],
          ] as const
        ).map(([k, text, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={!!options[k]}
            aria-label={label}
            title={label}
            onClick={() => toggle(k)}
            className={cn(
              'h-6 min-w-8 rounded-sm px-1.5 font-mono text-caption transition-colors duration-(--dur-fast)',
              options[k] ? 'bg-accent-soft text-accent-text' : 'text-fg-muted hover:bg-subtle',
            )}
          >
            {text}
          </button>
        ))}
      </div>
      {replaceOpen && !readOnly && (
        <div className="flex items-center gap-1 pl-9">
          <input
            aria-label={tr('替换为')}
            placeholder={tr('替换为')}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                editor.commands.replaceCurrent(replacement);
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-sm border border-line-strong bg-surface px-2 text-small text-fg outline-none focus:border-accent"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={current < 0}
            onClick={() => editor.commands.replaceCurrent(replacement)}
          >
            {tr('替换')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={count === 0}
            onClick={() => editor.commands.replaceAll(replacement)}
          >
            {tr('全部')}
          </Button>
        </div>
      )}
    </div>
  );
}
