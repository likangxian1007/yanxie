import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Check } from 'lucide-react';
import type { Review, ReviewTargetKind } from '@srh/shared';
import { Avatar, Badge, Button, Dialog, Input, Select, Textarea, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMembers, useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { useCreateReview, useTargetOptions } from '../api';
import { isPickableKind, SELECTABLE_TARGET_KINDS, TARGET_KIND_LABEL } from '../lib/target';
import { tr } from '@/lib/i18n';

export interface RequestReviewTarget {
  kind: ReviewTargetKind;
  id: string;
  /** 目标标题（用来预填审阅标题、在目标下拉里显示） */
  title: string;
}

export interface RequestReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 预填目标（实验页、文档页里发起时传入） */
  defaultTarget?: RequestReviewTarget;
  /** 建好之后（默认弹 toast，可点“查看”跳到审阅页） */
  onCreated?: (review: Review) => void;
}

/**
 * 发起审阅（像开 PR）：目标类型 + 目标、标题、说明（Markdown）、审阅人多选。
 * 文档页、实验页也用它：`<RequestReviewDialog open onOpenChange defaultTarget={{ kind, id, title }} />`
 */
export function RequestReviewDialog({
  open,
  onOpenChange,
  defaultTarget,
  onCreated,
}: RequestReviewDialogProps) {
  const formId = useId();
  const pid = useProjectId();
  const navigate = useNavigate();
  const create = useCreateReview(pid);
  const [session, setSession] = useState(0);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSession((s) => s + 1);
  }

  const handleCreated = (review: Review) => {
    onOpenChange(false);
    if (onCreated) {
      onCreated(review);
      return;
    }
    toast({
      tone: 'success',
      title: tr('已发起审阅'),
      description: tr('审阅人会在“待我处理”里看到。'),
      action: { label: tr('查看'), onClick: () => navigate(`/p/${pid}/reviews/${review.id}`) },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={tr('请求审阅')}
      description={tr('选好要审的内容和审阅人；他们给出 LGTM 或修改意见后，相关线程会收到通知。')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={create.isPending}>
            {tr('发起审阅')}
          </Button>
        </>
      }
    >
      <RequestReviewForm
        key={session}
        formId={formId}
        defaultTarget={defaultTarget}
        submit={(input) =>
          create.mutate(input, {
            onSuccess: handleCreated,
            onError: (err) =>
              toast.error(
                tr('审阅没有发起成功'),
                err instanceof ApiRequestError ? err.message : tr('请稍后再试。'),
              ),
          })
        }
      />
    </Dialog>
  );
}

interface FormInput {
  targetKind: ReviewTargetKind;
  targetId: string;
  title: string;
  summary: string;
  reviewerIds: string[];
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return htmlFor ? (
    <label htmlFor={htmlFor} className="text-small font-medium text-fg">
      {children}
    </label>
  ) : (
    <span className="text-small font-medium text-fg">{children}</span>
  );
}

function RequestReviewForm({
  formId,
  defaultTarget,
  submit,
}: {
  formId: string;
  defaultTarget: RequestReviewTarget | undefined;
  submit: (input: FormInput) => void;
}) {
  const pid = useProjectId();
  const me = useMeUser();
  const members = useMembers(pid);
  const ids = {
    kind: useId(),
    target: useId(),
    title: useId(),
    summary: useId(),
    reviewers: useId(),
  };

  const [kind, setKind] = useState<ReviewTargetKind>(defaultTarget?.kind ?? 'document');
  const [targetId, setTargetId] = useState(defaultTarget?.id ?? '');
  const [title, setTitle] = useState(
    defaultTarget ? tr('请审阅：{title}', { title: defaultTarget.title }) : '',
  );
  const [titleTouched, setTitleTouched] = useState(false);
  const [summary, setSummary] = useState('');
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ target?: string; title?: string; reviewers?: string }>({});

  const pickable = isPickableKind(kind);
  const targets = useTargetOptions(pid, kind, pickable);
  const options = useMemo(() => {
    const list = targets.options;
    if (
      defaultTarget &&
      defaultTarget.kind === kind &&
      !list.some((o) => o.value === defaultTarget.id)
    ) {
      return [{ value: defaultTarget.id, label: defaultTarget.title }, ...list];
    }
    return list;
  }, [targets.options, defaultTarget, kind]);

  const kinds = useMemo(() => {
    const list = [...SELECTABLE_TARGET_KINDS];
    if (defaultTarget && !list.includes(defaultTarget.kind)) list.push(defaultTarget.kind);
    return list;
  }, [defaultTarget]);

  /** 可选审阅人：项目成员，排除访客和自己；导师排前面 */
  const candidates = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.role !== 'guest' && m.user.id !== me?.id)
        .sort((a, b) => Number(b.role === 'advisor') - Number(a.role === 'advisor')),
    [members.data, me?.id],
  );

  const toggleReviewer = (id: string) => {
    setReviewerIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 10 ? cur : [...cur, id],
    );
    setErrors((e) => ({ ...e, reviewers: undefined }));
  };

  const chooseTarget = (id: string) => {
    setTargetId(id);
    setErrors((e) => ({ ...e, target: undefined }));
    const label = options.find((o) => o.value === id)?.label;
    if (label && !titleTouched) setTitle(tr('请审阅：{label}', { label }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!targetId.trim()) {
      next.target = pickable
        ? tr('请选择要审阅的{value}', { value: TARGET_KIND_LABEL[kind] })
        : tr('请粘贴{value}的 id', { value: TARGET_KIND_LABEL[kind] });
    }
    if (!title.trim()) next.title = tr('请写一个标题，让审阅人知道要看什么');
    if (reviewerIds.length === 0) next.reviewers = tr('至少选择一位审阅人');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    submit({
      targetKind: kind,
      targetId: targetId.trim(),
      title: title.trim(),
      summary,
      reviewerIds,
    });
  };

  return (
    <form id={formId} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor={ids.kind}>{tr('目标类型')}</FieldLabel>
          <Select
            id={ids.kind}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ReviewTargetKind);
              setTargetId('');
              setErrors((x) => ({ ...x, target: undefined }));
            }}
            options={kinds.map((k) => ({ value: k, label: TARGET_KIND_LABEL[k] }))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <FieldLabel htmlFor={ids.target}>{TARGET_KIND_LABEL[kind]}</FieldLabel>
          {pickable ? (
            <Select
              id={ids.target}
              value={targetId}
              disabled={targets.isLoading && options.length === 0}
              error={
                errors.target ??
                (targets.isError
                  ? tr('{value}列表没有加载出来，请稍后重试', { value: TARGET_KIND_LABEL[kind] })
                  : undefined)
              }
              onChange={(e) => chooseTarget(e.target.value)}
            >
              <option value="">
                {targets.isLoading && options.length === 0
                  ? tr('加载中…')
                  : options.length
                    ? tr('选择{value}', { value: TARGET_KIND_LABEL[kind] })
                    : tr('暂无可选的{value}', { value: TARGET_KIND_LABEL[kind] })}
              </option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id={ids.target}
              value={targetId}
              placeholder={kind === 'message' ? tr('粘贴消息 id，如 msg_…') : tr('粘贴 id')}
              error={errors.target}
              onChange={(e) => {
                setTargetId(e.target.value);
                setErrors((x) => ({ ...x, target: undefined }));
              }}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={ids.title}>{tr('标题')}</FieldLabel>
        <Input
          id={ids.title}
          value={title}
          maxLength={120}
          placeholder={tr('例如：请审阅《方法》一节的改写')}
          error={errors.title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleTouched(true);
            setErrors((x) => ({ ...x, title: undefined }));
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor={ids.summary}>{tr('说明')}</FieldLabel>
        <Textarea
          id={ids.summary}
          value={summary}
          autoGrow
          rows={3}
          maxLength={10_000}
          placeholder={tr('改了什么、希望审阅人重点看哪里（支持 Markdown）')}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <fieldset className="flex flex-col gap-1.5" aria-describedby={`${ids.reviewers}-hint`}>
        <legend className="mb-1.5 text-small font-medium text-fg">
          {tr('审阅人')}
          {reviewerIds.length > 0 && (
            <span className="ml-1.5 text-caption font-normal text-fg-subtle tabular-nums">
              {tr('已选 {count} 位', { count: reviewerIds.length })}
            </span>
          )}
        </legend>
        {members.isPending ? (
          <p className="text-small text-fg-subtle">{tr('正在加载成员…')}</p>
        ) : candidates.length === 0 ? (
          <p className="rounded-md bg-subtle px-3 py-2 text-small text-fg-muted">
            {tr('项目里还没有其他可以审阅的成员。可以在设置里邀请导师或同学加入。')}
          </p>
        ) : (
          <ul
            className={cn(
              'max-h-56 overflow-y-auto rounded-md border bg-surface p-1',
              errors.reviewers ? 'border-danger' : 'border-line-strong',
            )}
          >
            {candidates.map((m) => {
              const checked = reviewerIds.includes(m.user.id);
              return (
                <li key={m.user.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleReviewer(m.user.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-body',
                      'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                      checked ? 'bg-accent-soft' : 'hover:bg-subtle',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'grid size-4 shrink-0 place-items-center rounded-xs border',
                        checked
                          ? 'border-accent bg-accent text-accent-fg'
                          : 'border-line-strong bg-surface',
                      )}
                    >
                      {checked && <Check size={12} strokeWidth={2.5} />}
                    </span>
                    <Avatar
                      name={m.user.name}
                      color={m.user.avatarColor}
                      src={m.user.avatarUrl}
                      size={24}
                    />
                    <span className="min-w-0 flex-1 truncate text-fg">{m.user.name}</span>
                    {m.role === 'advisor' && <Badge tone="accent">{tr('导师')}</Badge>}
                    {m.role === 'owner' && <Badge>{tr('负责人')}</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {errors.reviewers ? (
          <p id={`${ids.reviewers}-hint`} className="text-caption font-normal text-danger">
            {errors.reviewers}
          </p>
        ) : (
          <p id={`${ids.reviewers}-hint`} className="text-caption font-normal text-fg-subtle">
            {tr('可以多选，最多 10 位；每位审阅人都会在“待我处理”里收到。')}
          </p>
        )}
      </fieldset>
    </form>
  );
}
