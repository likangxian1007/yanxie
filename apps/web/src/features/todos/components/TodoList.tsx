import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { Todo } from '@srh/shared';
import type { TodoActions } from '../data';
import { TodoRow, type TodoRowProps } from './TodoRow';
import { tr } from '@/lib/i18n';

/** 只允许上下拖（不引入 @dnd-kit/modifiers） */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type RowShared = Omit<TodoRowProps, 'todo' | 'justCompleted' | 'highlighted' | 'handle'>;

export interface TodoListProps extends RowShared {
  todos: Todo[];
  /** 可拖动排序（按顺序视图、可写） */
  sortable: boolean;
  completing: ReadonlySet<string>;
  highlightId: string | null;
  actions: TodoActions;
  label: string;
}

/** 待办列表；sortable 时用 dnd-kit 拖动排序，放下后 PATCH afterTodoId */
export function TodoList({
  todos,
  sortable,
  completing,
  highlightId,
  actions,
  label,
  ...shared
}: TodoListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const animateLayout = !draggingId && !settling;
  const titleOf = (id: string | number) =>
    todos.find((t) => t.id === String(id))?.title ?? tr('待办');
  const positionOf = (id: string | number) => todos.findIndex((t) => t.id === String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      tr('已拿起「{value}」，当前第 {value2} 项。', {
        value: titleOf(active.id),
        value2: positionOf(active.id),
      }),
    onDragOver: ({ active, over }) =>
      over
        ? tr('「{value}」移到第 {value2} 项。', {
            value: titleOf(active.id),
            value2: positionOf(over.id),
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? tr('「{value}」放在了第 {value2} 项。', {
            value: titleOf(active.id),
            value2: positionOf(over.id),
          })
        : tr('已放回原处。'),
    onDragCancel: ({ active }) => tr('已取消移动「{value}」。', { value: titleOf(active.id) }),
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingId(null);
    setSettling(true);
    window.setTimeout(() => setSettling(false), 360);
    if (!over || active.id === over.id) return;
    const ids = todos.map((t) => t.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = arrayMove(ids, from, to);
    const after = to > 0 ? (next[to - 1] ?? null) : null;
    void actions.moveTodo(String(active.id), after);
  };

  const rows = todos.map((todo) =>
    sortable ? (
      <SortableTodoRow
        key={todo.id}
        todo={todo}
        actions={actions}
        justCompleted={completing.has(todo.id)}
        highlighted={todo.id === highlightId}
        {...shared}
        animateLayout={animateLayout}
      />
    ) : (
      <TodoRow
        key={todo.id}
        todo={todo}
        actions={actions}
        justCompleted={completing.has(todo.id)}
        highlighted={todo.id === highlightId}
        {...shared}
        animateLayout={animateLayout}
      />
    ),
  );

  const list = (
    <ul aria-label={label} className="research-list">
      <AnimatePresence initial={false}>{rows}</AnimatePresence>
    </ul>
  );

  if (!sortable) return list;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={({ active }) => setDraggingId(String(active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggingId(null)}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: tr('按空格键拿起，用上下方向键移动，再按空格键放下；按 Esc 取消。'),
        },
      }}
    >
      <SortableContext items={todos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  );
}

function SortableTodoRow(props: TodoRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.todo.id, disabled: !props.writable });
  return (
    <TodoRow
      {...props}
      nodeRef={setNodeRef}
      dragging={isDragging}
      dragStyle={{ transform: CSS.Translate.toString(transform), transition }}
      handle={
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-roledescription={tr('可拖动的待办')}
          aria-label={tr('拖动排序：{title}', { title: props.todo.title })}
          // 触屏上把手外扩一圈看不见的点击区（16×24 → 40×44），版面不变
          className="relative -ml-1 flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs text-fg-subtle opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing pointer-coarse:after:absolute pointer-coarse:after:-inset-x-3 pointer-coarse:after:-inset-y-2.5 [@media(hover:none)]:opacity-100"
        >
          <GripVertical size={14} strokeWidth={1.75} aria-hidden />
        </button>
      }
    />
  );
}
