import { useState, type KeyboardEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrowLeft, ArrowRight, Check, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { BoardColumn, Card } from '@srh/shared';
import {
  Badge,
  Button,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { PALETTE_NAMES, PALETTE_SIZE, paletteVar } from '@/lib/palette';
import { cardRenderKey, type BoardActions } from '../data';
import { SortableCard } from './SortableCard';
import { tr, trServer } from '@/lib/i18n';

/** 列宽：桌面 288，手机 85vw + scroll-snap */
export const COLUMN_WIDTH = 'w-[85vw] sm:w-72';

export interface BoardColumnViewProps {
  column: BoardColumn;
  /** 本列（筛选后）要显示的卡片，已排序 */
  cards: Card[];
  /** 本列卡片总数（未筛选） */
  total: number;
  filtering: boolean;
  writable: boolean;
  animateLayout: boolean;
  /** 只剩一列时不能删除 */
  deletable: boolean;
  /** 可以左移 / 右移（不是最左 / 最右一列） */
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  actions: BoardActions;
  onOpenCard: (cardId: string) => void;
  onRequestDelete: (column: BoardColumn) => void;
}

export function ColumnDot({ color, className }: { color: number | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', color === null && 'bg-fg-subtle', className)}
      style={color === null ? undefined : { backgroundColor: paletteVar(color) }}
    />
  );
}

export function BoardColumnView({
  column,
  cards,
  total,
  filtering,
  writable,
  animateLayout,
  deletable,
  canMoveLeft = false,
  canMoveRight = false,
  actions,
  onOpenCard,
  onRequestDelete,
}: BoardColumnViewProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    disabled: !writable,
    data: { type: 'column' },
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);

  const startRename = () => {
    setName(column.name);
    setRenaming(true);
  };
  const commitRename = () => {
    const next = name.trim().slice(0, 30);
    setRenaming(false);
    if (next && next !== column.name) void actions.updateColumn(column, { name: next });
  };
  const pickColor = (color: number) => {
    setMenuOpen(false);
    if (color !== column.color) void actions.updateColumn(column, { color });
  };

  return (
    <section
      aria-label={tr('{name}，{total} 张卡片', { name: trServer(column.name), total })}
      className={cn(
        'flex shrink-0 snap-start flex-col rounded-lg border border-line bg-subtle/70 md:max-h-[calc(100dvh-16rem)]',
        COLUMN_WIDTH,
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <ColumnDot color={column.color} />
        {renaming ? (
          <Input
            size="sm"
            autoFocus
            value={name}
            maxLength={30}
            aria-label={tr('列名')}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h3
            className="min-w-0 truncate text-small font-semibold text-fg"
            onDoubleClick={writable ? startRename : undefined}
          >
            {trServer(column.name)}
          </h3>
        )}
        {!renaming && (
          <Badge tone="neutral" animateKey={`${cards.length}/${total}`}>
            {filtering ? `${cards.length}/${total}` : total}
          </Badge>
        )}
        {writable && !renaming && (
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            label={tr('列「{name}」操作', { name: trServer(column.name) })}
            trigger={
              <IconButton label={tr('列操作')} size="sm" className="ml-auto">
                <MoreHorizontal strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem icon={<Pencil strokeWidth={1.75} />} onSelect={startRename}>
              {tr('重命名')}
            </MenuItem>
            <MenuItem
              icon={<ArrowLeft strokeWidth={1.75} />}
              disabled={!canMoveLeft}
              onSelect={() => void actions.moveColumn(column, -1)}
            >
              {tr('左移')}
            </MenuItem>
            <MenuItem
              icon={<ArrowRight strokeWidth={1.75} />}
              disabled={!canMoveRight}
              onSelect={() => void actions.moveColumn(column, 1)}
            >
              {tr('右移')}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{tr('颜色')}</MenuLabel>
            <div
              role="group"
              aria-label={tr('列颜色')}
              className="grid grid-cols-8 gap-1 px-2 pb-2"
            >
              {Array.from({ length: PALETTE_SIZE }, (_, i) => (
                <div
                  key={i}
                  role="menuitemradio"
                  aria-checked={column.color === i}
                  aria-label={PALETTE_NAMES[i]}
                  tabIndex={-1}
                  onClick={() => pickColor(i)}
                  onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pickColor(i);
                    }
                  }}
                  style={{ backgroundColor: paletteVar(i) }}
                  className="grid size-5 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-elevated"
                >
                  {column.color === i && (
                    <Check size={12} strokeWidth={2.5} aria-hidden className="text-accent-fg" />
                  )}
                </div>
              ))}
            </div>
            <MenuSeparator />
            <MenuItem
              danger
              disabled={!deletable}
              icon={<Trash2 strokeWidth={1.75} />}
              description={deletable ? undefined : tr('看板至少要保留一列')}
              onSelect={() => onRequestDelete(column)}
            >
              {tr('删除列')}
            </MenuItem>
          </Menu>
        )}
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-14 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2',
          'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
          isOver && 'bg-accent-soft/40',
        )}
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {cards.map((card) => (
              <SortableCard
                key={cardRenderKey(card.id)}
                card={card}
                draggable={writable}
                animateLayout={animateLayout}
                onOpen={onOpenCard}
              />
            ))}
          </AnimatePresence>
        </SortableContext>
        {cards.length === 0 && (
          <p className="rounded-md border border-dashed border-line-strong/70 px-3 py-5 text-center text-small text-fg-subtle">
            {filtering && total > 0
              ? tr('没有符合筛选的卡片')
              : writable
                ? tr('把卡片拖到这里')
                : tr('还没有卡片')}
          </p>
        )}
      </div>

      {writable && <AddCardInline columnId={column.id} actions={actions} />}
    </section>
  );
}

/** 列底“添加卡片”：内联输入，回车添加并保持打开，可以连续添加。 */
function AddCardInline({ columnId, actions }: { columnId: string; actions: BoardActions }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    void actions.createCard(columnId, t.slice(0, 200));
    setTitle('');
  };

  if (!open) {
    return (
      <div className="shrink-0 px-2 pb-2">
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          className="justify-start hover:bg-muted"
          leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
          onClick={() => setOpen(true)}
        >
          {tr('添加卡片')}
        </Button>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-2 pb-2">
      <Textarea
        autoFocus
        autoGrow
        rows={2}
        value={title}
        maxLength={200}
        aria-label={tr('新卡片标题')}
        placeholder={tr('输入标题，回车添加')}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
            setTitle('');
          }
        }}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        className="text-small"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          disabled={!title.trim()}
        >
          {tr('添加卡片')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setTitle('');
          }}
        >
          {tr('取消')}
        </Button>
      </div>
    </div>
  );
}
