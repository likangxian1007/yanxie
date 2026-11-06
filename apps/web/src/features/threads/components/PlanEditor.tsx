import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import type { ChecklistMark, Thread } from '@srh/shared';
import { Button, IconButton, Input, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useUpdateThread } from '../thread-api';
import {
  MARK_LABEL,
  NEXT_MARK,
  PLAN_MAX_CHARS,
  draftFromText,
  draftToText,
  insertStep,
  moveStep,
  removeStep,
  samePlan,
  type PlanDraft,
} from './plan-edit';
import { tr } from '@/lib/i18n';

export interface PlanEditorProps {
  thread: Thread;
  /** 保存成功或取消后 */
  onDone: () => void;
  className?: string;
}

function MarkToggle({ mark, n, onClick }: { mark: ChecklistMark; n: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={tr('第 {n} 步：{value}，点一下改成{value2}', {
        n,
        value: MARK_LABEL[mark],
        value2: MARK_LABEL[NEXT_MARK[mark]],
      })}
      title={tr('{value}（点一下切换）', { value: MARK_LABEL[mark] })}
      className="press grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm hover:bg-subtle"
    >
      {mark === 'done' ? (
        <span className="grid size-5 place-items-center rounded-full bg-success-soft text-success">
          <Check size={12} strokeWidth={2.25} aria-hidden />
        </span>
      ) : (
        <span
          className={cn(
            'grid size-5 place-items-center rounded-full text-[11px] leading-none font-medium tabular-nums',
            mark === 'active'
              ? 'bg-accent text-accent-fg'
              : 'bg-surface text-fg-subtle ring-1 ring-line-strong ring-inset',
          )}
        >
          {n}
        </span>
      )}
    </button>
  );
}

/**
 * 计划的行内编辑：改目标、改写 / 增删步骤、上下移动、点圆点切换状态，保存后写回线程的状态清单。
 * agent 下一轮会读到这份计划；编辑期间 agent 改了计划时提示一句，可以载入最新版本。
 */
export function PlanEditor({ thread, onDone, className }: PlanEditorProps) {
  const [base, setBase] = useState(thread.statusText);
  const [draft, setDraft] = useState<PlanDraft>(() => draftFromText(thread.statusText));
  const focusKey = useRef<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const update = useUpdateThread(thread.projectId);
  const goalId = useId();
  const text = draftToText(draft);
  const tooLong = text.length > PLAN_MAX_CHARS;
  const stale = !samePlan(base, thread.statusText);

  // 新加的一步渲染出来之后再聚焦
  useEffect(() => {
    const key = focusKey.current;
    if (!key) return;
    focusKey.current = null;
    inputs.current.get(key)?.focus();
  });

  const setSteps = (fn: (steps: PlanDraft['steps']) => PlanDraft['steps']) =>
    setDraft((d) => ({ ...d, steps: fn(d.steps) }));

  const addAfter = (index: number) => {
    const steps = insertStep(draft.steps, index + 1);
    setDraft({ ...draft, steps });
    focusKey.current = steps[index + 1]!.key;
  };

  const onStepKey = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      addAfter(index);
    }
  };

  const save = () => {
    if (tooLong) return;
    if (samePlan(text, thread.statusText)) {
      onDone();
      return;
    }
    update.mutate(
      { id: thread.id, patch: { statusText: text } },
      {
        onSuccess: () => {
          toast({ title: tr('计划已保存'), description: tr('agent 下一轮会按新的计划继续。') });
          onDone();
        },
        onError: (e) => toast.error(tr('计划没保存'), e.message),
      },
    );
  };

  const reload = () => {
    setBase(thread.statusText);
    setDraft(draftFromText(thread.statusText));
  };

  return (
    <form
      aria-label={tr('编辑计划')}
      className={cn('flex min-w-0 flex-col gap-3', className)}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={goalId} className="text-caption text-fg-muted">
          {tr('目标')}
        </label>
        <Input
          id={goalId}
          size="sm"
          value={draft.goal}
          maxLength={300}
          placeholder={tr('这份计划要达成什么')}
          onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-caption text-fg-muted">{tr('步骤')}</p>
        {draft.steps.length === 0 ? (
          <p className="text-small text-fg-subtle">{tr('还没有步骤，点下面的「添加一步」。')}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {draft.steps.map((s, i) => (
              <li key={s.key} className="flex min-w-0 items-center gap-1">
                <MarkToggle
                  mark={s.mark}
                  n={i + 1}
                  onClick={() =>
                    setSteps((steps) =>
                      steps.map((x, j) => (j === i ? { ...x, mark: NEXT_MARK[x.mark] } : x)),
                    )
                  }
                />
                <Input
                  ref={(el) => {
                    if (el) inputs.current.set(s.key, el);
                    else inputs.current.delete(s.key);
                  }}
                  size="sm"
                  aria-label={tr('第 {value} 步', { value: i + 1 })}
                  value={s.text}
                  maxLength={300}
                  placeholder={tr('这一步做什么')}
                  wrapperClassName="min-w-0 flex-1"
                  onChange={(e) =>
                    setSteps((steps) =>
                      steps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                    )
                  }
                  onKeyDown={(e) => onStepKey(e, i)}
                />
                <span className="flex shrink-0 items-center">
                  <IconButton
                    size="sm"
                    label={tr('第 {value} 步上移', { value: i + 1 })}
                    tooltip={false}
                    disabled={i === 0}
                    onClick={() => setSteps((steps) => moveStep(steps, i, -1))}
                  >
                    <ArrowUp strokeWidth={1.75} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={tr('第 {value} 步下移', { value: i + 1 })}
                    tooltip={false}
                    disabled={i === draft.steps.length - 1}
                    onClick={() => setSteps((steps) => moveStep(steps, i, 1))}
                  >
                    <ArrowDown strokeWidth={1.75} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={tr('删除第 {value} 步', { value: i + 1 })}
                    tooltip={false}
                    onClick={() => setSteps((steps) => removeStep(steps, i))}
                  >
                    <Trash2 strokeWidth={1.75} />
                  </IconButton>
                </span>
              </li>
            ))}
          </ol>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
          onClick={() => addAfter(draft.steps.length - 1)}
          className="self-start"
        >
          {tr('添加一步')}
        </Button>
      </div>

      {stale && (
        <p className="rounded-md border border-warning/30 bg-warning-soft/60 px-3 py-2 text-caption font-normal text-pretty text-fg">
          {tr('你编辑的时候 agent 更新了计划，保存会用你的版本覆盖它。')}
          <button
            type="button"
            onClick={reload}
            className="ml-1 cursor-pointer font-medium text-accent-text hover:underline"
          >
            {tr('载入最新的计划')}
          </button>
        </p>
      )}
      {tooLong && (
        <p className="text-caption font-normal text-danger">
          {tr('计划太长了（超过 {PLAN_MAX_CHARS} 字），删减一些步骤再保存。', { PLAN_MAX_CHARS })}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {tr('取消')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={update.isPending}
          disabled={tooLong}
        >
          {tr('保存计划')}
        </Button>
      </div>
    </form>
  );
}
