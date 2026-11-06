import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Routine } from '@srh/shared';
import { Button, Dialog, Input, Select, Switch, Textarea, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import {
  describeSchedule,
  errorMessage,
  ROUTINE_TARGET_COORDINATOR,
  routineTargetOptions,
  validateSchedule,
} from '../lib';
import { useProjectThreads } from '../queries';
import { Field, InlineError } from './parts';
import { tr } from '@/lib/i18n';

export interface RoutineDialogProps {
  pid: string;
  /** null = 新建 */
  routine: Routine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRESETS: { label: string; value: string }[] = [
  { label: tr('工作日 9:00'), value: '0 9 * * 1-5' },
  { label: tr('每天 21:00'), value: '0 21 * * *' },
  { label: tr('每周一 10:00'), value: '0 10 * * 1' },
  { label: tr('每 6 小时'), value: 'every:21600000' },
];

/**
 * 新建 / 编辑定时任务。外层用 key 区分“新建”和各条任务，打开时表单从 routine 初始化。
 */
export function RoutineDialog({ pid, routine, open, onOpenChange }: RoutineDialogProps) {
  const qc = useQueryClient();
  const ids = useId();
  const [title, setTitle] = useState(routine?.title ?? '');
  const [schedule, setSchedule] = useState(routine?.schedule ?? '0 9 * * 1-5');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [target, setTarget] = useState(routine?.targetThreadId ?? ROUTINE_TARGET_COORDINATOR);
  const [touched, setTouched] = useState(false);
  const threads = useProjectThreads(pid);
  const targetOptions = routineTargetOptions(threads.data, target, threads.isPending);
  const toCoordinator = target === ROUTINE_TARGET_COORDINATOR;

  const titleError = title.trim() ? null : tr('请填写任务名称');
  const scheduleError = validateSchedule(schedule);
  const promptError = prompt.trim() ? null : tr('请写下到点要做什么');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        schedule: schedule.trim(),
        prompt: prompt.trim(),
        targetThreadId: toCoordinator ? null : target,
        enabled,
      };
      return routine
        ? api.patch<Routine>(`/projects/${pid}/routines/${routine.id}`, body)
        : api.post<Routine>(`/projects/${pid}/routines`, body);
    },
    onSuccess: (r) => {
      qc.setQueryData<Routine[]>(qk.routines(pid), (list) => {
        if (!list) return list;
        return list.some((x) => x.id === r.id)
          ? list.map((x) => (x.id === r.id ? r : x))
          : [...list, r];
      });
      toast.success(
        routine ? tr('已保存定时任务') : tr('已新建定时任务「{title}」', { title: r.title }),
      );
      onOpenChange(false);
    },
  });

  const submit = () => {
    setTouched(true);
    if (titleError || scheduleError || promptError) return;
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="md"
      title={routine ? tr('编辑定时任务') : tr('新建定时任务')}
      description={tr('到点后会唤醒协调者（或你选的线程），把这段指令交给它开始工作。')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {routine ? tr('保存更改') : tr('新建定时任务')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={tr('任务名称')} htmlFor={`${ids}-title`}>
          <Input
            id={`${ids}-title`}
            data-autofocus
            value={title}
            maxLength={80}
            placeholder={tr('例如：每天整理新论文')}
            error={touched && titleError ? titleError : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <Field
          label={tr('时间表')}
          htmlFor={`${ids}-schedule`}
          hint={
            <span className="flex flex-col gap-1">
              <span>
                {tr('cron 表达式（项目时区，分 时 日 月 周），如')}{' '}
                <code className="rounded-xs bg-muted px-1 font-mono break-all text-fg-muted">
                  0 9 * * 1-5
                </code>{' '}
                {tr('表示工作日 9:00；')}
              </span>
              <span>
                <code className="rounded-xs bg-muted px-1 font-mono break-all text-fg-muted">
                  every:3600000
                </code>{' '}
                {tr('表示每隔一段毫秒数运行；')}
                <code className="rounded-xs bg-muted px-1 font-mono break-all text-fg-muted">
                  at:2026-11-01T09:00:00+08:00
                </code>{' '}
                {tr('表示只在这个时间运行一次。')}
              </span>
            </span>
          }
        >
          <Input
            id={`${ids}-schedule`}
            value={schedule}
            maxLength={100}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            error={touched && scheduleError ? scheduleError : undefined}
            onChange={(e) => setSchedule(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <Button
                key={p.value}
                size="sm"
                variant={schedule.trim() === p.value ? 'subtle' : 'ghost'}
                aria-pressed={schedule.trim() === p.value}
                onClick={() => setSchedule(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {!scheduleError && (
            <p className="text-caption text-accent-text">
              {tr('将会：{value}', { value: describeSchedule(schedule) })}
            </p>
          )}
        </Field>

        <Field
          label={tr('目标线程')}
          htmlFor={`${ids}-target`}
          hint={
            toCoordinator
              ? tr('到点唤醒协调者，由它决定交给谁做。')
              : tr('到点直接唤醒这个线程里的 agent，指令会发到线程里。')
          }
        >
          <Select
            id={`${ids}-target`}
            value={target}
            options={targetOptions}
            onChange={(e) => setTarget(e.target.value)}
          />
          {threads.isError && (
            <p className="text-caption font-normal text-fg-subtle">
              {tr('没能加载线程列表，暂时只能选协调者。')}
            </p>
          )}
        </Field>

        <Field
          label={toCoordinator ? tr('给协调者的指令') : tr('给线程的指令')}
          htmlFor={`${ids}-prompt`}
        >
          <Textarea
            id={`${ids}-prompt`}
            value={prompt}
            rows={5}
            autoGrow
            maxLength={10_000}
            placeholder={tr(
              '例如：检索 arXiv 上过去 24 小时与本项目相关的新论文，挑 3 篇写摘要发到协作台。',
            )}
            error={touched && promptError ? promptError : undefined}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-small font-medium text-fg">{tr('启用')}</p>
            <p className="text-caption font-normal text-fg-subtle">
              {tr('关闭后任务保留，但不会按时运行。')}
            </p>
          </div>
          <Switch label={tr('启用定时任务')} checked={enabled} onCheckedChange={setEnabled} />
        </div>

        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
