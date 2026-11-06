import { useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, MessageSquareText, MoreHorizontal, RotateCcw, Trash2, X } from 'lucide-react';
import type { ActorRef, DocComment, ProjectMember } from '@srh/shared';
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  RelativeTime,
  Sheet,
  Skeleton,
  Tabs,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { canManage, useMemberMap, useMyRole } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { ICON_STROKE } from '../components/icons';
import { useCommentMutations } from './api';
import type { CommentThread } from './anchor';
import { CommentComposer } from './CommentComposer';
import type { CommentsController } from './useComments';
import { tr, trServer } from '@/lib/i18n';

export interface CommentsPanelProps {
  ctl: CommentsController;
  projectId: string;
  docId: string;
  /** 能否评论（成员 / 导师 / 负责人；访客只读） */
  canComment: boolean;
  wide: boolean;
}

/** 评论侧栏：≥1024px 时是编辑区右侧的一栏，更窄时是右侧抽屉。 */
export function CommentsPanel(props: CommentsPanelProps) {
  const { ctl, wide } = props;
  const { variants } = useMotionPreset();
  if (!wide) {
    return (
      <Sheet
        open={ctl.open}
        onOpenChange={(o) => {
          ctl.setOpen(o);
          if (!o) ctl.setDraft(null);
        }}
        title={tr('评论')}
        width="min(400px, 100vw)"
      >
        <PanelBody {...props} />
      </Sheet>
    );
  }
  return (
    <AnimatePresence initial={false}>
      {ctl.open && (
        <motion.aside
          key="comments"
          aria-label={tr('评论')}
          variants={variants.slideInRight}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="flex w-80 shrink-0 flex-col border-l border-line bg-canvas"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <MessageSquareText
              size={16}
              strokeWidth={ICON_STROKE}
              className="text-fg-muted"
              aria-hidden
            />
            <h2 className="flex-1 text-h3 text-fg">{tr('评论')}</h2>
            <IconButton
              size="sm"
              label={tr('收起评论')}
              onClick={() => {
                ctl.setOpen(false);
                ctl.setDraft(null);
              }}
            >
              <X strokeWidth={ICON_STROKE} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PanelBody {...props} />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function PanelBody({ ctl, projectId, docId, canComment }: CommentsPanelProps) {
  const { create } = useCommentMutations(projectId, docId);
  const resolvedCount = ctl.threads.length - ctl.openCount;
  const list = ctl.threads.filter((t) =>
    ctl.filter === 'open' ? !t.root.resolved : t.root.resolved,
  );

  const submitDraft = async (body: string, mentions: string[]) => {
    if (!ctl.draft) return;
    try {
      const c = await create.mutateAsync({
        body,
        mentions,
        anchor: ctl.draft.anchor,
        quote: ctl.draft.quote,
      });
      ctl.setDraft(null);
      ctl.activate(c.id, false);
    } catch (err) {
      toast({ title: errText(err, tr('评论没有发出去')), tone: 'danger' });
      throw err;
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <Tabs
        aria-label={tr('评论筛选')}
        variant="segmented"
        size="sm"
        layoutId={`comment-filter-${docId}`}
        value={ctl.filter}
        onValueChange={ctl.setFilter}
        items={[
          { value: 'open', label: tr('未解决'), count: ctl.openCount },
          { value: 'resolved', label: tr('已解决'), count: resolvedCount },
        ]}
      />
      {ctl.draft && canComment && (
        <div className="flex flex-col gap-2 rounded-lg border border-accent bg-surface p-3 shadow-sm">
          <Quote text={ctl.draft.quote} />
          <CommentComposer
            key={ctl.draft.quote}
            projectId={projectId}
            placeholder={tr('写下你的评论')}
            submitLabel={tr('评论')}
            autoFocus
            busy={create.isPending}
            onSubmit={submitDraft}
            onCancel={() => ctl.setDraft(null)}
          />
        </div>
      )}
      {ctl.query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : ctl.query.isError ? (
        <EmptyState
          icon={MessageSquareText}
          title={tr('评论加载失败')}
          description={errText(ctl.query.error, tr('请检查网络后重试。'))}
          action={
            <Button size="sm" variant="secondary" onClick={() => void ctl.query.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : list.length === 0 && !ctl.draft ? (
        <p className="px-2 py-8 text-center text-small text-fg-subtle">
          {ctl.filter === 'open'
            ? canComment
              ? tr('还没有评论。选中一段文字，点“评论”就能针对它讨论。')
              : tr('还没有评论。')
            : tr('没有已解决的评论。')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((t) => (
            <li key={t.root.id}>
              <ThreadCard
                thread={t}
                projectId={projectId}
                docId={docId}
                canComment={canComment}
                orphan={!t.root.resolved && ctl.ranges.get(t.root.id) === null && !!t.root.anchor}
                active={ctl.active === t.root.id}
                onActivate={() => ctl.activate(t.root.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function errText(err: unknown, fallback: string) {
  return err instanceof ApiRequestError ? err.message : fallback;
}

function Quote({ text, orphan }: { text: string; orphan?: boolean }) {
  if (!text) return null;
  return (
    <div className="flex items-start gap-2">
      <p
        className={cn(
          'line-clamp-2 min-w-0 flex-1 border-l-2 pl-2 text-small',
          orphan ? 'border-line-strong text-fg-subtle line-through' : 'border-accent text-fg-muted',
        )}
      >
        {text}
      </p>
      {orphan && (
        <span className="shrink-0 rounded-xs bg-subtle px-1.5 py-0.5 text-caption text-fg-subtle">
          {tr('原文已删除')}
        </span>
      )}
    </div>
  );
}

function ThreadCard({
  thread,
  projectId,
  docId,
  canComment,
  orphan,
  active,
  onActivate,
}: {
  thread: CommentThread;
  projectId: string;
  docId: string;
  canComment: boolean;
  orphan: boolean;
  active: boolean;
  onActivate: () => void;
}) {
  const { root, replies } = thread;
  const { create, update, remove } = useCommentMutations(projectId, docId);
  const me = useMeUser();
  const manage = canManage(useMyRole(projectId));
  const members = useMemberMap(projectId);

  const toggleResolved = () =>
    update.mutate(
      { id: root.id, patch: { resolved: !root.resolved } },
      {
        onSuccess: (c) =>
          toast({ title: c.resolved ? tr('已解决') : tr('已重新打开'), tone: 'success' }),
        onError: (err) => toast({ title: errText(err, tr('操作失败')), tone: 'danger' }),
      },
    );

  const del = (c: DocComment) =>
    remove.mutate(c.id, {
      onError: (err) => toast({ title: errText(err, tr('删除失败')), tone: 'danger' }),
    });

  const reply = async (body: string, mentions: string[]) => {
    try {
      await create.mutateAsync({ body, mentions, parentId: root.id });
    } catch (err) {
      toast({ title: errText(err, tr('回复没有发出去')), tone: 'danger' });
      throw err;
    }
  };

  return (
    <article
      aria-label={tr('评论：{value}', { value: root.quote || root.body })}
      data-comment-thread={root.id}
      onClick={(e) => {
        if ((e.target as Element).closest('button, a, textarea, input, [role="menu"]')) return;
        onActivate();
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-3 rounded-lg border bg-surface p-3 transition-[border-color,box-shadow] duration-(--dur-fast)',
        active ? 'border-accent shadow-sm' : 'border-line hover:border-line-strong',
      )}
    >
      <Quote text={root.quote} orphan={orphan} />
      <CommentItem
        comment={root}
        members={members}
        canDelete={canComment && (isMine(root.author, me?.id) || manage)}
        onDelete={() => del(root)}
        extra={
          canComment ? (
            <IconButton
              size="sm"
              label={root.resolved ? tr('重新打开') : tr('解决')}
              className={cn(!root.resolved && 'hover:bg-success-soft hover:text-success')}
              onClick={toggleResolved}
            >
              {root.resolved ? (
                <RotateCcw strokeWidth={ICON_STROKE} />
              ) : (
                <Check strokeWidth={ICON_STROKE} />
              )}
            </IconButton>
          ) : null
        }
      />
      {replies.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          {replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              members={members}
              canDelete={canComment && (isMine(r.author, me?.id) || manage)}
              onDelete={() => del(r)}
            />
          ))}
        </div>
      )}
      {root.resolved && root.resolvedBy && (
        <p className="text-caption text-fg-subtle">
          {trServer(root.resolvedBy.name)}
          {tr(' 标记为已解决')}
          {root.resolvedAt && (
            <>
              {' · '}
              <RelativeTime iso={root.resolvedAt} />
            </>
          )}
        </p>
      )}
      {active && canComment && (
        <CommentComposer
          projectId={projectId}
          placeholder={root.resolved ? tr('回复会重新打开这条评论') : tr('回复')}
          submitLabel={tr('回复')}
          busy={create.isPending}
          onSubmit={reply}
        />
      )}
    </article>
  );
}

function isMine(author: ActorRef, meId: string | undefined) {
  return author.kind === 'user' && !!meId && author.id === meId;
}

function CommentItem({
  comment,
  members,
  canDelete,
  onDelete,
  extra,
}: {
  comment: DocComment;
  members: Map<string, ProjectMember>;
  canDelete: boolean;
  onDelete: () => void;
  extra?: ReactNode;
}) {
  const member = comment.author.id ? members.get(comment.author.id) : undefined;
  return (
    <div className="flex gap-2">
      <Avatar
        name={trServer(comment.author.name)}
        color={member?.user.avatarColor}
        src={member?.user.avatarUrl}
        kind={comment.author.kind === 'agent' ? 'agent' : 'user'}
        size={24}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-small font-medium text-fg">
            {trServer(comment.author.name)}
          </span>
          <RelativeTime iso={comment.createdAt} className="shrink-0 text-caption text-fg-subtle" />
          <span className="flex-1" />
          {extra}
          {canDelete && (
            <Menu
              label={tr('评论操作')}
              align="end"
              trigger={
                <IconButton size="sm" label={tr('更多')}>
                  <MoreHorizontal strokeWidth={ICON_STROKE} />
                </IconButton>
              }
            >
              <MenuItem
                icon={<Trash2 strokeWidth={ICON_STROKE} />}
                className="text-danger"
                onSelect={onDelete}
              >
                {comment.parentId ? tr('删除回复') : tr('删除整条评论')}
              </MenuItem>
            </Menu>
          )}
        </div>
        <CommentBody body={comment.body} mentions={comment.mentions} members={members} />
      </div>
    </div>
  );
}

/** 正文：@ 到的成员名高亮 */
function CommentBody({
  body,
  mentions,
  members,
}: {
  body: string;
  mentions: string[];
  members: Map<string, ProjectMember>;
}) {
  const parts = useMemo(() => {
    const names = mentions
      .map((id) => members.get(id)?.user.name)
      .filter((n): n is string => !!n)
      .sort((a, b) => b.length - a.length);
    if (!names.length) return [body];
    const re = new RegExp(`(@(?:${names.map(escapeRe).join('|')}))`, 'gu');
    return body.split(re);
  }, [body, mentions, members]);
  return (
    <p className="mt-0.5 text-small break-words whitespace-pre-wrap text-fg">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded-xs bg-accent-soft px-0.5 text-accent-text">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </p>
  );
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
