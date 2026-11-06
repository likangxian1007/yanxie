import { useLocation } from 'react-router';
import { Composer } from './Composer';
import { MessageMentions } from '@srh/shared';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  BadgeCheck,
  Copy,
  FileText,
  FlaskConical,
  Forward,
  KeyRound,
  Link2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Presentation,
  SmilePlus,
  Trash2,
  Quote,
} from 'lucide-react';
import type { AgentSession, Decision, Message, OutputRef, Review, Thread, User } from '@srh/shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Markdown,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  RelativeTime,
  Tooltip,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { splitImageOutputs } from '@/lib/image-attachments';
import { useDeleteMessage, useEditMessage, useToggleReaction } from '@/lib/messages';
import { useMotionPreset } from '@/lib/motion';
import { outputHref } from '@/lib/outputs';
import { useCoordinator, useMembers } from '@/lib/project';
import { DecisionCard } from './DecisionCard';
import { ImageAttachments } from './ImageAttachments';
import { useDecision } from './use-decision';
import { ThreadInlineCard } from './ThreadInlineCard';
import { tr, trServer } from '@/lib/i18n';

const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '🤔'];

export interface MessageItemProps {
  projectId: string;
  message: Message;
  me: User | null;
  /** 同一作者连续消息：不重复头像和名字 */
  compact?: boolean;
  /** rootOfThreadId → 线程（时间线上显示线程卡片） */
  thread?: Thread | undefined;
  threadHref?: string | undefined;
  threadActivity?: string | null | undefined;
  /** 线程 agent 会话（让线程卡如实显示停工、出错） */
  threadAgent?: AgentSession | null | undefined;
  /** 只读（访客） */
  readOnly?: boolean;
  /** 是否在这条消息上做入场动画（只给新到达的消息） */
  animateIn?: boolean;
  onQuote?: ((message: Message) => void) | undefined;
}

function authorKind(m: Message, coordinatorId: string | undefined) {
  if (m.author.kind !== 'agent') return 'user' as const;
  return m.author.id === coordinatorId ||
    m.meta.agentSessionId === coordinatorId ||
    m.author.name === '协调者' ||
    m.meta.role === 'coordinator'
    ? ('coordinator' as const)
    : ('agent' as const);
}

const OUTPUT_ICON: Record<OutputRef['kind'], typeof FileText> = {
  file: Paperclip,
  link: Link2,
  document: FileText,
  experiment: FlaskConical,
  report: Presentation,
  research: FlaskConical,
};

export function OutputChips({ projectId, outputs }: { projectId: string; outputs: OutputRef[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {outputs.map((o) => {
        const Icon = OUTPUT_ICON[o.kind];
        const { href, external } = outputHref(projectId, o);
        const cls =
          'inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-small text-fg-muted shadow-xs transition-colors duration-(--dur-fast) hover:border-line-strong hover:text-fg';
        const inner = (
          <>
            <Icon size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">{o.title}</span>
          </>
        );
        if (href.startsWith('#')) {
          // 指向页面上的另一条消息：平滑滚过去
          return (
            <a
              key={o.id}
              href={href}
              className={cls}
              onClick={(e) => {
                const el = document.getElementById(href.slice(1));
                if (!el) return;
                e.preventDefault();
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            >
              {inner}
            </a>
          );
        }
        return external ? (
          <a key={o.id} href={href} target="_blank" rel="noreferrer noopener" className={cls}>
            {inner}
          </a>
        ) : (
          <Link key={o.id} to={href} className={cls}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}

/** 图片附件显示缩略图（加载失败退回小标签），其余产出保持小标签。 */
function MessageOutputs({ projectId, outputs }: { projectId: string; outputs: OutputRef[] }) {
  const { images, others } = useMemo(() => splitImageOutputs(outputs), [outputs]);
  return (
    <>
      <ImageAttachments
        projectId={projectId}
        images={images}
        renderFallback={(broken) => <OutputChips projectId={projectId} outputs={broken} />}
      />
      <OutputChips projectId={projectId} outputs={others} />
    </>
  );
}

function Reactions({
  projectId,
  message,
  me,
  readOnly,
}: {
  projectId: string;
  message: Message;
  me: User | null;
  readOnly?: boolean | undefined;
}) {
  const toggle = useToggleReaction(projectId);
  const { spring, variants } = useMotionPreset();
  if (message.reactions.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {message.reactions.map((r) => {
          const mine = r.actors.some((a) => a.kind === 'user' && a.id === me?.id);
          return (
            <motion.button
              key={r.emoji}
              type="button"
              layout
              variants={variants.popIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={spring.snappy}
              disabled={readOnly || toggle.isPending}
              title={r.actors.map((a) => a.name).join(tr('、'))}
              aria-pressed={mine}
              aria-label={tr('{emoji} {count} 人：{value}', {
                emoji: r.emoji,
                count: r.actors.length,
                value: r.actors.map((a) => a.name).join(tr('、')),
              })}
              onClick={() => toggle.mutate({ message, emoji: r.emoji, mine })}
              className={cn(
                'press inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-small tabular-nums',
                mine
                  ? 'border-accent/40 bg-accent-soft text-accent-text'
                  : 'border-line bg-surface text-fg-muted hover:border-line-strong',
              )}
            >
              <span aria-hidden>{r.emoji}</span>
              {r.actors.length}
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function ForwardCard({
  projectId,
  message,
  me,
}: {
  projectId: string;
  message: Message;
  me: User | null;
}) {
  const meta = message.meta as {
    threadTitle?: string;
    note?: string;
    summary?: string;
    threadId?: string;
    forwardedBy?: { id?: string };
  };
  // 个人会话只有本人能打开
  const canOpen = meta.forwardedBy?.id !== undefined && meta.forwardedBy.id === me?.id;
  return (
    <div className="mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex items-center gap-2 border-b border-line bg-agent-soft/40 px-3 py-2 text-small text-agent-text">
        <Forward size={14} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 truncate">
          {tr('转给协调者的个人会话')}
          {meta.threadTitle && (
            <span className="font-medium">
              {tr('「{threadTitle}」', { threadTitle: meta.threadTitle })}
            </span>
          )}
        </span>
      </div>
      <div className="px-3 py-2.5">
        {meta.note && (
          <p className="text-body text-pretty text-fg">
            <span className="text-fg-subtle">{tr('附言：')}</span>
            {meta.note}
          </p>
        )}
        {meta.summary && (
          <Markdown size="compact" className={cn('text-fg-muted', meta.note && 'mt-2')}>
            {meta.summary}
          </Markdown>
        )}
        {!meta.note && !meta.summary && message.body && (
          <Markdown size="compact">{message.body}</Markdown>
        )}
      </div>
      {meta.threadId && canOpen && (
        <Link
          to={`/p/${projectId}/workspace/${meta.threadId}`}
          className="block border-t border-line px-3 py-2 text-small text-accent-text hover:bg-subtle"
        >
          {tr('打开原会话')}
        </Link>
      )}
    </div>
  );
}

const REVIEW_STATUS: Record<
  Review['status'],
  { label: string; tone: 'agent' | 'success' | 'warning' | 'neutral' }
> = {
  open: { label: tr('审阅中'), tone: 'agent' },
  approved: { label: tr('已 LGTM'), tone: 'success' },
  changes_requested: { label: tr('要求修改'), tone: 'warning' },
  closed: { label: tr('已关闭'), tone: 'neutral' },
};

function ReviewCard({ projectId, message }: { projectId: string; message: Message }) {
  const review = message.meta.review as Review | undefined;
  const reviewId = (message.meta.reviewId as string | undefined) ?? review?.id;
  if (!reviewId) return <Markdown>{message.body}</Markdown>;
  const status = review ? REVIEW_STATUS[review.status] : null;
  return (
    <Link
      to={`/p/${projectId}/reviews/${reviewId}`}
      className="mt-1 flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-xs hover:border-line-strong"
    >
      <BadgeCheck size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-agent" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-fg">
            {review?.title ?? message.body}
          </span>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </span>
        {review?.summary && (
          <span className="mt-0.5 line-clamp-2 block text-small text-fg-muted">
            {review.summary}
          </span>
        )}
      </span>
    </Link>
  );
}

function DecisionBody({
  projectId,
  message,
  readOnly,
}: {
  projectId: string;
  message: Message;
  readOnly?: boolean | undefined;
}) {
  const snapshot = message.meta.decision as Decision | undefined;
  const id = (message.meta.decisionId as string | undefined) ?? snapshot?.id;
  const { data } = useDecision(projectId, id, snapshot);
  if (!data) return <Markdown>{message.body}</Markdown>;
  return (
    <DecisionCard projectId={projectId} decision={data} readOnly={readOnly} className="mt-1" />
  );
}

function EditDialog({
  projectId,
  message,
  open,
  onOpenChange,
}: {
  projectId: string;
  message: Message;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [body, setBody] = useState(message.body);
  const edit = useEditMessage(projectId);
  const personal = useLocation().pathname.includes('/workspace');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={tr('编辑消息')} size="md">
      <Composer
        inline
        mentionProjectId={personal ? undefined : projectId}
        initialMentions={MessageMentions.safeParse(message.meta.mentions).data ?? []}
        value={body}
        onChange={setBody}
        label={tr('编辑消息内容')}
        disabled={edit.isPending}
        onSubmit={({ body, mentions }) =>
          edit.mutate(
            { id: message.id, body, mentions },
            {
              onSuccess: () => onOpenChange(false),
              onError: (e) => toast.error(tr('没能保存'), e.message),
            },
          )
        }
      />
    </Dialog>
  );
}

function HoverActions({
  projectId,
  message,
  me,
  readOnly,
  onQuote,
}: {
  projectId: string;
  message: Message;
  me: User | null;
  readOnly?: boolean | undefined;
  onQuote?: (message: Message) => void;
}) {
  const toggle = useToggleReaction(projectId);
  const del = useDeleteMessage(projectId);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mine = message.author.kind === 'user' && message.author.id === me?.id;
  const btn =
    'press grid size-8 max-md:size-11 cursor-pointer place-items-center rounded-sm text-fg-subtle hover:bg-subtle hover:text-fg';

  return (
    <>
      <div className="absolute top-0 right-2 z-[2] max-md:static max-md:ml-auto max-md:w-fit max-md:border-0 max-md:bg-transparent max-md:shadow-none flex items-center gap-0.5 rounded-md border border-line bg-elevated p-0.5 opacity-0 max-md:opacity-100 shadow-sm transition-opacity duration-(--dur-fast) group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        {onQuote && !readOnly && (
          <Tooltip content={tr('引用到智能体对话')}>
            <button
              type="button"
              aria-label={tr('引用到智能体对话')}
              className={btn}
              onClick={() => onQuote(message)}
            >
              <Quote size={15} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        )}
        {!readOnly && (
          <Popover
            label={tr('添加反应')}
            side="top"
            align="end"
            className="min-w-0"
            trigger={
              <button type="button" aria-label={tr('添加反应')} className={btn}>
                <SmilePlus size={15} strokeWidth={1.75} aria-hidden />
              </button>
            }
          >
            {(close) => (
              <div className="flex gap-0.5">
                {QUICK_REACTIONS.map((emoji) => {
                  const mine2 = message.reactions.some(
                    (r) => r.emoji === emoji && r.actors.some((a) => a.id === me?.id),
                  );
                  return (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={tr('反应 {emoji}', { emoji })}
                      onClick={() => {
                        toggle.mutate({ message, emoji, mine: mine2 });
                        close();
                      }}
                      className={cn(
                        'press grid size-8 cursor-pointer place-items-center rounded-sm text-h3 hover:bg-subtle',
                        mine2 && 'bg-accent-soft',
                      )}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            )}
          </Popover>
        )}
        <Menu
          label={tr('更多操作')}
          align="end"
          trigger={
            <button type="button" aria-label={tr('更多操作')} className={btn}>
              <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
            </button>
          }
        >
          <MenuItem
            icon={<Copy strokeWidth={1.75} />}
            onSelect={() => {
              void navigator.clipboard?.writeText(message.body).then(
                () => toast({ title: tr('已复制') }),
                () => toast.error(tr('复制失败')),
              );
            }}
          >
            {tr('复制文字')}
          </MenuItem>
          {mine && message.kind === 'text' && (
            <>
              <MenuItem icon={<Pencil strokeWidth={1.75} />} onSelect={() => setEditing(true)}>
                {tr('编辑')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 strokeWidth={1.75} />}
                onSelect={() => setConfirmDelete(true)}
              >
                {tr('删除')}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {editing && (
        <EditDialog
          projectId={projectId}
          message={message}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr('删除这条消息？')}
        description={tr('删除后所有人都看不到它，协调者也不会再读到。')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(message, {
                  onSuccess: () => setConfirmDelete(false),
                  onError: (e) => toast.error(tr('没能删除'), e.message),
                })
              }
            >
              {tr('删除')}
            </Button>
          </>
        }
      />
    </>
  );
}

/**
 * 一条消息（STYLE §6 Message）：头像 + 名字 + 时间 + markdown 正文；旁聊带 warning 竖条；
 * decision / forward / review / activity 各有专门的卡片；悬停出现反应与更多操作。
 */
export const MessageItem = memo(function MessageItem({
  projectId,
  message,
  me,
  compact,
  thread,
  threadHref,
  threadActivity,
  threadAgent,
  readOnly,
  animateIn,
  onQuote,
}: MessageItemProps) {
  const { variants } = useMotionPreset();
  const coordinatorId = useCoordinator(projectId)?.id;
  // 头像颜色以成员资料为准（和侧栏、设置一致）；消息 meta 里的只作兜底
  const memberColor = useMembers(projectId).data?.find((mb) => mb.user.id === message.author.id)
    ?.user.avatarColor;
  const kind = authorKind(message, coordinatorId);
  // 协调者统一显示为「协调者」（后端的 agent 名可能是产品名）
  const authorName = kind === 'coordinator' ? tr('协调者') : trServer(message.author.name);
  const pending = message.id.startsWith('tmp_');
  const own =
    message.author.kind === 'user' && message.author.id === me?.id && message.kind === 'text';
  const isAgent = kind !== 'user';
  /** 外部 agent 用 API 令牌发的消息会在 meta.viaToken 里留痕（API.md §2.22） */
  const viaToken = message.meta.viaToken as { name?: string } | undefined;

  if (message.kind === 'activity') {
    return (
      <motion.div
        variants={variants.fadeIn}
        initial={animateIn ? 'hidden' : false}
        animate="visible"
        className="my-3 flex items-center gap-3 text-caption font-normal text-fg-subtle"
      >
        <span className="h-px flex-1 bg-line" />
        <span className="max-w-[80%] text-center text-pretty">
          <span className="font-medium text-fg-muted">{trServer(message.author.name)}</span>{' '}
          {trServer(message.body)}
          <span aria-hidden> · </span>
          <RelativeTime iso={message.createdAt} />
        </span>
        <span className="h-px flex-1 bg-line" />
      </motion.div>
    );
  }

  let body: ReactNode;
  if (message.kind === 'decision')
    body = <DecisionBody projectId={projectId} message={message} readOnly={readOnly} />;
  else if (message.kind === 'forward')
    body = <ForwardCard projectId={projectId} message={message} me={me} />;
  else if (message.kind === 'review') body = <ReviewCard projectId={projectId} message={message} />;
  else
    body = (
      <Markdown>
        {message.author.kind === 'system' || message.meta?.agentStopped
          ? trServer(message.body)
          : message.body}
      </Markdown>
    );

  return (
    <motion.article
      variants={variants.messageIn}
      initial={animateIn ? 'hidden' : false}
      animate="visible"
      id={message.id}
      aria-label={tr('{authorName} 的消息', { authorName })}
      className={cn(
        'group/msg relative -mx-2 flex scroll-mt-20 gap-3 rounded-lg px-2 transition-colors duration-(--dur-fast)',
        compact ? 'py-0.5' : 'pt-3 pb-0.5',
        own && 'ml-auto max-w-[90%] flex-row-reverse',
        'hover:bg-subtle/60',
        // 站内引用跳过来时短暂高亮（lib/message-link.ts flashElement 设置 data-flash）
        'data-flash:bg-accent-soft/70 data-flash:ring-1 data-flash:ring-accent/40',
        pending && 'opacity-60',
      )}
    >
      <div className="w-8 shrink-0">
        {!compact && (
          <Avatar
            name={authorName}
            kind={kind}
            size={32}
            color={memberColor ?? (message.meta.avatarColor as number | undefined)}
          />
        )}
      </div>
      <div className={cn('min-w-0 flex-1 pb-1', own && 'rounded-xl bg-accent-soft/50 px-3 py-2')}>
        {!compact && (
          <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn('text-body font-semibold', isAgent ? 'text-agent-text' : 'text-fg')}
            >
              {authorName}
            </span>
            <RelativeTime
              iso={message.createdAt}
              className="text-caption font-normal text-fg-subtle"
            />
            {message.editedAt && (
              <span className="text-caption font-normal text-fg-subtle">{tr('已编辑')}</span>
            )}
            {/* 外部 agent 用 API 令牌发的消息：标出来，方便事后辨认与清理（API.md §2.22） */}
            {viaToken && (
              <span
                className="inline-flex items-center gap-1 text-caption font-normal text-fg-subtle"
                title={tr('这条消息是外部 agent 用 API 令牌以本人身份发出的')}
              >
                <KeyRound size={12} strokeWidth={1.75} aria-hidden />
                {tr('来自令牌')}
                {viaToken.name ? tr('「{name}」', { name: viaToken.name }) : ''}
              </span>
            )}
            {pending && (
              <span className="text-caption font-normal text-fg-subtle">{tr('发送中…')}</span>
            )}
          </div>
        )}
        {body}
        <MessageOutputs projectId={projectId} outputs={message.outputs} />
        <Reactions projectId={projectId} message={message} me={me} readOnly={readOnly} />
        {thread && threadHref && (
          <ThreadInlineCard
            thread={thread}
            href={threadHref}
            activity={threadActivity}
            agent={threadAgent}
          />
        )}
        {!pending && (
          <HoverActions
            projectId={projectId}
            message={message}
            me={me}
            readOnly={readOnly}
            onQuote={onQuote}
          />
        )}
      </div>
    </motion.article>
  );
});
