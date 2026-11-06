import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, EyeOff, List, Pencil, Plus, Trash2 } from 'lucide-react';
import { IconButton, Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export interface TabPeer {
  clientId: number;
  name: string;
  color: string;
}

export interface SheetTab {
  id: string;
  name: string;
  hidden?: boolean;
  peers: TabPeer[];
}

export interface SheetTabsProps {
  tabs: SheetTab[];
  current: string;
  editable: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMove: (id: string, to: number) => void;
  onHide: (id: string, hidden: boolean) => void;
}

/** 底部工作表标签：切换、新建、双击改名、拖动排序、右键菜单；显示每张表上有哪些协作者 */
export function SheetTabs(p: SheetTabsProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const visible = p.tabs.filter((t) => !t.hidden);
  const hidden = p.tabs.filter((t) => t.hidden);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当前表的标签滚进可视区
  const current = p.current;
  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(current)}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  const menuTab = menu ? p.tabs.find((t) => t.id === menu.id) : undefined;
  const menuIndex = menuTab ? visible.indexOf(menuTab) : -1;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-t border-line bg-canvas">
      {p.editable && (
        <IconButton
          label={tr('新建工作表')}
          size="sm"
          className="mx-1 self-center"
          onClick={p.onAdd}
        >
          <Plus strokeWidth={1.75} aria-hidden />
        </IconButton>
      )}
      <Menu
        label={tr('全部工作表')}
        side="top"
        trigger={
          <IconButton label={tr('全部工作表')} size="sm" className="mr-1 self-center">
            <List strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      >
        <MenuLabel>{tr('工作表')}</MenuLabel>
        {p.tabs.map((t) => (
          <MenuItem
            key={t.id}
            checked={t.id === p.current}
            description={t.hidden ? tr('已隐藏，选中后取消隐藏') : undefined}
            onSelect={() => {
              if (t.hidden && p.editable) p.onHide(t.id, false);
              p.onSelect(t.id);
            }}
          >
            {t.name}
          </MenuItem>
        ))}
      </Menu>
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={tr('工作表')}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
          const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-tab]'));
          let at = tabs.length;
          for (let i = 0; i < tabs.length; i += 1) {
            const r = tabs[i]!.getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) {
              at = i;
              break;
            }
          }
          setDropAt(at);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId !== null && dropAt !== null) {
            const from = visible.findIndex((t) => t.id === dragId);
            const to = dropAt > from ? dropAt - 1 : dropAt;
            // 换算成包含隐藏表的总下标
            const target = visible[to];
            const absolute = target ? p.tabs.indexOf(target) : p.tabs.length - 1;
            if (to !== from) p.onMove(dragId, absolute);
          }
          setDragId(null);
          setDropAt(null);
        }}
      >
        {visible.map((t, i) => {
          const selected = t.id === p.current;
          return (
            <div
              key={t.id}
              data-tab={t.id}
              className={cn(
                'relative flex shrink-0 items-center border-r border-line',
                dropAt === i && 'shadow-[inset_2px_0_0_var(--color-accent)]',
                dropAt === visible.length &&
                  i === visible.length - 1 &&
                  'shadow-[inset_-2px_0_0_var(--color-accent)]',
              )}
            >
              {renaming === t.id ? (
                <RenameInput
                  initial={t.name}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name !== null && name.trim() && name !== t.name) p.onRename(t.id, name);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  draggable={p.editable}
                  onDragStart={(e) => {
                    setDragId(t.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', t.name);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropAt(null);
                  }}
                  onClick={() => p.onSelect(t.id)}
                  onDoubleClick={() => p.editable && setRenaming(t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.onSelect(t.id);
                    setMenu({ id: t.id, x: e.clientX, y: e.clientY });
                  }}
                  className={cn(
                    'flex h-full max-w-48 items-center gap-1.5 px-3 text-small whitespace-nowrap transition-colors duration-(--dur-fast)',
                    selected
                      ? 'bg-surface font-medium text-accent-text shadow-[inset_0_2px_0_var(--color-accent)]'
                      : 'text-fg-muted hover:bg-subtle hover:text-fg',
                  )}
                >
                  <span className="truncate">{t.name}</span>
                  {t.peers.length > 0 && (
                    <span
                      className="flex -space-x-1"
                      aria-label={tr('{value} 在这张表', {
                        value: t.peers.map((x) => x.name).join(tr('、')),
                      })}
                    >
                      {t.peers.slice(0, 3).map((x) => (
                        <span
                          key={x.clientId}
                          title={x.name}
                          className="flex size-4 items-center justify-center rounded-full text-[10px] leading-none font-medium text-white ring-1 ring-surface"
                          style={{ backgroundColor: x.color }}
                        >
                          {x.name.slice(0, 1)}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <span className="hidden items-center px-2 text-caption text-fg-subtle sm:flex">
          {tr('已隐藏 {count} 张', { count: hidden.length })}
        </span>
      )}

      <Menu
        label={tr('工作表操作')}
        open={menu !== null}
        onOpenChange={(open) => !open && setMenu(null)}
        trigger={
          <span
            aria-hidden
            className="pointer-events-none fixed size-px"
            style={{ left: menu?.x ?? -10, top: menu?.y ?? -10 }}
          />
        }
      >
        {menuTab && (
          <>
            <MenuLabel>{menuTab.name}</MenuLabel>
            {p.editable ? (
              <>
                <MenuItem
                  icon={<Pencil strokeWidth={1.75} />}
                  onSelect={() => setRenaming(menuTab.id)}
                >
                  {tr('重命名')}
                </MenuItem>
                <MenuItem
                  icon={<Copy strokeWidth={1.75} />}
                  onSelect={() => p.onDuplicate(menuTab.id)}
                >
                  {tr('创建副本')}
                </MenuItem>
                <MenuItem
                  icon={<ChevronLeft strokeWidth={1.75} />}
                  disabled={menuIndex <= 0}
                  onSelect={() => p.onMove(menuTab.id, p.tabs.indexOf(visible[menuIndex - 1]!))}
                >
                  {tr('左移')}
                </MenuItem>
                <MenuItem
                  icon={<ChevronRight strokeWidth={1.75} />}
                  disabled={menuIndex < 0 || menuIndex >= visible.length - 1}
                  onSelect={() => p.onMove(menuTab.id, p.tabs.indexOf(visible[menuIndex + 1]!))}
                >
                  {tr('右移')}
                </MenuItem>
                <MenuItem
                  icon={<EyeOff strokeWidth={1.75} />}
                  disabled={visible.length <= 1}
                  onSelect={() => p.onHide(menuTab.id, true)}
                >
                  {tr('隐藏')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 strokeWidth={1.75} />}
                  danger
                  disabled={p.tabs.length <= 1}
                  onSelect={() => p.onDelete(menuTab.id)}
                >
                  {tr('删除')}
                </MenuItem>
              </>
            ) : (
              <MenuItem disabled>{tr('只读')}</MenuItem>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      aria-label={tr('工作表名称')}
      value={v}
      maxLength={31}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') finish(v);
        else if (e.key === 'Escape') finish(null);
      }}
      className="mx-1 h-7 w-32 rounded-sm border border-accent bg-surface px-2 text-small text-fg outline-none"
    />
  );
}
