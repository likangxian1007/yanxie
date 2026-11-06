import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGroup } from 'motion/react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { BoardColumn, Card } from '@srh/shared';
import { useMotionPreset } from '@/lib/motion';
import { PALETTE_SIZE } from '@/lib/palette';
import type { BoardActions } from '../data';
import { groupCards, sortColumns, type BoardDetail } from '../lib/board-state';
import { filterCards, isFilterActive, type CardFilter } from '../lib/filter';
import { BoardColumnView } from './BoardColumnView';
import { AddColumn, DeleteColumnDialog } from './BoardDialogs';
import { CardTile } from './CardTile';
import { tr } from '@/lib/i18n';

/** 列 id → 该列（筛选后）显示的卡片 id，拖动期间是本地草稿 */
type ColumnItems = Record<string, string[]>;

function findContainer(id: UniqueIdentifier, items: ColumnItems): string | undefined {
  const key = String(id);
  if (key in items) return key;
  return Object.keys(items).find((col) => items[col]?.includes(key));
}

export interface BoardCanvasProps {
  detail: BoardDetail;
  writable: boolean;
  filter: CardFilter;
  meId: string | null;
  actions: BoardActions;
  onOpenCard: (cardId: string) => void;
}

/** 横向列 + 卡片拖拽（列内/跨列，鼠标、触摸、键盘），放下时乐观更新并 PATCH。 */
export function BoardCanvas({
  detail,
  writable,
  filter,
  meId,
  actions,
  onOpenCard,
}: BoardCanvasProps) {
  const { reduced } = useMotionPreset();
  const columns = useMemo(() => sortColumns(detail.columns), [detail.columns]);
  const filtering = isFilterActive(filter);
  const grouped = useMemo(
    () => groupCards(filterCards(detail.cards, filter, meId), columns),
    [detail.cards, filter, meId, columns],
  );
  const totals = useMemo(() => groupCards(detail.cards, columns), [detail.cards, columns]);
  const cardById = useMemo(() => new Map(detail.cards.map((c) => [c.id, c])), [detail.cards]);
  const columnById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const baseItems = useMemo<ColumnItems>(
    () =>
      Object.fromEntries(columns.map((c) => [c.id, (grouped.get(c.id) ?? []).map((x) => x.id)])),
    [columns, grouped],
  );

  const [dragItems, setDragItems] = useState<ColumnItems | null>(null);
  const [active, setActive] = useState<{ id: string; version: number } | null>(null);
  const [settling, setSettling] = useState(false);
  const [deleting, setDeleting] = useState<BoardColumn | null>(null);
  const items = dragItems ?? baseItems;
  const activeCard = active ? cardById.get(active.id) : undefined;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const titleOf = (id: UniqueIdentifier) => cardById.get(String(id))?.title ?? tr('卡片');
  const columnNameOf = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return '';
    const col = findContainer(id, items);
    return (col && columnById.get(col)?.name) ?? '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => tr('已拿起卡片「{value}」。', { value: titleOf(a.id) }),
    onDragOver: ({ active: a, over }) =>
      over
        ? tr('卡片「{value}」移到了「{value2}」。', {
            value: titleOf(a.id),
            value2: columnNameOf(over.id),
          })
        : undefined,
    onDragEnd: ({ active: a, over }) =>
      over
        ? tr('卡片「{value}」放在了「{value2}」。', {
            value: titleOf(a.id),
            value2: columnNameOf(over.id),
          })
        : tr('卡片「{value}」放回了原处。', { value: titleOf(a.id) }),
    onDragCancel: ({ active: a }) => tr('已取消移动卡片「{value}」。', { value: titleOf(a.id) }),
  };

  const finish = () => {
    setActive(null);
    setDragItems(null);
    setSettling(true);
    window.setTimeout(() => setSettling(false), 360);
  };

  const onDragStart = ({ active: a }: DragStartEvent) => {
    const card = cardById.get(String(a.id));
    setActive({ id: String(a.id), version: card?.version ?? 0 });
    setDragItems(baseItems);
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    if (!over) return;
    setDragItems((prev) => {
      const src = prev ?? baseItems;
      const activeKey = String(a.id);
      const from = findContainer(a.id, src);
      const to = findContainer(over.id, src);
      if (!from || !to || from === to) return src;
      const toList = src[to] ?? [];
      const overKey = String(over.id);
      let index = toList.length;
      if (overKey !== to) {
        const overIndex = toList.indexOf(overKey);
        const translated = a.rect.current.translated;
        const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
        if (overIndex >= 0) index = overIndex + (below ? 1 : 0);
      }
      return {
        ...src,
        [from]: (src[from] ?? []).filter((id) => id !== activeKey),
        [to]: [...toList.slice(0, index), activeKey, ...toList.slice(index)],
      };
    });
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    const src = dragItems ?? baseItems;
    const activeKey = String(a.id);
    const from = findContainer(a.id, src);
    if (!over || !from) {
      finish();
      return;
    }
    let final = src;
    const to = findContainer(over.id, src);
    if (to === from) {
      const list = src[from] ?? [];
      const oldIndex = list.indexOf(activeKey);
      const newIndex = String(over.id) === to ? list.length - 1 : list.indexOf(String(over.id));
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        final = { ...src, [from]: arrayMove(list, oldIndex, newIndex) };
      }
    }
    const list = final[from] ?? [];
    const index = list.indexOf(activeKey);
    const after = index > 0 ? (list[index - 1] ?? null) : null;
    finish();
    void actions.moveCard(activeKey, from, after);
  };

  const usedColors = new Set(columns.map((c) => c.color));
  const nextColor =
    Array.from({ length: PALETTE_SIZE }, (_, i) => i).find((i) => !usedColors.has(i)) ??
    columns.length % PALETTE_SIZE;

  const deletingCount = deleting ? (totals.get(deleting.id)?.length ?? 0) : 0;
  const animateLayout = !active && !settling;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={finish}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: tr(
              '按空格键拿起卡片，用方向键移动，再按空格键放下；按 Esc 取消。按回车键打开详情。',
            ),
          },
        }}
      >
        <LayoutGroup id={`board-${detail.id}`}>
          <div className="-mx-4 flex min-w-0 snap-x snap-mandatory scroll-px-4 items-start gap-3 overflow-x-auto px-4 pb-4 md:-mx-6 md:snap-none md:px-6 lg:-mx-8 lg:px-8">
            {columns.map((column, index) => (
              <BoardColumnView
                key={column.id}
                column={column}
                canMoveLeft={index > 0}
                canMoveRight={index < columns.length - 1}
                cards={(items[column.id] ?? [])
                  .map((id) => cardById.get(id))
                  .filter((c): c is Card => c !== undefined)}
                total={totals.get(column.id)?.length ?? 0}
                filtering={filtering}
                writable={writable}
                animateLayout={animateLayout}
                deletable={columns.length > 1}
                actions={actions}
                onOpenCard={onOpenCard}
                onRequestDelete={setDeleting}
              />
            ))}
            {writable && <AddColumn actions={actions} nextColor={nextColor} />}
          </div>
        </LayoutGroup>
        {typeof document !== 'undefined' &&
          createPortal(
            <DragOverlay dropAnimation={reduced ? null : undefined}>
              {activeCard ? <CardTile card={activeCard} overlay /> : null}
            </DragOverlay>,
            document.body,
          )}
      </DndContext>

      <DeleteColumnDialog
        column={deleting}
        cardCount={deletingCount}
        otherColumns={columns.filter((c) => c.id !== deleting?.id)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={(moveTo) =>
          deleting ? actions.deleteColumn(deleting, moveTo) : Promise.resolve(false)
        }
      />
    </>
  );
}
