import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Trash2, X } from 'lucide-react';
import type { BoardColumn, Card } from '@srh/shared';
import {
  Button,
  IconButton,
  Input,
  Markdown,
  RelativeTime,
  Select,
  Sheet,
  Tabs,
  Textarea,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useThreads } from '@/lib/project';
import {
  AssigneePicker,
  describeAssignee,
  useAssigneeOptions,
} from '@/features/collab-kit/assignees';
import { SyncNotice } from '@/features/collab-kit/conflict/SyncNotice';
import { useFieldSync } from '@/features/collab-kit/conflict/use-field-sync';
import { type BoardActions, type CardPatch } from '../data';
import { isTempCard } from '../lib/board-state';
import { fromDateInputValue, isOverdue, toDateInputValue } from '../lib/due';
import { sortByPosition } from '../lib/position';
import { hasAgentAssignee } from '../lib/filter';
import { ColumnDot } from './BoardColumnView';
import { LabelEditor } from './LabelEditor';
import { tr, trServer } from '@/lib/i18n';

export interface CardDetailSheetProps {
  pid: string;
  /** undefined = 关闭 */
  card: Card | undefined;
  columns: BoardColumn[];
  allCards: Card[];
  labelSuggestions: string[];
  writable: boolean;
  actions: BoardActions;
  onClose: () => void;
}

const PROJECT_THREADS = { kind: 'project' } as const;

/** 卡片详情（右侧 Sheet）：标题行内编辑、列、指派、标签、截止、关联线程/实验、描述（可预览）、删除 */
export function CardDetailSheet({ card, ...rest }: CardDetailSheetProps) {
  // 关闭动画期间沿用最后一张卡的内容
  const [last, setLast] = useState(card);
  if (card && card !== last) setLast(card);
  const shown = card ?? last;
  const column = rest.columns.find((c) => c.id === shown?.columnId);

  return (
    <Sheet
      open={Boolean(card)}
      onOpenChange={(open) => {
        if (!open) rest.onClose();
      }}
      width="min(480px, 100vw)"
      title={
        <span className="inline-flex items-center gap-2">
          {column && <ColumnDot color={column.color} />}
          {column ? trServer(column.name) : tr('卡片')}
        </span>
      }
    >
      {shown && <CardDetailBody key={shown.id} card={shown} {...rest} />}
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3">
      <span className="pt-1.5 text-small text-fg-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CardDetailBody({
  pid,
  card: server,
  columns,
  allCards,
  labelSuggestions,
  writable,
  actions,
  onClose,
}: Omit<CardDetailSheetProps, 'card'> & { card: Card }) {
  const pending = isTempCard(server.id);
  const editable = writable && !pending;
  const sync = pending ? undefined : actions.cardSync(server.id);
  useFieldSync(sync, server);
  // 显示「服务端值 + 本地草稿」：别人的实时更新不会冲掉正在改的字段
  const card = sync ? sync.view(server) : server;
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descMode, setDescMode] = useState<'edit' | 'preview'>(
    card.description.trim() || !writable ? 'preview' : 'edit',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const threads = useThreads(pid, PROJECT_THREADS);
  const { byValue } = useAssigneeOptions(pid);

  // 关掉详情时把没保存的草稿发出去（冲突留在同步器里，重新打开还能处理）
  useEffect(() => () => void sync?.flush(), [sync]);

  /** 选择类字段：立刻保存 */
  const update = (patch: CardPatch) => {
    if (editable) actions.editCard(server.id, patch, { immediate: true });
  };

  const saveTitle = () => {
    setTitleDraft(null);
    void sync?.flush();
  };
  const cancelTitle = () => {
    setTitleDraft(null);
    sync?.discard('title');
  };
  const saveDescription = () => {
    void sync?.flush();
  };
  const formatAssignees = (ids: string[]) =>
    ids.length
      ? ids.map((id) => describeAssignee(id, byValue)?.label ?? tr('未知')).join(tr('、'))
      : tr('不指派');

  const moveToColumn = (columnId: string) => {
    if (columnId === card.columnId) return;
    const target = sortByPosition(allCards.filter((c) => c.columnId === columnId));
    void actions.moveCard(card.id, columnId, target[target.length - 1]?.id ?? null);
  };

  const threadOptions = threads.data ?? [];
  const linkedThreadMissing =
    card.threadId !== null && !threadOptions.some((t) => t.id === card.threadId);
  const overdue = isOverdue(card.dueAt);
  const description = card.description;
  const threadTitle = (id: string | null) =>
    id ? (threadOptions.find((t) => t.id === id)?.title ?? tr('已关联的线程')) : tr('不关联');

  return (
    <div className="flex flex-col gap-6 px-4 py-5 sm:px-5">
      {/* 标题 */}
      <div>
        {titleDraft !== null ? (
          <Textarea
            autoFocus
            autoGrow
            rows={1}
            value={titleDraft}
            maxLength={200}
            aria-label={tr('卡片标题')}
            onChange={(e) => {
              const v = e.target.value.replace(/\n/gu, '');
              setTitleDraft(v);
              const t = v.trim().slice(0, 200);
              if (t) actions.editCard(server.id, { title: t });
            }}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                saveTitle();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                cancelTitle();
              }
            }}
            className="min-h-0 px-2 py-1 text-h2"
          />
        ) : (
          <h3 className="text-h2 break-words text-fg">
            {editable ? (
              <button
                type="button"
                onClick={() => setTitleDraft(card.title)}
                className="-mx-2 w-[calc(100%+1rem)] cursor-text rounded-md px-2 py-1 text-left transition-colors duration-(--dur-fast) hover:bg-subtle"
                aria-label={tr('标题：{title}，点击编辑', { title: card.title })}
              >
                {card.title}
              </button>
            ) : (
              card.title
            )}
          </h3>
        )}
        {pending && <p className="mt-1 text-caption text-fg-subtle">{tr('正在保存…')}</p>}
        {sync && (
          <SyncNotice sync={sync} field="title" label={tr('标题')} manual className="mt-2" />
        )}
      </div>

      {sync && (
        <div className="flex flex-col gap-2 empty:hidden">
          <SyncNotice sync={sync} field="assigneeIds" label={tr('指派')} format={formatAssignees} />
          <SyncNotice
            sync={sync}
            field="labels"
            label={tr('标签')}
            format={(v) => v.join(tr('、'))}
          />
          <SyncNotice
            sync={sync}
            field="dueAt"
            label={tr('截止日期')}
            format={(v) => toDateInputValue(v) || tr('不设截止')}
          />
          <SyncNotice sync={sync} field="threadId" label={tr('关联线程')} format={threadTitle} />
        </div>
      )}

      {/* 属性 */}
      <div className="flex flex-col gap-3">
        <Field label={tr('所在列')}>
          <Select
            size="sm"
            value={card.columnId}
            disabled={!editable}
            aria-label={tr('所在列')}
            onChange={(e) => moveToColumn(e.target.value)}
            options={sortByPosition(columns).map((c) => ({ value: c.id, label: trServer(c.name) }))}
          />
        </Field>
        <Field label={tr('指派')}>
          <div className="flex flex-col items-start gap-1">
            <AssigneePicker
              multiple
              projectId={pid}
              disabled={!editable}
              value={card.assigneeIds}
              onChange={(ids) => update({ assigneeIds: ids })}
            />
            {hasAgentAssignee(card) && (
              <p className="text-caption font-normal text-agent-text">
                {tr('已指派给 agent，它会被唤醒来推进这张卡')}
              </p>
            )}
          </div>
        </Field>
        <Field label={tr('标签')}>
          <LabelEditor
            labels={card.labels}
            suggestions={labelSuggestions}
            disabled={!editable}
            onChange={(labels) => update({ labels })}
          />
        </Field>
        <Field label={tr('截止日期')}>
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              size="sm"
              aria-label={tr('截止日期')}
              disabled={!editable}
              value={toDateInputValue(card.dueAt)}
              onChange={(e) => update({ dueAt: fromDateInputValue(e.target.value) })}
              className={cn(overdue && 'text-danger')}
            />
            {card.dueAt && editable && (
              <IconButton
                label={tr('清除截止日期')}
                size="sm"
                onClick={() => update({ dueAt: null })}
              >
                <X strokeWidth={1.75} aria-hidden />
              </IconButton>
            )}
          </div>
          {overdue && <p className="mt-1 text-caption text-danger">{tr('已过期')}</p>}
        </Field>
        <Field label={tr('关联线程')}>
          <div className="flex items-center gap-1.5">
            <Select
              size="sm"
              aria-label={tr('关联线程')}
              disabled={!editable}
              value={card.threadId ?? ''}
              onChange={(e) => update({ threadId: e.target.value || null })}
            >
              <option value="">{tr('不关联')}</option>
              {linkedThreadMissing && (
                <option value={card.threadId ?? ''}>{tr('已关联的线程')}</option>
              )}
              {threadOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.resolved ? tr('{title}（已结束）', { title: t.title }) : t.title}
                </option>
              ))}
            </Select>
            {card.threadId && (
              <OpenLink to={`/p/${pid}/threads/${card.threadId}`} label={tr('打开线程')} />
            )}
          </div>
        </Field>
      </div>

      {/* 描述 */}
      <section aria-label={tr('描述')} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-h3 text-fg">{tr('描述')}</h4>
          {editable && (
            <Tabs
              variant="segmented"
              size="sm"
              aria-label={tr('描述编辑模式')}
              value={descMode}
              onValueChange={(v) => {
                if (v === 'preview') saveDescription();
                setDescMode(v);
              }}
              items={[
                { value: 'edit', label: tr('编辑') },
                { value: 'preview', label: tr('预览') },
              ]}
            />
          )}
        </div>
        {descMode === 'edit' && editable ? (
          <Textarea
            autoGrow
            rows={6}
            value={description}
            maxLength={20_000}
            aria-label={tr('描述（支持 Markdown）')}
            placeholder={tr('写下背景、验收标准、相关链接（支持 Markdown）')}
            onChange={(e) => actions.editCard(server.id, { description: e.target.value })}
            onBlur={saveDescription}
          />
        ) : description.trim() ? (
          <div className="rounded-md border border-line bg-surface px-3 py-2.5">
            <Markdown size="compact">{description}</Markdown>
          </div>
        ) : (
          <p className="text-small text-fg-subtle">{tr('还没有描述')}</p>
        )}
        {sync && <SyncNotice sync={sync} field="description" label={tr('描述')} manual />}
      </section>

      {/* 尾部 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4 text-caption font-normal text-fg-subtle">
        <span>
          {trServer(card.createdBy.name)}
          {tr(' 创建于 ')}
          <RelativeTime iso={card.createdAt} />
        </span>
        {card.updatedAt !== card.createdAt && (
          <span>
            {tr('更新于 ')}
            <RelativeTime iso={card.updatedAt} />
          </span>
        )}
        {editable &&
          (confirmDelete ? (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-small text-fg-muted">{tr('确定删除这张卡？')}</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                {tr('取消')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onClose();
                  void actions.deleteCard(card.id);
                }}
              >
                {tr('删除')}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              leftIcon={<Trash2 strokeWidth={1.75} aria-hidden />}
              onClick={() => setConfirmDelete(true)}
            >
              {tr('删除卡片')}
            </Button>
          ))}
      </div>
    </div>
  );
}

function OpenLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className="grid size-7 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors duration-(--dur-fast) hover:bg-subtle hover:text-fg"
    >
      <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden />
    </Link>
  );
}
