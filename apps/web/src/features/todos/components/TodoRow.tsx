import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, ChevronDown, Flag, Lock, Presentation, Trash2 } from 'lucide-react';
import type { Todo } from '@srh/shared';
import {
  Badge,
  IconButton,
  Input,
  RelativeTime,
  Select,
  Switch,
  Textarea,
  Tooltip,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { duration, ease, useMotionPreset } from '@/lib/motion';
import { AssigneeAvatar, AssigneePicker } from '@/features/collab-kit/assignees';
import {
  formatDue,
  fromDateInputValue,
  isOverdue,
  toDateInputValue,
} from '@/features/board/lib/due';
import type { TodoActions } from '../data';
import { PRIORITY_OPTIONS } from '../lib/todo-list';
import { TodoCheckbox } from './TodoCheckbox';
import { tr, trServer } from '@/lib/i18n';

export interface TodoRowProps {
  todo: Todo;
  pid: string;
  writable: boolean;
  actions: TodoActions;
  onToggle: (todo: Todo) => void;
  /** 刚勾选完成：对勾描线 + 行底 success-soft 闪一下 */
  justCompleted?: boolean;
  /** ?todo= 指向的项：高亮并滚动到可见 */
  highlighted?: boolean;
  animateLayout?: boolean;
  /** 拖动把手（排序模式）；有把手时左侧留出位置 */
  handle?: ReactNode;
  /** dnd-kit 的节点 ref 与位移 */
  nodeRef?: (node: HTMLElement | null) => void;
  dragStyle?: CSSProperties;
  dragging?: boolean;
}

const HOVER_REVEAL =
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';

/** 一条待办：复选框、标题（点击行内编辑）、优先级、截止、来源、个人锁、指派；展开可编辑备注与属性 */
export function TodoRow({
  todo,
  pid,
  writable,
  actions,
  onToggle,
  justCompleted,
  highlighted,
  animateLayout = true,
  handle,
  nodeRef,
  dragStyle,
  dragging,
}: TodoRowProps) {
  const { spring, variants, reduced } = useMotionPreset();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const overdue = !todo.done && isOverdue(todo.dueAt);

  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [highlighted, reduced]);

  const saveTitle = () => {
    const t = titleDraft?.trim().slice(0, 200);
    setTitleDraft(null);
    if (t && t !== todo.title) void actions.updateTodo(todo.id, { title: t });
  };

  const hasMeta =
    todo.priority === 'urgent' ||
    todo.priority === 'high' ||
    Boolean(todo.dueAt) ||
    todo.source?.kind === 'report' ||
    todo.ownerUserId !== null;

  return (
    <motion.li
      layout={animateLayout ? 'position' : false}
      transition={spring.gentle}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="research-row list-none"
      data-todo-id={todo.id}
      data-list-item={`todo:${todo.id}`}
    >
      <div
        ref={(node) => {
          rowRef.current = node;
          nodeRef?.(node);
        }}
        style={dragStyle}
        className={cn(
          'group relative transition-[background-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard)',
          !dragging && 'hover:bg-subtle',
          dragging && 'z-10 bg-surface shadow-md ring-1 ring-line',
          highlighted && 'bg-accent-soft/60 ring-1 ring-accent/40',
        )}
      >
        {justCompleted && todo.done && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md bg-success-soft"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: duration.slower, ease: ease.out }}
          />
        )}

        <div className="relative flex items-start gap-2 px-3 py-2.5">
          {handle}
          <span className="flex h-6 items-center">
            <TodoCheckbox
              checked={todo.done}
              title={todo.title}
              disabled={!writable}
              draw={justCompleted}
              onToggle={() => onToggle(todo)}
            />
          </span>

          <div className="min-w-0 flex-1">
            {titleDraft !== null ? (
              <Input
                size="sm"
                autoFocus
                value={titleDraft}
                maxLength={200}
                aria-label={tr('待办标题')}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setTitleDraft(null);
                  }
                }}
              />
            ) : writable && !todo.done ? (
              <button
                type="button"
                onClick={() => setTitleDraft(todo.title)}
                className="block min-h-6 w-full cursor-text rounded-xs text-left text-body break-words text-fg"
                aria-label={tr('{title}，点击编辑标题', { title: todo.title })}
              >
                {todo.title}
              </button>
            ) : (
              <p
                className={cn(
                  'min-h-6 text-body break-words',
                  todo.done ? 'text-fg-subtle line-through decoration-fg-subtle/60' : 'text-fg',
                )}
              >
                {todo.title}
              </p>
            )}

            {hasMeta && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption font-normal text-fg-subtle">
                {todo.priority === 'urgent' && (
                  <Badge tone="danger">
                    <Flag size={11} strokeWidth={2} aria-hidden />
                    {tr('紧急')}
                  </Badge>
                )}
                {todo.priority === 'high' && (
                  <Badge tone="warning">
                    <Flag size={11} strokeWidth={2} aria-hidden />
                    {tr('高')}
                  </Badge>
                )}
                {todo.dueAt && (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 tabular-nums',
                      overdue && 'font-medium text-danger',
                    )}
                  >
                    <CalendarDays size={13} strokeWidth={1.75} aria-hidden />
                    {overdue && <span className="sr-only">{tr('已过期，')}</span>}
                    {formatDue(todo.dueAt)}
                  </span>
                )}
                {todo.source?.kind === 'report' && (
                  <Link
                    to={`/p/${pid}/reports/${todo.source.id}`}
                    className="inline-flex h-5 items-center gap-1 rounded-xs bg-accent-soft px-1.5 text-accent-text transition-opacity duration-(--dur-fast) hover:opacity-80"
                  >
                    <Presentation size={12} strokeWidth={1.75} aria-hidden />
                    {tr('来自组会汇报')}
                  </Link>
                )}
                {todo.ownerUserId !== null && (
                  <Tooltip content={tr('个人待办，只有你能看到')}>
                    <span
                      className="inline-flex items-center gap-1"
                      role="img"
                      aria-label={tr('个人待办，只有你能看到')}
                    >
                      <Lock size={12} strokeWidth={1.75} aria-hidden />
                    </span>
                  </Tooltip>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {todo.assigneeId && (
              <AssigneeAvatar value={todo.assigneeId} projectId={pid} className="mr-1" />
            )}
            <IconButton
              label={expanded ? tr('收起') : tr('展开备注')}
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={cn(!expanded && !todo.notes && HOVER_REVEAL)}
            >
              <ChevronDown
                strokeWidth={1.75}
                aria-hidden
                className={cn(
                  'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                  expanded && 'rotate-180',
                )}
              />
            </IconButton>
            {writable && (
              <IconButton
                label={tr('删除待办')}
                size="sm"
                onClick={() => void actions.deleteTodo(todo.id)}
                className={HOVER_REVEAL}
              >
                <Trash2 strokeWidth={1.75} aria-hidden />
              </IconButton>
            )}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="details"
              variants={variants.fadeIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              className={cn('relative pr-2 pb-3', handle ? 'pl-14' : 'pl-9')}
            >
              <TodoDetails todo={todo} pid={pid} writable={writable} actions={actions} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  );
}

function TodoDetails({
  todo,
  pid,
  writable,
  actions,
}: {
  todo: Todo;
  pid: string;
  writable: boolean;
  actions: TodoActions;
}) {
  const [notes, setNotes] = useState<string | null>(null);
  const saveNotes = () => {
    if (notes !== null && notes !== todo.notes) void actions.updateTodo(todo.id, { notes });
    setNotes(null);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {writable ? (
        <Textarea
          autoGrow
          rows={2}
          maxLength={5000}
          aria-label={tr('备注')}
          placeholder={tr('添加备注，例如要用到的数据、注意事项')}
          value={notes ?? todo.notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          className="text-small"
        />
      ) : (
        <p className="text-small whitespace-pre-wrap text-fg-muted">
          {todo.notes || tr('没有备注')}
        </p>
      )}
      {writable && (
        <div className="flex flex-wrap items-center gap-2">
          <AssigneePicker
            projectId={pid}
            value={todo.assigneeId}
            onChange={(assigneeId) => void actions.updateTodo(todo.id, { assigneeId })}
          />
          <Select
            size="sm"
            wrapperClassName="w-24"
            aria-label={tr('优先级')}
            value={todo.priority}
            options={PRIORITY_OPTIONS}
            onChange={(e) =>
              void actions.updateTodo(todo.id, {
                priority: e.target.value as Todo['priority'],
              })
            }
          />
          <Input
            type="date"
            size="sm"
            wrapperClassName="w-36"
            aria-label={tr('截止日期')}
            value={toDateInputValue(todo.dueAt)}
            onChange={(e) =>
              void actions.updateTodo(todo.id, { dueAt: fromDateInputValue(e.target.value) })
            }
          />
          <label className="inline-flex items-center gap-2 text-small text-fg-muted">
            <Switch
              label={tr('仅自己可见')}
              checked={todo.ownerUserId !== null}
              onCheckedChange={(personal) => void actions.updateTodo(todo.id, { personal })}
            />
            {tr('仅自己可见')}
          </label>
        </div>
      )}
      <p className="text-caption font-normal text-fg-subtle">
        {trServer(todo.createdBy.name)}
        {tr(' 创建于 ')}
        <RelativeTime iso={todo.createdAt} />
        {todo.completedAt && (
          <>
            {' · '}
            {tr('完成于 ')}
            <RelativeTime iso={todo.completedAt} />
          </>
        )}
      </p>
    </div>
  );
}
