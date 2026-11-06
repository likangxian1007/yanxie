import { PageTitle } from '@/components/layout/Page';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  ExternalLink,
  History,
  ListTree,
  XCircle,
} from 'lucide-react';
import {
  Avatar,
  Button,
  Card,
  Dialog,
  EmptyState,
  Markdown,
  RelativeTime,
  Skeleton,
  Tabs,
  toast,
} from '@/components/ui';
import { BackLink } from '@/components/layout/BackLink';
import { Page } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { canManage, canWrite, useMemberMap, useMyRole, useProjectId } from '@/lib/project';
import { useMotionPreset } from '@/lib/motion';
import { useMeUser } from '@/lib/session';
import {
  useCloseReview,
  usePlanDocumentTitle,
  usePreviousRound,
  useReview,
  useReviewEvents,
  type ReviewDetail,
} from '../api';
import { CommentBox, ReviewConversation } from '../components/ReviewConversation';
import { ReviewContent } from '../components/ReviewContent';
import { ActorAvatar, ReviewStatusBadge, VerdictMark } from '../components/ReviewPeople';
import { TargetIcon } from '../components/TargetIcon';
import { VerdictPanel } from '../components/VerdictPanel';
import {
  approvedSummaryText,
  isRequestedBy,
  reviewerOf,
  sortComments,
  VERDICT_LABEL,
  verdictProgressText,
} from '../lib/review-state';
import { TARGET_KIND_LABEL, targetHref } from '../lib/target';
import { useAgentThreadTitle } from '../lib/use-agent-thread';
import { ProposalPanel } from '@/features/versioning/components/ProposalPanel';
import { tr, trServer } from '@/lib/i18n';

type DetailTab = 'conversation' | 'content' | 'changes';

/** 头部元信息里的链接：触屏上外扩出看不见的 44px 高点击区 */
const META_LINK =
  'relative inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 hover:text-accent-text pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3';

export function ReviewDetailPage() {
  const pid = useProjectId();
  const { reviewId = '' } = useParams();
  useReviewEvents(pid);
  const query = useReview(pid, reviewId);
  const back = <BackLink to={projectPath(pid, 'reviews')}>{tr('全部审阅')}</BackLink>;

  if (query.isPending) {
    return (
      <Page width="full" className="max-w-6xl">
        <div className="mb-6">{back}</div>
        <div role="status" aria-label={tr('正在加载审阅')} className="flex flex-col gap-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-24" />
          <Skeleton className="h-24" />
        </div>
      </Page>
    );
  }
  if (query.isError) {
    const notFound = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <Page width="full" className="max-w-6xl">
        <div className="mb-6">{back}</div>
        <EmptyState
          framed
          icon={notFound ? BadgeCheck : AlertTriangle}
          title={notFound ? tr('找不到这个审阅') : tr('审阅没有加载出来')}
          description={
            notFound
              ? tr('它可能已被删除，或者链接有误。')
              : tr('{message} 可以稍后重试。', { message: query.error.message })
          }
          action={
            notFound ? undefined : (
              <Button variant="primary" onClick={() => void query.refetch()}>
                {tr('重试')}
              </Button>
            )
          }
        />
      </Page>
    );
  }
  return <ReviewDetailView pid={pid} review={query.data} back={back} />;
}

function ReviewDetailView({
  pid,
  review,
  back,
}: {
  pid: string;
  review: ReviewDetail;
  back: ReactNode;
}) {
  const me = useMeUser();
  const role = useMyRole(pid);
  const members = useMemberMap(pid);
  const { variants } = useMotionPreset();
  const agentThread = useAgentThreadTitle(review.requestedBy);
  const close = useCloseReview(pid, review.id);
  const isProposal = review.targetKind === 'proposal';
  // 改动提案的审阅：默认就看改动、逐条决定
  const [tab, setTab] = useState<DetailTab>(isProposal ? 'changes' : 'conversation');
  const [quote, setQuote] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const comments = useMemo(() => sortComments(review.comments), [review.comments]);
  const myParticipant = reviewerOf(review, me?.id ?? null);
  const closed = review.status === 'closed';
  const writable = canWrite(role);
  const canClose = !closed && (isRequestedBy(review, me?.id ?? null) || canManage(role));
  // 改动提案的链接会跳回这条审阅：不显示，改动页签里有指向文档的链接
  const href = isProposal ? null : targetHref(pid, review.targetKind, review.targetId);
  const planTitle = usePlanDocumentTitle(pid, review.targetKind, review.targetId).data;
  const previous = usePreviousRound(pid, review).data;
  const unresolved = comments.filter((c) => !c.verdict && !c.resolved).length;

  const startQuote = (text: string) => {
    setQuote(text);
    setTab('conversation');
    // 等对话页签渲染出评论框再聚焦
    window.setTimeout(() => commentRef.current?.focus(), 50);
  };

  const reviewersCard = (
    <Card padding="md">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-h3 text-fg">{tr('审阅人')}</h2>
        <span className="text-caption font-normal text-fg-subtle tabular-nums">
          {verdictProgressText(review.reviewers)}
        </span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {review.reviewers.map((r) => {
          const m = members.get(r.userId);
          return (
            <li key={r.userId} className="flex items-center gap-2.5 text-small">
              <span className="relative inline-flex">
                <Avatar
                  name={m?.user.name ?? tr('成员')}
                  color={m?.user.avatarColor}
                  src={m?.user.avatarUrl}
                  size={24}
                />
                <VerdictMark verdict={r.verdict} className="absolute -right-1 -bottom-1" />
              </span>
              <span className="min-w-0 flex-1 truncate text-fg">
                {m?.user.name ?? tr('已离开的成员')}
                {r.userId === me?.id && <span className="text-fg-subtle">{tr('（你）')}</span>}
              </span>
              <span
                className={
                  r.verdict === 'lgtm'
                    ? 'text-caption text-success'
                    : r.verdict === 'changes_requested'
                      ? 'text-caption text-danger'
                      : 'text-caption font-normal text-fg-subtle'
                }
              >
                {VERDICT_LABEL[r.verdict]}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );

  const side = (
    <div className="flex flex-col gap-4">
      {myParticipant && !closed && (
        <VerdictPanel pid={pid} reviewId={review.id} me={myParticipant} />
      )}
      {reviewersCard}
      {canClose && (
        <Button
          variant="ghost"
          leftIcon={<XCircle strokeWidth={1.75} aria-hidden />}
          onClick={() => setConfirmClose(true)}
        >
          {tr('关闭审阅')}
        </Button>
      )}
    </div>
  );

  return (
    // 手机上结论按钮滚出屏幕后会出现吸底操作条（VerdictPanel），给它留出位置
    <Page width="full" className={cn('max-w-6xl', myParticipant && !closed && 'max-lg:pb-28')}>
      <div className="mb-4">{back}</div>

      <header className="mb-6">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <PageTitle>{review.title}</PageTitle>
          <ReviewStatusBadge status={review.status} className="mt-1.5" />
        </div>
        {/*
          元信息各自成块、整块换行（不在块内折行），块之间靠间距和各自的图标分开，
          不用「·」分隔符：窄屏换行时不会在行首留下孤立的点。
        */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-fg-muted">
          <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
            <ActorAvatar actor={review.requestedBy} size={20} />
            <span className="min-w-0 truncate">
              {trServer(review.requestedBy.name)}
              {review.requestedBy.kind === 'agent' && (
                <span className="text-agent-text">
                  {agentThread
                    ? tr('（来自「{agentThread}」线程）', { agentThread })
                    : tr('（agent）')}
                </span>
              )}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              {tr('发起于 ')}
              <RelativeTime iso={review.createdAt} />
            </span>
          </span>
          {isProposal ? null : href ? (
            <Link to={href} className={cn(META_LINK, 'text-fg')}>
              <TargetIcon kind={review.targetKind} size={14} />
              <span className="truncate">
                {planTitle
                  ? tr('{value}：{planTitle}', {
                      value: TARGET_KIND_LABEL[review.targetKind],
                      planTitle,
                    })
                  : tr('查看{value}', { value: TARGET_KIND_LABEL[review.targetKind] })}
              </span>
              <ExternalLink size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
            </Link>
          ) : (
            <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
              <TargetIcon kind={review.targetKind} size={14} />
              <span className="truncate font-mono text-caption">{review.targetId}</span>
            </span>
          )}
          {review.threadId && (
            <Link to={projectPath(pid, `threads/${review.threadId}`)} className={META_LINK}>
              <ListTree size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
              {tr('相关线程')}
            </Link>
          )}
        </div>
        {review.summary.trim() && (
          <div className="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
            <Markdown size="compact">{review.summary}</Markdown>
          </div>
        )}
      </header>

      <AnimatePresence initial={false}>
        {review.status === 'approved' && (
          <motion.div
            key="approved"
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="status"
            className="mb-6 flex items-center gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-success"
          >
            <CircleCheck size={20} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <div className="min-w-0">
              <p className="text-h3">{tr('已获全部 LGTM')}</p>
              <p className="text-small text-fg-muted">
                {approvedSummaryText(review.reviewers.length)}
              </p>
            </div>
          </motion.div>
        )}
        {review.supersededById && (
          <motion.div
            key="superseded"
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="status"
            className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-subtle px-4 py-3 text-small text-fg-muted"
          >
            <History size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">
              {tr('这是旧一轮审阅，已被新一轮取代并关闭，结论和评论以新一轮为准。')}
            </span>
            <Link
              to={projectPath(pid, `reviews/${review.supersededById}`)}
              className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-text hover:underline"
            >
              {tr('查看新一轮')}
              <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
            </Link>
          </motion.div>
        )}
        {previous && (
          <motion.div
            key="previous"
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-small text-fg-muted"
          >
            <History size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1">
              {tr('这是新一轮审阅，取代了上一轮「{title}」。在「内容」里可以只看这一轮改了什么。', {
                title: previous.title,
              })}
            </span>
            <Link
              to={projectPath(pid, `reviews/${previous.id}`)}
              className="rounded-sm font-medium text-accent-text hover:underline"
            >
              {tr('查看上一轮')}
            </Link>
          </motion.div>
        )}
        {closed && !review.supersededById && (
          <motion.p
            key="closed"
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="mb-6 rounded-lg bg-subtle px-4 py-2.5 text-small text-fg-muted"
          >
            {tr('这个审阅已关闭')}
            {review.closedAt && (
              <>
                {' '}
                · <RelativeTime iso={review.closedAt} />
              </>
            )}
            {tr('，不能再给出结论。')}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div className="mb-6 lg:hidden">{side}</div>
          <Tabs
            aria-label={tr('审阅内容')}
            layoutId="review-detail-tabs"
            className="mb-5"
            value={tab}
            onValueChange={setTab}
            items={[
              ...(isProposal ? [{ value: 'changes' as const, label: tr('改动') }] : []),
              { value: 'conversation' as const, label: tr('对话'), count: unresolved || undefined },
              ...(isProposal ? [] : [{ value: 'content' as const, label: tr('内容') }]),
            ]}
          />
          {tab === 'changes' ? (
            <ProposalPanel
              pid={pid}
              proposalId={review.targetId}
              writable={writable}
              isReviewer={!!myParticipant && !closed}
            />
          ) : tab === 'conversation' ? (
            <div className="flex flex-col gap-6">
              <ReviewConversation
                pid={pid}
                reviewId={review.id}
                comments={comments}
                canComment={writable}
              />
              {writable && !closed && (
                <CommentBox
                  ref={commentRef}
                  pid={pid}
                  reviewId={review.id}
                  quote={quote}
                  onClearQuote={() => setQuote(null)}
                />
              )}
            </div>
          ) : (
            <ReviewContent
              pid={pid}
              review={review}
              onQuote={writable && !closed ? startQuote : undefined}
            />
          )}
        </div>
        <aside className="hidden lg:block" aria-label={tr('审阅人与结论')}>
          <div className="sticky top-6">{side}</div>
        </aside>
      </div>

      <Dialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        size="sm"
        title={tr('关闭这个审阅？')}
        description={tr('关闭后审阅人不能再给出结论，评论记录会保留。')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="danger"
              loading={close.isPending}
              onClick={() =>
                close.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmClose(false);
                    toast.success(tr('审阅已关闭'));
                  },
                  onError: (err) =>
                    toast.error(
                      tr('没有关闭成功'),
                      err instanceof ApiRequestError ? err.message : tr('请稍后再试。'),
                    ),
                })
              }
            >
              {tr('关闭审阅')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </Page>
  );
}
