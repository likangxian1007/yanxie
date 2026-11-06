import { useId, useState } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileText, Pencil, Trash2 } from 'lucide-react';
import type { MemoryFile, MemoryType } from '@srh/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Markdown,
  RelativeTime,
  Select,
  Skeleton,
  Textarea,
  toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { removeMemoryCaches, upsertMemoryCaches } from '../cache';
import {
  errorMessage,
  MEMORY_MAX,
  MEMORY_TYPE_LABEL,
  MEMORY_TYPE_OPTIONS,
  memoryConflict,
  memoryFileUrl,
  parseMemoryType,
} from '../lib';
import { useMemoryFile } from '../queries';
import { ConfirmDialog, ErrorCard, Field, InlineError, ReadOnlyNote } from './parts';
import { locale, tr, trServer } from '@/lib/i18n';

interface Draft {
  content: string;
  description: string;
  type: MemoryType | null;
  baseVersion: number;
}

const toDraft = (f: MemoryFile): Draft => ({
  content: f.content,
  description: f.description,
  type: f.type,
  baseVersion: f.version,
});

export interface MemoryViewerProps {
  pid: string;
  path: string;
  editable: boolean;
  onDeleted: () => void;
}

/** 单个记忆文件：渲染 Markdown；负责人/导师可编辑，带乐观并发冲突处理。 */
export function MemoryViewer({ pid, path, editable, onDeleted }: MemoryViewerProps) {
  const qc = useQueryClient();
  const file = useMemoryFile(pid, path);
  const ids = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 409 时服务端返回的最新版本 */
  const [conflict, setConflict] = useState<MemoryFile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put<MemoryFile>(`/projects/${pid}/memory`, {
        path,
        content: d.content,
        description: d.description.trim(),
        type: d.type,
        baseVersion: d.baseVersion,
      }),
    onSuccess: (f) => {
      upsertMemoryCaches(qc, pid, f);
      setDraft(null);
      setConflict(null);
      toast.success(
        tr('已保存记忆'),
        tr('{path} 已更新到第 {version} 版。', { path: f.path, version: f.version }),
      );
    },
    onError: (err) => {
      const current = memoryConflict(err);
      if (!current) return;
      upsertMemoryCaches(qc, pid, current);
      setConflict(current);
      toast({
        tone: 'warning',
        title: tr('这份记忆刚被别人改过'),
        description: tr('{name} 已经把它更新到第 {version} 版，请选择保留哪一份。', {
          name: trServer(current.updatedBy.name),
          version: current.version,
        }),
      });
    },
  });

  const remove = useMutation({
    mutationFn: (version: number) =>
      api.delete(memoryFileUrl(pid, path), { query: { baseVersion: version } }),
    onSuccess: () => {
      setConfirmDelete(false);
      removeMemoryCaches(qc, pid, path);
      toast.success(tr('已删除记忆 {path}', { path }));
      onDeleted();
    },
    onError: (err) => {
      const current = memoryConflict(err);
      if (current) upsertMemoryCaches(qc, pid, current);
    },
  });

  if (file.isPending) {
    return (
      <Card aria-busy="true" aria-label={tr('正在加载记忆')} className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
      </Card>
    );
  }
  if (file.isError) {
    return (
      <ErrorCard
        error={file.error}
        onRetry={() => void file.refetch()}
        title={tr('没能打开这份记忆')}
      />
    );
  }

  const f = file.data;
  // 编辑期间有人更新了文件（实时事件），提前提示
  const latest = conflict ?? (draft && f.version !== draft.baseVersion ? f : null);
  const saveError = save.isError && !memoryConflict(save.error);
  const tooLong = draft ? draft.content.length > MEMORY_MAX : false;

  const header = (
    <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate font-mono text-h3 text-fg">{f.path}</h2>
          {f.type && <Badge tone="agent">{MEMORY_TYPE_LABEL[f.type]}</Badge>}
          <Badge tone="neutral">v{f.version}</Badge>
        </div>
        {f.description && <p className="mt-1 text-small text-fg-muted">{f.description}</p>}
        <p className="mt-1 text-caption font-normal text-fg-subtle">
          {trServer(f.updatedBy.name)} · <RelativeTime iso={f.updatedAt} />
          {tr(' 更新')}
        </p>
      </div>
      {editable && !draft && (
        <div className="flex shrink-0 items-center gap-2">
          {/* MEMORY.md 是索引，后端不允许删除 */}
          {f.path !== 'MEMORY.md' && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Trash2 strokeWidth={1.75} aria-hidden />}
              onClick={() => {
                remove.reset();
                setConfirmDelete(true);
              }}
            >
              {tr('删除')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Pencil strokeWidth={1.75} aria-hidden />}
            onClick={() => {
              save.reset();
              setConflict(null);
              setDraft(toDraft(f));
            }}
          >
            {tr('编辑')}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Card padding="none" className="min-w-0 overflow-hidden">
      {header}

      {draft ? (
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooLong) save.mutate(draft);
          }}
        >
          {latest && (
            <ConflictNotice
              latest={latest}
              saving={save.isPending}
              onTakeLatest={() => {
                setDraft(toDraft(latest));
                setConflict(null);
                save.reset();
              }}
              onKeepMine={() => {
                const next = { ...draft, baseVersion: latest.version };
                setDraft(next);
                setConflict(null);
                save.mutate(next);
              }}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field label={tr('一句话说明')} htmlFor={`${ids}-desc`}>
              <Input
                id={`${ids}-desc`}
                value={draft.description}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>
            <Field label={tr('类型')} htmlFor={`${ids}-type`}>
              <Select
                id={`${ids}-type`}
                value={draft.type ?? ''}
                options={MEMORY_TYPE_OPTIONS}
                onChange={(e) => setDraft({ ...draft, type: parseMemoryType(e.target.value) })}
              />
            </Field>
          </div>
          <Field
            label={tr('内容（Markdown）')}
            htmlFor={`${ids}-content`}
            hint={`${draft.content.length.toLocaleString(locale())} / ${MEMORY_MAX.toLocaleString(locale())}`}
          >
            <Textarea
              id={`${ids}-content`}
              data-autofocus
              value={draft.content}
              rows={14}
              autoGrow
              spellCheck={false}
              className="min-h-72 font-mono text-small leading-relaxed"
              error={tooLong ? tr('内容最多 {MEMORY_MAX} 个字符', { MEMORY_MAX }) : undefined}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {saveError && <InlineError>{errorMessage(save.error)}</InlineError>}
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                setConflict(null);
                save.reset();
              }}
            >
              {tr('取消')}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={tooLong}>
              {tr('保存记忆')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="p-4">
          {f.content.trim() ? (
            <Markdown>{f.content}</Markdown>
          ) : (
            <EmptyState
              icon={FileText}
              className="py-8"
              title={tr('这份记忆还是空的')}
              description={
                editable ? tr('点编辑写点内容，协调者之后就能读到。') : tr('还没有人写内容。')
              }
            />
          )}
          {!editable && (
            <div className="mt-4 border-t border-line pt-3">
              <ReadOnlyNote />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr('删除记忆 {path}？', { path: f.path })}
        description={tr('删除后协调者和 agent 都不会再读到这份记忆，无法恢复。')}
        confirmLabel={tr('删除记忆')}
        loading={remove.isPending}
        error={
          remove.isError
            ? memoryConflict(remove.error)
              ? tr('这份记忆刚被别人改过，已刷新到最新版本，确认无误后再删除。')
              : errorMessage(remove.error)
            : undefined
        }
        onConfirm={() => remove.mutate(f.version)}
      />
    </Card>
  );
}

function ConflictNotice({
  latest,
  saving,
  onTakeLatest,
  onKeepMine,
}: {
  latest: MemoryFile;
  saving: boolean;
  onTakeLatest: () => void;
  onKeepMine: () => void;
}) {
  // 与 ConflictBanner 同一套冲突预警动效；减少动态效果时不抖、竖条直接显示
  const { variants } = useMotionPreset();
  return (
    <motion.div
      role="alert"
      variants={variants.shake}
      initial="hidden"
      animate="visible"
      className="relative overflow-hidden rounded-lg border border-line bg-warning-soft py-3 pr-3 pl-4"
    >
      <motion.span
        aria-hidden
        variants={variants.growY}
        className="absolute inset-y-0 left-0 w-1 origin-top bg-warning"
      />
      <div className="flex items-start gap-2">
        <AlertTriangle
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-fg">
            {trServer(latest.updatedBy.name)}
            {tr(' 在 ')}
            <RelativeTime iso={latest.updatedAt} />
            {tr(' 把这份记忆更新到了第')} {latest.version}
            {tr(' 版')}
          </p>
          <p className="mt-0.5 text-small text-fg-muted">
            {tr('你的编辑基于旧版本。可以改用最新版本，或者保留你的编辑覆盖它。')}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-small text-accent-text">
              {tr('查看最新内容')}
            </summary>
            <div className="mt-2 max-h-60 overflow-y-auto rounded-md border border-line bg-surface px-3 py-2">
              {latest.content.trim() ? (
                <Markdown size="compact">{latest.content}</Markdown>
              ) : (
                <p className="text-small text-fg-subtle">{tr('（空）')}</p>
              )}
            </div>
          </details>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={onTakeLatest} disabled={saving}>
              {tr('用最新版本覆盖我的编辑')}
            </Button>
            <Button size="sm" variant="primary" onClick={onKeepMine} loading={saving}>
              {tr('保留我的编辑再保存')}
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
