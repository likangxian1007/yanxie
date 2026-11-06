import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarClock,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Routine } from '@srh/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  RelativeTime,
  Switch,
  toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { canManage, useMyRole } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import { describeRoutineTarget, describeSchedule, errorMessage } from '../lib';
import { useProjectThreads, useRoutines } from '../queries';
import { RoutineDialog } from './RoutineDialog';
import {
  ConfirmDialog,
  ErrorCard,
  ReadOnlyNote,
  SectionSkeleton,
  SettingsCard,
  When,
} from './parts';
import { tr } from '@/lib/i18n';

/** 编辑对话框：routine 为 null 表示新建；关闭时保留 routine，离场动画里不会闪成空表单 */
interface EditorState {
  open: boolean;
  routine: Routine | null;
  /** 每次打开换一个 key，让表单从 routine 重新初始化 */
  key: number;
}

export function RoutinesSection({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const routines = useRoutines(pid);
  const threads = useProjectThreads(pid);
  const editable = canManage(useMyRole(pid));
  const { variants, stagger } = useMotionPreset();
  const [editor, setEditor] = useState<EditorState>({ open: false, routine: null, key: 0 });
  const [deleting, setDeleting] = useState<Routine | null>(null);

  const setList = (fn: (list: Routine[]) => Routine[]) =>
    qc.setQueryData<Routine[]>(qk.routines(pid), (list) => (list ? fn(list) : list));

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Routine>(`/projects/${pid}/routines/${id}`, { enabled }),
    onMutate: ({ id, enabled }) => {
      setList((list) => list.map((r) => (r.id === id ? { ...r, enabled } : r)));
    },
    onSuccess: (r) => {
      setList((list) => list.map((x) => (x.id === r.id ? r : x)));
      toast.success(
        r.enabled
          ? tr('已启用「{title}」', { title: r.title })
          : tr('已暂停「{title}」', { title: r.title }),
      );
    },
    onError: (err, { id, enabled }) => {
      setList((list) => list.map((r) => (r.id === id ? { ...r, enabled: !enabled } : r)));
      toast.error(tr('没能切换定时任务'), errorMessage(err));
    },
  });

  const run = useMutation({
    mutationFn: (r: Routine) => api.post<void>(`/projects/${pid}/routines/${r.id}/run`),
    onSuccess: (_v, r) =>
      toast.success(
        tr('已开始运行「{title}」', { title: r.title }),
        r.targetThreadId === null
          ? tr('协调者正在处理，稍后可以在协作台看到结果。')
          : tr('线程里的 agent 正在处理，稍后可以在该线程里看到结果。'),
      ),
    onError: (err) => toast.error(tr('没能运行定时任务'), errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (r: Routine) => api.delete(`/projects/${pid}/routines/${r.id}`),
    onSuccess: (_v, r) => {
      setList((list) => list.filter((x) => x.id !== r.id));
      toast.success(tr('已删除定时任务「{title}」', { title: r.title }));
      setDeleting(null);
    },
  });

  const openEditor = (routine: Routine | null) =>
    setEditor((s) => ({ open: true, routine, key: s.key + 1 }));

  const newButton = editable ? (
    <Button
      variant="primary"
      size="sm"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => openEditor(null)}
    >
      {tr('新建定时任务')}
    </Button>
  ) : (
    <ReadOnlyNote />
  );

  let body: ReactNode;
  if (routines.isPending) body = <SectionSkeleton rows={3} />;
  else if (routines.isError)
    body = <ErrorCard error={routines.error} onRetry={() => void routines.refetch()} />;
  else if (routines.data.length === 0)
    body = (
      <EmptyState
        framed
        icon={CalendarClock}
        title={tr('还没有定时任务')}
        description={tr('让协调者按时做重复的事，例如工作日早上汇总新论文、每周五起草组会汇报。')}
        action={
          editable ? (
            <Button
              variant="primary"
              leftIcon={<Plus strokeWidth={2} aria-hidden />}
              onClick={() => openEditor(null)}
            >
              {tr('新建定时任务')}
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <motion.ul
        variants={stagger()}
        initial="hidden"
        animate="visible"
        aria-label={tr('定时任务')}
        className="flex flex-col gap-3"
      >
        {routines.data.map((r) => (
          <motion.li key={r.id} variants={variants.fadeUp}>
            <Card className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate text-h3 text-fg">
                      {r.title || tr('未命名任务')}
                    </h3>
                    {!r.enabled && <Badge tone="neutral">{tr('已暂停')}</Badge>}
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-small text-fg-muted">
                    <span>{describeSchedule(r.schedule)}</span>
                    <code className="font-mono text-caption break-all text-fg-subtle">
                      {r.schedule}
                    </code>
                  </p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption font-normal text-fg-subtle">
                    {r.targetThreadId === null ? (
                      <Bot size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                    ) : (
                      <MessagesSquare
                        size={12}
                        strokeWidth={1.75}
                        aria-hidden
                        className="shrink-0"
                      />
                    )}
                    <span className="min-w-0 truncate">
                      {describeRoutineTarget(r.targetThreadId, threads.data)}
                    </span>
                  </p>
                </div>
                <Switch
                  label={
                    r.enabled
                      ? tr('暂停「{title}」', { title: r.title })
                      : tr('启用「{title}」', { title: r.title })
                  }
                  checked={r.enabled}
                  disabled={!editable || (toggle.isPending && toggle.variables?.id === r.id)}
                  onCheckedChange={(enabled) => toggle.mutate({ id: r.id, enabled })}
                  className="mt-0.5"
                />
              </div>

              {r.prompt && (
                <p className="line-clamp-2 rounded-md bg-subtle px-3 py-2 text-small whitespace-pre-line text-fg-muted">
                  {r.prompt}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="text-caption font-normal text-fg-subtle">
                  {tr('上次运行：')}
                  {r.lastRunAt ? <RelativeTime iso={r.lastRunAt} /> : tr('还没运行过')}
                </p>
                <p className="text-caption font-normal text-fg-subtle">
                  {tr('下次运行：')}
                  {r.enabled && r.nextRunAt ? (
                    <When iso={r.nextRunAt} />
                  ) : r.enabled ? (
                    tr('无')
                  ) : (
                    tr('已暂停')
                  )}
                </p>
                {editable && (
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Play strokeWidth={1.75} aria-hidden />}
                      loading={run.isPending && run.variables?.id === r.id}
                      onClick={() => run.mutate(r)}
                    >
                      {tr('立即运行')}
                    </Button>
                    <Menu
                      align="end"
                      label={tr('{title} 的操作', { title: r.title })}
                      trigger={
                        <IconButton label={tr('更多操作')} size="sm">
                          <MoreHorizontal strokeWidth={1.75} aria-hidden />
                        </IconButton>
                      }
                    >
                      <MenuItem
                        icon={<Pencil strokeWidth={1.75} aria-hidden />}
                        onSelect={() => openEditor(r)}
                      >
                        {tr('编辑')}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                        onSelect={() => {
                          remove.reset();
                          setDeleting(r);
                        }}
                      >
                        {tr('删除')}
                      </MenuItem>
                    </Menu>
                  </div>
                )}
              </div>
            </Card>
          </motion.li>
        ))}
      </motion.ul>
    );

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('定时任务')}
        description={tr('按时间表唤醒协调者或指定线程。')}
        actions={newButton}
      />
      {body}

      {editable && (
        <RoutineDialog
          key={editor.key}
          pid={pid}
          routine={editor.routine}
          open={editor.open}
          onOpenChange={(v) => {
            if (!v) setEditor((s) => ({ ...s, open: false }));
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        title={tr('删除定时任务「{value}」？', { value: deleting?.title ?? '' })}
        description={tr('删除后不会再按时运行，已经产生的消息和产出会保留。')}
        confirmLabel={tr('删除任务')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
    </div>
  );
}
