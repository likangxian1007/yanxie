import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { cn } from '@/lib/cn';
import { dismissSlash, slashKey, type SlashBridge } from '../ext/slash';
import {
  SLASH_GROUP_LABEL,
  SLASH_ITEMS,
  filterSlashItems,
  type SlashItem,
} from '../lib/slash-items';
import { runSlashItem, type SlashContext } from '../commands';
import { FloatingPanel } from './FloatingPanel';
import { coordsAt } from './anchor';
import { ICON_STROKE, SLASH_ICON } from './icons';
import { tr } from '@/lib/i18n';

export interface SlashMenuProps {
  editor: Editor;
  bridge: SlashBridge;
  ctx: SlashContext;
}

interface SlashView {
  from: number;
  to: number;
  query: string;
}

/** 斜杠命令菜单：行首输入 “/” 弹出，输入过滤，上下键选择，回车执行，Esc 关闭。 */
export function SlashMenu({ editor, bridge, ctx }: SlashMenuProps) {
  const slash = useEditorState({
    editor,
    selector: ({ editor: e }): SlashView | null => {
      const s = slashKey.getState(e.state);
      return s?.active ? { from: s.from, to: s.to, query: s.query } : null;
    },
  });
  if (!slash) return null;
  // query 变化时重置高亮项（换 key 重新挂载，而不是在 effect 里 setState）
  return (
    <SlashMenuList key={slash.query} editor={editor} bridge={bridge} ctx={ctx} slash={slash} />
  );
}

function SlashMenuList({ editor, bridge, ctx, slash }: SlashMenuProps & { slash: SlashView }) {
  const items = useMemo(() => filterSlashItems(SLASH_ITEMS, slash.query), [slash.query]);
  const [index, setIndex] = useState(0);
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const run = (item: SlashItem) => {
    runSlashItem(editor, item.id, { from: slash.from, to: slash.to }, ctx);
  };
  const latest = useRef({ items, index, run });
  useEffect(() => {
    latest.current = { items, index, run };
  });

  useEffect(() => {
    bridge.onKeyDown.set((event) => {
      const { items: list, index: i, run: exec } = latest.current;
      if (event.key === 'Escape') {
        editor.view.dispatch(dismissSlash(editor.state));
        return true;
      }
      if (list.length === 0) return false;
      if (event.key === 'ArrowDown') {
        setIndex((i + 1) % list.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setIndex((i - 1 + list.length) % list.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = list[i];
        if (item) exec(item);
        return true;
      }
      return false;
    });
    return () => bridge.onKeyDown.set(null);
  }, [bridge, editor]);

  // 滚动 / 缩放时重新定位
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const anchor = coordsAt(editor.view, slash.from);
  const grouped = slash.query.trim() === '';

  return (
    <FloatingPanel
      anchor={anchor}
      role="listbox"
      label={tr('插入命令')}
      className="w-64"
      onDismiss={() => editor.view.dispatch(dismissSlash(editor.state))}
    >
      <div ref={listRef} className="flex flex-col">
        {items.length === 0 && (
          <div className="px-2 py-2 text-small text-fg-subtle">
            {tr('没有匹配的命令，按 Esc 关闭')}
          </div>
        )}
        {items.map((item, i) => {
          const Icon = SLASH_ICON[item.id];
          const prev = items[i - 1];
          const showGroup = grouped && (!prev || prev.group !== item.group);
          const active = i === index;
          return (
            <div key={item.id}>
              {showGroup && (
                <div className="px-2 pt-1.5 pb-1 text-caption text-fg-subtle">
                  {SLASH_GROUP_LABEL[item.group]}
                </div>
              )}
              <div
                role="option"
                aria-selected={active}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(item)}
                className={cn(
                  'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 select-none',
                  'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                  active ? 'bg-subtle' : 'hover:bg-subtle',
                )}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface',
                    item.group === 'ai' ? 'text-agent' : 'text-fg-muted',
                  )}
                >
                  <Icon className="size-4" strokeWidth={ICON_STROKE} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-fg">{item.label}</span>
                  <span className="block truncate text-caption font-normal text-fg-subtle">
                    {item.description}
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </FloatingPanel>
  );
}
