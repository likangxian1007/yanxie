import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { BadgeCheck, Check, MessageSquare, PencilLine, Send } from 'lucide-react';
import type { ProjectMember, Review, ReviewVerdict, Thread, User } from '@srh/shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Input,
  Skeleton,
  Textarea,
  Tooltip,
  toast,
  type BadgeTone,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { duration, ease, useMotionPreset } from '@/lib/motion';
import { projectPath } from '@/components/layout/nav-items';
import {
  useCreateReview,
  useReviewVerdict,
  useThreadReviews,
  type VerdictValue,
} from '../thread-api';
import { AsideCard } from './ThreadAside';
import { tr } from '@/lib/i18n';

const VERDICT: Record<ReviewVerdict, { label: string; tone: BadgeTone }> = {
  pending: { label: tr('待审阅'), tone: 'neutral' },
  lgtm: { label: 'LGTM', tone: 'success' },
  changes_requested: { label: tr('要求修改'), tone: 'danger' },
  commented: { label: tr('已评论'), tone: 'accent' },
};

const STATUS: Record<Review['status'], { label: string; tone: BadgeTone }> = {
  open: { label: tr('审阅中'), tone: 'agent' },
  approved: { label: tr('已 LGTM'), tone: 'success' },
  changes_requested: { label: tr('要求修改'), tone: 'warning' },
  closed: { label: tr('已关闭'), tone: 'neutral' },
};

export interface ThreadReviewPanelProps {
  projectId: string;
  thread: Thread;
  me: User | null;
  members: ProjectMember[];
  writable: boolean;
}

// ---------------------------------------------------------------- 请导师审阅

function RequestReviewDialog({
  open,
  onOpenChange,
  projectId,
  thread,
  me,
  members,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  thread: Thread;
  me: User | null;
  members: ProjectMember[];
}) {
  const navigate = useNavigate();
  const create = useCreateReview(projectId, thread.id);
  const candidates = useMemo(
    () =>
      members
        .filter((m) => m.user.id !== me?.id && m.role !== 'guest')
        .sort((a, b) => Number(b.role === 'advisor') - Number(a.role === 'advisor')),
    [members, me?.id],
  );
  const [title, setTitle] = useState(tr('线程「{title}」', { title: thread.title }));
  const [summary, setSummary] = useState('');
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.filter((m) => m.role === 'advisor').map((m) => m.user.id)),
  );
  const [touched, setTouched] = useState(false);
  const noReviewer = picked.size === 0;
  const noTitle = !title.trim();

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 10) next.add(id);
      return next;
    });

  const submit = () => {
    setTouched(true);
    if (noReviewer || noTitle) return;
    create.mutate(
      { title: title.trim(), summary: summary.trim(), reviewerIds: [...picked] },
      {
        onSuccess: (r) => {
          onOpenChange(false);
          toast({
            title: tr('已发出审阅请求'),
            description: tr('已通知 {count} 位审阅人，结论会回到这个线程。', {
              count: r.reviewers.length,
            }),
            tone: 'success',
            action: {
              label: tr('查看审阅'),
              onClick: () => navigate(projectPath(projectId, `reviews/${r.id}`)),
            },
          });
        },
        onError: (e) => toast.error(tr('没能发出审阅请求'), e.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('请导师审阅')}
      description={tr('审阅人会在「待我处理」里收到请求，给出 LGTM 或修改意见后会回到这个线程。')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            leftIcon={<Send strokeWidth={1.75} aria-hidden />}
            onClick={submit}
          >
            {tr('发出请求')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('标题')}</span>
          <Input
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            error={touched && noTitle ? tr('请写一个标题') : undefined}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('请重点看什么')}</span>
          <Textarea
            autoGrow
            rows={3}
            value={summary}
            maxLength={10_000}
            placeholder={tr('例如：实验设置是否合理、结论能不能写进论文')}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1.5 text-small font-medium text-fg">{tr('审阅人')}</legend>
          {candidates.length === 0 ? (
            <p className="text-small text-fg-subtle">{tr('项目里还没有可以审阅的其他成员。')}</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-line bg-surface p-1">
              {candidates.map((m) => {
                const checked = picked.has(m.user.id);
                return (
                  <li key={m.user.id}>
                    <label
                      className={cn(
                        'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5',
                        'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                        checked ? 'bg-accent-soft/60' : 'hover:bg-subtle',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(m.user.id)}
                        className="size-4 shrink-0 cursor-pointer accent-accent"
                      />
                      <Avatar name={m.user.name} color={m.user.avatarColor} size={24} />
                      <span className="min-w-0 flex-1 truncate text-body text-fg">
                        {m.user.name}
                      </span>
                      {m.role === 'advisor' && <Badge tone="agent">{tr('导师')}</Badge>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {touched && noReviewer && (
            <p className="text-caption font-normal text-danger">{tr('至少选一位审阅人')}</p>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 给结论

function VerdictDialog({
  verdict,
  onOpenChange,
  pending,
  onSubmit,
}: {
  verdict: 'changes_requested' | 'commented' | null;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const changes = verdict === 'changes_requested';
  return (
    <Dialog
      open={verdict !== null}
      onOpenChange={onOpenChange}
      title={changes ? tr('要求修改') : tr('写评论')}
      description={
        changes
          ? tr('写清楚需要改什么，agent 会收到你的意见并接着改。')
          : tr('评论会附在这次审阅上，不影响审阅结论。')
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant={changes ? 'danger' : 'primary'}
            loading={pending}
            disabled={!comment.trim()}
            onClick={() => onSubmit(comment.trim())}
          >
            {changes ? tr('要求修改') : tr('发表评论')}
          </Button>
        </>
      }
    >
      <Textarea
        data-autofocus
        autoGrow
        rows={4}
        value={comment}
        maxLength={10_000}
        aria-label={changes ? tr('修改意见') : tr('评论')}
        placeholder={
          changes ? tr('例如：第 2 节的方法描述有误，请对照原文改正') : tr('写下你的看法')
        }
        onChange={(e) => setComment(e.target.value)}
      />
    </Dialog>
  );
}

/** LGTM 成功：对勾描线 + 外圈 success 涟漪一次（STYLE §4.2-11）；减少动态效果时只淡入。 */
function LgtmBurst({ show }: { show: boolean }) {
  const { reduced } = useMotionPreset();
  return (
    <AnimatePresence>
      {show && (
        <motion.span
          key="lgtm"
          aria-hidden
          className="pointer-events-none absolute inset-0 grid place-items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: duration.base, ease: ease.in } }}
        >
          {!reduced && (
            <motion.span
              className="absolute size-12 rounded-full border-2 border-success"
              initial={{ scale: 0.6, opacity: 0.8 }}
              animate={{ scale: 1.8, opacity: 0 }}
              transition={{ duration: duration.slower, ease: ease.out }}
            />
          )}
          <motion.span
            className="grid size-10 place-items-center rounded-full bg-success text-success-fg shadow-md"
            initial={{ scale: reduced ? 1 : 0.4 }}
            animate={{ scale: 1 }}
            transition={{ duration: duration.slow, ease: ease.overshoot }}
          >
            <svg viewBox="0 0 16 16" width={20} height={20}>
              <motion.path
                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: reduced ? 1 : 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.3, ease: ease.out, delay: 0.1 }}
              />
            </svg>
          </motion.span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function ReviewBlock({
  projectId,
  threadId,
  review,
  me,
  memberById,
}: {
  projectId: string;
  threadId: string;
  review: Review;
  me: User | null;
  memberById: Map<string, ProjectMember>;
}) {
  const verdict = useReviewVerdict(projectId, threadId);
  const [dialog, setDialog] = useState<'changes_requested' | 'commented' | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const mine = review.reviewers.find((p) => p.userId === me?.id);
  const canVerdict = Boolean(mine) && review.status !== 'closed';
  const status = STATUS[review.status];

  const send = (v: VerdictValue, comment?: string) =>
    verdict.mutate(
      { reviewId: review.id, verdict: v, comment },
      {
        onSuccess: () => {
          setDialog(null);
          if (v === 'lgtm') {
            setCelebrate(true);
            window.setTimeout(() => setCelebrate(false), 1200);
            toast.success(tr('已 LGTM'), tr('agent 和发起人会收到你的结论。'));
          } else if (v === 'changes_requested') {
            toast.success(tr('已要求修改'), tr('agent 会按你的意见接着改。'));
          } else {
            toast.success(tr('评论已发表'));
          }
        },
        onError: (e) => toast.error(tr('没能提交审阅结论'), e.message),
      },
    );

  return (
    <div className="relative flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <Link
          to={projectPath(projectId, `reviews/${review.id}`)}
          className="min-w-0 flex-1 text-body font-medium text-fg hover:text-accent-text"
        >
          <span className="line-clamp-2 break-words">{review.title}</span>
        </Link>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {review.summary && (
        <p className="line-clamp-3 text-small text-pretty text-fg-muted">{review.summary}</p>
      )}
      <ul className="flex flex-wrap gap-1.5" aria-label={tr('审阅人')}>
        {review.reviewers.map((p) => {
          const m = memberById.get(p.userId);
          const name = m?.user.name ?? tr('成员');
          const v = VERDICT[p.verdict];
          return (
            <li key={p.userId}>
              <Tooltip content={tr('{name}：{label}', { name, label: v.label })}>
                <span
                  tabIndex={0}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface pr-1 pl-0.5 text-small text-fg"
                >
                  <Avatar name={name} color={m?.user.avatarColor} size={24} />
                  <span className="max-w-24 truncate">{name}</span>
                  <Badge tone={v.tone}>{v.label}</Badge>
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      {canVerdict && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <span className="relative inline-flex">
            <Button
              size="sm"
              variant={mine?.verdict === 'lgtm' ? 'subtle' : 'primary'}
              loading={verdict.isPending && verdict.variables?.verdict === 'lgtm'}
              disabled={mine?.verdict === 'lgtm'}
              leftIcon={<Check strokeWidth={2} aria-hidden />}
              onClick={() => send('lgtm')}
            >
              {mine?.verdict === 'lgtm' ? tr('已 LGTM') : 'LGTM'}
            </Button>
            <LgtmBurst show={celebrate} />
          </span>
          <Button
            size="sm"
            leftIcon={<PencilLine strokeWidth={1.75} aria-hidden />}
            onClick={() => setDialog('changes_requested')}
          >
            {tr('要求修改')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<MessageSquare strokeWidth={1.75} aria-hidden />}
            onClick={() => setDialog('commented')}
          >
            {tr('评论')}
          </Button>
        </div>
      )}
      <VerdictDialog
        key={dialog ?? 'closed'}
        verdict={dialog}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        pending={verdict.isPending}
        onSubmit={(comment) => dialog && send(dialog, comment)}
      />
    </div>
  );
}

/** 审阅卡：请导师审阅；有指向本线程的审阅时显示审阅人结论，审阅人可以直接 LGTM / 要求修改 / 评论。 */
export function ThreadReviewPanel({
  projectId,
  thread,
  me,
  members,
  writable,
}: ThreadReviewPanelProps) {
  const reviews = useThreadReviews(projectId, thread.id);
  const [requesting, setRequesting] = useState(false);
  const memberById = useMemo(() => new Map(members.map((m) => [m.user.id, m])), [members]);
  const list = reviews.data ?? [];
  const active = list.filter((r) => r.status !== 'closed');
  const shown = active.length > 0 ? active.slice(0, 2) : list.slice(0, 1);

  return (
    <AsideCard
      title={tr('审阅')}
      action={
        list.length > 0 && (
          <Link
            to={projectPath(projectId, 'reviews')}
            className="text-caption font-normal text-accent-text hover:underline"
          >
            {tr('全部审阅')}
          </Link>
        )
      }
    >
      <div className="flex flex-col gap-4 px-1">
        {reviews.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-7 w-1/2 rounded-full" />
          </div>
        ) : reviews.isError ? (
          <p className="text-small text-fg-muted">
            {tr('审阅记录没加载出来。')}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void reviews.refetch()}
              className="ml-1"
            >
              {tr('重试')}
            </Button>
          </p>
        ) : shown.length === 0 ? (
          <p className="flex items-start gap-2 text-small text-pretty text-fg-muted">
            <BadgeCheck
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className="mt-0.5 shrink-0 text-agent"
            />
            {tr('想让导师看看 agent 的思路和产出，可以发起一次审阅。')}
          </p>
        ) : (
          shown.map((r) => (
            <ReviewBlock
              key={r.id}
              projectId={projectId}
              threadId={thread.id}
              review={r}
              me={me}
              memberById={memberById}
            />
          ))
        )}
        {writable && (
          <Button
            size="sm"
            variant={shown.length === 0 ? 'primary' : 'secondary'}
            leftIcon={<Send strokeWidth={1.75} aria-hidden />}
            onClick={() => setRequesting(true)}
            className="self-start"
          >
            {tr('请导师审阅')}
          </Button>
        )}
      </div>
      {requesting && (
        <RequestReviewDialog
          open={requesting}
          onOpenChange={setRequesting}
          projectId={projectId}
          thread={thread}
          me={me}
          members={members}
        />
      )}
    </AsideCard>
  );
}
