import { forwardRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, CircleCheck, MessageSquare, Undo2, X } from 'lucide-react';
import type { ReviewComment } from '@srh/shared';
import {
  Badge,
  Button,
  IconButton,
  Markdown,
  RelativeTime,
  Textarea,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useAddReviewComment, useResolveComment } from '../api';
import { quoteOf, VERDICT_EVENT } from '../lib/review-state';
import { ActorAvatar, VerdictMark } from './ReviewPeople';
import { tr, trServer } from '@/lib/i18n';

export interface ReviewConversationProps {
  pid: string;
  reviewId: string;
  /** 从旧到新 */
  comments: ReviewComment[];
  canComment: boolean;
}

/** “对话”页签：评论与结论事件的时间线（新评论 messageIn），每条评论可标记已解决。 */
export function ReviewConversation({
  pid,
  reviewId,
  comments,
  canComment,
}: ReviewConversationProps) {
  const { variants } = useMotionPreset();
  const resolve = useResolveComment(pid, reviewId);

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-subtle text-fg-muted ring-1 ring-line">
          <MessageSquare size={20} strokeWidth={1.75} aria-hidden />
        </span>
        <p className="text-h3 text-fg">{tr('还没有评论')}</p>
        <p className="mt-1 text-small text-fg-muted">
          {tr('在“内容”里选中一段文字可以引用评论；审阅人给出的结论也会出现在这里。')}
        </p>
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-4" aria-label={tr('审阅对话')}>
      <AnimatePresence initial={false}>
        {comments.map((c) => (
          <motion.li
            key={c.id}
            layout="position"
            variants={variants.messageIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {c.verdict && c.verdict !== 'pending' ? (
              <VerdictEvent comment={c} />
            ) : (
              <CommentItem
                comment={c}
                canResolve={canComment}
                onResolve={(resolved) =>
                  resolve.mutate(
                    { commentId: c.id, resolved },
                    {
                      onError: () => toast.error(tr('没有改成功'), tr('请稍后再试。')),
                    },
                  )
                }
              />
            )}
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

function VerdictEvent({ comment: c }: { comment: ReviewComment }) {
  const verdict = c.verdict as Exclude<ReviewComment['verdict'], null | 'pending'>;
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
        <span className="relative inline-flex">
          <ActorAvatar actor={c.author} size={24} />
          <VerdictMark verdict={verdict} className="absolute -right-1 -bottom-1" />
        </span>
        <span className="font-medium text-fg">{trServer(c.author.name)}</span>
        <span
          className={cn(
            verdict === 'lgtm' && 'text-success',
            verdict === 'changes_requested' && 'text-danger',
            verdict === 'commented' && 'text-fg-muted',
          )}
        >
          {VERDICT_EVENT[verdict]}
        </span>
        <RelativeTime iso={c.createdAt} className="text-caption font-normal text-fg-subtle" />
      </p>
      {c.body.trim() && (
        <div
          className={cn(
            'mt-2 ml-8 rounded-lg border px-3 py-2',
            verdict === 'lgtm' && 'border-success/30 bg-success-soft/50',
            verdict === 'changes_requested' && 'border-danger/30 bg-danger-soft/50',
            verdict === 'commented' && 'border-line bg-surface',
          )}
        >
          <Markdown size="compact">{c.body}</Markdown>
        </div>
      )}
    </div>
  );
}

function CommentItem({
  comment: c,
  canResolve,
  onResolve,
}: {
  comment: ReviewComment;
  canResolve: boolean;
  onResolve: (resolved: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const quote = quoteOf(c);

  if (c.resolved && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-line bg-subtle px-3 py-1.5 text-left text-small text-fg-muted hover:text-fg"
      >
        <CircleCheck size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-success" />
        <span className="shrink-0">{tr('已解决')}</span>
        <span className="min-w-0 flex-1 truncate">
          {tr('{name}：{body}', {
            name: trServer(c.author.name),
            body: c.body.replace(/\s+/gu, ' '),
          })}
        </span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
      </button>
    );
  }

  return (
    <article className="flex gap-3">
      <ActorAvatar actor={c.author} size={24} className="mt-0.5" />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-lg border bg-surface',
          c.resolved ? 'border-line opacity-80' : 'border-line shadow-xs',
        )}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5">
          <span className="text-small font-medium text-fg">{trServer(c.author.name)}</span>
          {c.author.kind === 'agent' && <Badge tone="agent">agent</Badge>}
          <RelativeTime iso={c.createdAt} className="text-caption font-normal text-fg-subtle" />
          {c.resolved && (
            <Badge tone="success" className="ml-auto">
              {tr('已解决')}
            </Badge>
          )}
        </header>
        <div className="px-3 py-2">
          {quote && (
            <blockquote className="mb-2 border-l-2 border-accent/50 bg-accent-soft/40 py-1 pr-2 pl-2.5 text-small text-fg-muted">
              <span className="sr-only">{tr('引用：')}</span>
              {quote}
            </blockquote>
          )}
          <Markdown size="compact">{c.body}</Markdown>
        </div>
        {(canResolve || c.resolved) && (
          <footer className="flex items-center justify-end gap-1 px-2 pb-1.5">
            {c.resolved && (
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                {tr('收起')}
              </Button>
            )}
            {canResolve && (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={
                  c.resolved ? (
                    <Undo2 strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Check strokeWidth={1.75} aria-hidden />
                  )
                }
                onClick={() => {
                  onResolve(!c.resolved);
                  setOpen(false);
                }}
              >
                {c.resolved ? tr('重新打开') : tr('标记已解决')}
              </Button>
            )}
          </footer>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- 评论框

export interface CommentBoxProps {
  pid: string;
  reviewId: string;
  quote: string | null;
  onClearQuote: () => void;
}

/** 底部评论框：可带一段引用；Ctrl / ⌘ + Enter 发送 */
export const CommentBox = forwardRef<HTMLTextAreaElement, CommentBoxProps>(function CommentBox(
  { pid, reviewId, quote, onClearQuote },
  ref,
) {
  const add = useAddReviewComment(pid, reviewId);
  const [body, setBody] = useState('');
  const canSend = body.trim().length > 0 && !add.isPending;

  const send = () => {
    if (!canSend) return;
    add.mutate(
      { body: body.trim(), anchor: quote ? { quote } : null },
      {
        onSuccess: () => {
          setBody('');
          onClearQuote();
        },
        onError: (err) =>
          toast.error(
            tr('评论没有发出去'),
            err instanceof ApiRequestError ? err.message : tr('请检查网络后重试。'),
          ),
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow] duration-(--dur-fast) focus-within:border-line-strong focus-within:shadow-md">
      {quote && (
        <div className="flex items-start gap-2 border-b border-line px-3 py-2">
          <blockquote className="line-clamp-3 min-w-0 flex-1 border-l-2 border-accent/50 pl-2.5 text-small text-fg-muted">
            <span className="sr-only">{tr('引用：')}</span>
            {quote}
          </blockquote>
          <IconButton label={tr('去掉引用')} size="sm" className="shrink-0" onClick={onClearQuote}>
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      )}
      <Textarea
        ref={ref}
        aria-label={tr('评论')}
        value={body}
        autoGrow
        rows={2}
        maxLength={20_000}
        placeholder={quote ? tr('针对这段内容说点什么…') : tr('写下你的意见（支持 Markdown）')}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        className="border-0 bg-transparent text-prose shadow-none focus:shadow-none"
      />
      <div className="flex items-center gap-2 px-2 pt-1 pb-2">
        <span className="ml-1 hidden text-caption font-normal text-fg-subtle sm:inline">
          {tr('Ctrl + Enter 发送')}
        </span>
        <Button
          size="sm"
          variant={canSend ? 'primary' : 'subtle'}
          disabled={!canSend}
          loading={add.isPending}
          onClick={send}
          className="ml-auto"
        >
          {tr('评论')}
        </Button>
      </div>
    </div>
  );
});
