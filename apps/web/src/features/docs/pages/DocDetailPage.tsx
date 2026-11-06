import { PageTitle } from '@/components/layout/Page';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  ArchiveRestore,
  Download,
  FileQuestion,
  GitPullRequest,
  History,
  Link2,
  ListTree,
  Lock,
  MoreHorizontal,
  RefreshCw,
  Share2,
  WifiOff,
} from 'lucide-react';
import { accessAtLeast, type DocumentMeta, type DocumentOutlineItem } from '@srh/shared';
import {
  AvatarStack,
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Tooltip,
  toast,
  type AvatarStackMember,
} from '@/components/ui';
import { BackLink } from '@/components/layout/BackLink';
import { useLayoutStore } from '@/components/layout/layout-store';
import { projectPath } from '@/components/layout/nav-items';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { canWrite, useMyRole } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { RequestReviewDialog } from '@/features/reviews';
import { effectiveAccess, useShareEvents } from '@/features/sharing/api';
import { SharePanel } from '@/features/sharing/SharePanel';
import { SpaceBadge } from '@/features/sharing/SpaceBadge';
import { clearLocalCache, localCacheName } from '../collab/localCache';
import { useCollabDoc, type CollabDoc, type CollabPeer } from '../collab/useCollabDoc';
import { fetchDocMarkdown, useDocMeta, usePatchDoc } from '../detail/api';
import { titleFromOutline } from '../detail/autoTitle';
import { DocClaims } from '../detail/DocClaims';
import { useToolbarScrollFade } from '../detail/toolbarFade';
import { ProposalBanner } from '@/features/versioning/components/ProposalBanner';
import { VersionHistorySheet } from '@/features/versioning/components/VersionHistorySheet';
import { BlankDocImport } from '../import/BlankDocImport';
import type { DocEditorProps } from '../editors/types';
import { tr } from '@/lib/i18n';

/** 四类编辑器按需加载（Tiptap / CodeMirror / pptxgenjs 都不小） */
const EDITORS: Record<DocumentMeta['kind'], ComponentType<DocEditorProps>> = {
  doc: lazy(() => import('../editors/rich').then((m) => ({ default: m.RichTextEditor }))),
  sheet: lazy(() => import('../editors/sheet').then((m) => ({ default: m.SheetEditor }))),
  slides: lazy(() => import('../editors/slides').then((m) => ({ default: m.SlidesEditor }))),
  latex: lazy(() => import('../editors/latex').then((m) => ({ default: m.LatexEditor }))),
};

export function DocDetailPage() {
  const { projectId = '', docId = '' } = useParams();
  const meta = useDocMeta(projectId, docId);
  const userId = useMeUser()?.id ?? null;
  const notFound =
    meta.isError && meta.error instanceof ApiRequestError && meta.error.status === 404;

  // 文档页需要宽度：进入时收起右侧面板
  useEffect(() => {
    useLayoutStore.getState().setRightPanelOpen(false);
  }, []);

  // 文档不存在（被删除）或已无权访问：删掉它的本机缓存
  useEffect(() => {
    if (notFound && userId) void clearLocalCache(localCacheName(userId, docId));
  }, [notFound, userId, docId]);

  const back = <BackLink to={projectPath(projectId, 'docs')}>{tr('全部文档')}</BackLink>;

  if (meta.isPending) return <DocSkeleton back={back} />;
  if (meta.isError) {
    return (
      <div className="mx-auto flex w-full max-w-(--doc-max) flex-col gap-8 px-4 pt-6 md:px-6 md:pt-8">
        {back}
        <EmptyState
          framed
          icon={FileQuestion}
          title={notFound ? tr('这篇文档不存在，或你没有访问权限') : tr('文档加载失败')}
          description={
            notFound
              ? tr('可能被删除了，或所有者关闭了分享。回到文档列表看看。')
              : meta.error instanceof ApiRequestError
                ? meta.error.message
                : tr('请检查网络后重试。')
          }
          action={
            notFound ? undefined : (
              <Button variant="secondary" onClick={() => void meta.refetch()}>
                {tr('重试')}
              </Button>
            )
          }
        />
      </div>
    );
  }
  return <DocWorkspace key={docId} pid={projectId} meta={meta.data} back={back} />;
}

function DocWorkspace({
  pid,
  meta,
  back,
}: {
  pid: string;
  meta: DocumentMeta;
  back: React.ReactNode;
}) {
  const collab = useCollabDoc(meta.id);
  const role = useMyRole(pid);
  useShareEvents(pid);
  const archived = !!meta.archivedAt;
  // 个人空间的文档按分享级别（§2.19）：可阅读只读、可评论能评论、可编辑能改
  const access = effectiveAccess(meta.access, canWrite(role));
  const editable = accessAtLeast(access, 'edit') && !archived;
  const canComment = accessAtLeast(access, 'comment') && !archived;
  const teamDoc = (meta.space ?? 'team') === 'team';
  const [outline, setOutline] = useState<DocumentOutlineItem[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [jumpTo, setJumpTo] = useState<{ index: number; nonce: number } | null>(null);
  const Editor = EDITORS[meta.kind];
  const hasOutline = meta.kind !== 'sheet';
  const editorArea = useRef<HTMLDivElement>(null);
  useToolbarScrollFade(editorArea);
  useAutoTitle(pid, meta, outline, editable);

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h)-var(--tabbar-h))] min-h-[480px] w-full flex-col">
      <DocHeader
        pid={pid}
        meta={meta}
        collab={collab}
        editable={editable}
        canArchive={accessAtLeast(access, 'edit')}
        // 审阅人要能打开文档：个人文档先移到团队空间再发起审阅
        canReview={canWrite(role) && teamDoc}
        back={back}
        outlineToggle={
          hasOutline ? (
            <IconButton
              label={outlineOpen ? tr('收起大纲') : tr('展开大纲')}
              className="hidden xl:inline-flex"
              onClick={() => setOutlineOpen((v) => !v)}
            >
              <ListTree size={16} strokeWidth={1.75} />
            </IconButton>
          ) : null
        }
      />
      {archived && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small text-warning md:mx-6">
          <Archive size={14} strokeWidth={1.75} aria-hidden />
          {tr('这篇文档已归档，只能查看。恢复后才能继续编辑。')}
        </div>
      )}
      {editable && collab && collab.synced && (
        <BlankDocImport pid={pid} meta={meta} doc={collab.doc} />
      )}
      <DocClaims
        pid={pid}
        docId={meta.id}
        title={meta.title}
        outline={outline}
        peers={collab?.peers ?? []}
        onJump={(index) => setJumpTo({ index, nonce: Date.now() })}
      />
      <div ref={editorArea} className="flex min-h-0 flex-1 border-t border-line">
        <AnimatePresence initial={false}>
          {hasOutline && outlineOpen && outline.length > 0 && (
            <OutlinePanel
              items={outline}
              onJump={(index) => setJumpTo({ index, nonce: Date.now() })}
            />
          )}
        </AnimatePresence>
        <div className="flex min-w-0 flex-1 flex-col">
          {collab?.status === 'denied' ? (
            <div className="p-8">
              <EmptyState
                framed
                icon={Lock}
                title={tr('没有连上这篇文档')}
                description={tr(
                  '你可能没有访问权限（分享已关闭或已重置），或者登录已失效。刷新页面后再试。',
                )}
              />
            </div>
          ) : !collab || !(collab.ready ?? collab.synced) ? (
            <EditorSkeleton
              offline={collab?.status === 'disconnected' || collab?.online === false}
            />
          ) : (
            <Suspense fallback={<EditorSkeleton />}>
              <Editor
                projectId={pid}
                docId={meta.id}
                meta={meta}
                collab={collab}
                editable={editable}
                canComment={canComment}
                onOutline={setOutline}
                jumpTo={jumpTo}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 页头

function DocHeader({
  pid,
  meta,
  collab,
  editable,
  canArchive,
  canReview,
  back,
  outlineToggle,
}: {
  pid: string;
  meta: DocumentMeta;
  collab: CollabDoc | null;
  editable: boolean;
  canArchive: boolean;
  /** 发起审阅需要 write 角色（API §2.10），访客不显示入口 */
  canReview: boolean;
  back: React.ReactNode;
  outlineToggle: React.ReactNode;
}) {
  const navigate = useNavigate();
  const patch = usePatchDoc(pid, meta.id);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const personal = meta.space === 'personal';

  const members = useMemo<AvatarStackMember[]>(
    () => (collab?.peers ?? []).map(peerToMember),
    [collab?.peers],
  );

  const exportMarkdown = async () => {
    try {
      const content = await fetchDocMarkdown(pid, meta.id);
      const ext = meta.kind === 'latex' ? 'tex' : 'md';
      downloadText(`${safeFileName(meta.title)}.${ext}`, content.markdown);
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : tr('导出失败，请稍后再试'),
        tone: 'danger',
      });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ title: tr('已复制链接'), tone: 'success' });
    } catch {
      toast({ title: tr('复制失败，可以直接复制地址栏'), tone: 'warning' });
    }
  };

  const toggleArchive = () =>
    patch.mutate(
      { archived: !meta.archivedAt },
      {
        onSuccess: (m) => {
          toast({ title: m.archivedAt ? tr('已归档') : tr('已恢复'), tone: 'success' });
          if (m.archivedAt) navigate(projectPath(pid, 'docs'));
        },
        onError: (err) =>
          toast({
            title: err instanceof ApiRequestError ? err.message : tr('操作失败'),
            tone: 'danger',
          }),
      },
    );

  return (
    <header className="flex shrink-0 flex-col px-4 pt-2 pb-2 md:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {back}
        <ConnectionBadge collab={collab} />
        <PageTitle>
          <TitleInput
            value={meta.title}
            editable={editable}
            onSave={(title) =>
              patch.mutate(
                { title },
                {
                  onError: () =>
                    toast({ title: tr('标题没有保存成功，请再试一次'), tone: 'danger' }),
                },
              )
            }
          />
        </PageTitle>
        {personal && (
          <SpaceBadge
            space={meta.space}
            ownerUserId={meta.ownerUserId}
            access={meta.access}
            shared={meta.shared}
          />
        )}
        {personal && meta.access === 'manage' && !meta.shared && (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-subtle">
            <Lock size={12} strokeWidth={2} aria-hidden />
            {tr('仅自己可见')}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {members.length > 0 && (
            <AvatarStack
              members={members}
              max={3}
              size={24}
              expand="left"
              label={tr('当前文档在线成员')}
              className="mr-2"
            />
          )}
          {outlineToggle}
          <IconButton label={tr('版本历史')} onClick={() => setVersionsOpen(true)}>
            <History size={16} strokeWidth={1.75} />
          </IconButton>
          {canReview && (
            <Button
              variant="secondary"
              size="sm"
              className="hidden sm:inline-flex"
              leftIcon={<GitPullRequest size={14} strokeWidth={1.75} aria-hidden />}
              onClick={() => setReviewOpen(true)}
            >
              {tr('请求审阅')}
            </Button>
          )}
          <Button
            variant={personal && meta.access === 'manage' ? 'primary' : 'secondary'}
            size="sm"
            className="max-md:size-10 max-md:px-0"
            aria-label={tr('分享')}
            leftIcon={<Share2 size={14} strokeWidth={1.75} aria-hidden />}
            onClick={() => setShareOpen(true)}
          >
            <span className="max-md:sr-only">{tr('分享')}</span>
          </Button>
          <Menu
            label={tr('更多操作')}
            align="end"
            trigger={
              <IconButton label={tr('更多操作')}>
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </IconButton>
            }
          >
            {canReview && (
              <MenuItem
                className="sm:hidden"
                icon={<GitPullRequest size={14} strokeWidth={1.75} />}
                onSelect={() => setReviewOpen(true)}
              >
                {tr('请求审阅')}
              </MenuItem>
            )}
            <MenuItem
              icon={<Download size={14} strokeWidth={1.75} />}
              onSelect={() => void exportMarkdown()}
            >
              {meta.kind === 'latex' ? tr('下载 .tex 源码') : tr('导出 Markdown')}
            </MenuItem>
            <MenuItem
              icon={<Link2 size={14} strokeWidth={1.75} />}
              onSelect={() => void copyLink()}
            >
              {tr('复制链接')}
            </MenuItem>
            {canArchive && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={
                    meta.archivedAt ? (
                      <ArchiveRestore size={14} strokeWidth={1.75} />
                    ) : (
                      <Archive size={14} strokeWidth={1.75} />
                    )
                  }
                  onSelect={toggleArchive}
                >
                  {meta.archivedAt ? tr('恢复文档') : tr('归档')}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      <ProposalBanner pid={pid} targetKind="document" targetId={meta.id} />
      <SharePanel
        pid={pid}
        kind="document"
        target={
          shareOpen
            ? {
                id: meta.id,
                title: meta.title,
                href: projectPath(pid, `docs/${meta.id}`),
                createdBy: meta.createdBy.kind === 'user' ? meta.createdBy.id : null,
              }
            : null
        }
        onClose={() => setShareOpen(false)}
      />
      <VersionHistorySheet
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        pid={pid}
        targetKind="document"
        targetId={meta.id}
        title={meta.title}
        editable={editable && !meta.archivedAt}
      />
      {canReview && (
        <RequestReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          defaultTarget={{ kind: 'document', id: meta.id, title: meta.title }}
        />
      )}
    </header>
  );
}

function peerToMember(p: CollabPeer): AvatarStackMember {
  const s = p.state;
  const activity = p.isSelf
    ? tr('你')
    : p.user.kind === 'agent'
      ? tr('正在编辑')
      : typeof s.cell === 'string'
        ? tr('在单元格 {value}', { value: cellLabel(s.cell) })
        : s.cursor
          ? tr('正在编辑')
          : tr('正在查看');
  return {
    id: p.user.id,
    name: p.user.name,
    color: p.user.colorIndex,
    kind: p.user.kind === 'agent' ? 'agent' : 'user',
    activity,
  };
}

function cellLabel(key: string): string {
  const [r, c] = key.split(':').map(Number) as [number, number];
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1}`;
}

/**
 * 同步状态徽标：如实显示离线 / 正在重连 / 有未同步的修改 / 已同步。
 * 判定见 collab/syncState.ts（断网立即显示，不等 WebSocket 超时）。
 */
function ConnectionBadge({ collab }: { collab: CollabDoc | null }) {
  const sync = collab?.sync ?? 'connecting';
  const pending = (collab?.unsynced ?? 0) > 0;
  let body: React.ReactNode;
  let tip: string;
  switch (sync) {
    case 'denied':
      return null;
    case 'synced':
      tip = tr('修改会实时同步给所有人，并自动保存');
      body = (
        <span className="inline-flex items-center gap-1.5 text-caption text-fg-subtle">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          {tr('已同步')}
        </span>
      );
      break;
    case 'unsynced':
      tip = tr(
        '修改已保存在这台设备上，还没传到服务器，别人暂时看不到。关闭页面前请等它变成「已同步」。',
      );
      body = (
        <span className="inline-flex items-center gap-1.5 text-caption text-warning">
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
          {tr('有未同步的修改')}
        </span>
      );
      break;
    case 'offline':
      tip = pending
        ? tr('网络断开了。你的修改保存在这台设备上，联网后会自动同步给其他人。')
        : tr('网络断开了，联网后会自动重新连接。');
      body = (
        <span className="inline-flex items-center gap-1.5 text-caption text-warning">
          <WifiOff size={12} strokeWidth={1.75} aria-hidden />
          {pending ? tr('离线 · 有未同步的修改') : tr('离线')}
        </span>
      );
      break;
    case 'reconnecting':
      tip = pending
        ? tr('和服务器的连接断了，正在重连。你的修改保存在这台设备上，连上后自动同步。')
        : tr('和服务器的连接断了，正在重连。');
      body = (
        <span className="inline-flex items-center gap-1.5 text-caption text-warning">
          <WifiOff size={12} strokeWidth={1.75} aria-hidden />
          {pending ? tr('正在重连 · 有未同步的修改') : tr('正在重连')}
        </span>
      );
      break;
    default:
      tip = tr('正在连接协同服务');
      body = (
        <span className="inline-flex items-center gap-1.5 text-caption text-fg-subtle">
          <span
            className="size-1.5 animate-pulse rounded-full bg-fg-subtle motion-reduce:animate-none"
            aria-hidden
          />
          {tr('正在连接')}
        </span>
      );
  }
  return (
    <Tooltip content={tip}>
      <span role="status" aria-live="polite" data-sync={sync} className="inline-flex min-w-0">
        {body}
      </span>
    </Tooltip>
  );
}

/** 新建的富文本文档没起标题时，标题跟随正文第一个一级标题（停止输入 1.5 秒后保存） */
function useAutoTitle(
  pid: string,
  meta: DocumentMeta,
  outline: DocumentOutlineItem[],
  editable: boolean,
) {
  const patch = usePatchDoc(pid, meta.id);
  const next = editable ? titleFromOutline(meta, outline) : null;
  const sent = useRef<string | null>(null);
  const mutate = patch.mutate;
  useEffect(() => {
    if (!next || sent.current === next) return;
    const timer = setTimeout(() => {
      sent.current = next;
      mutate({ title: next });
    }, 1500);
    return () => clearTimeout(timer);
  }, [next, mutate]);
}

function TitleInput({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim() || tr('未命名文档');
    setDraft(next);
    if (next !== value) onSave(next);
  };
  if (!editable) return <span className="min-w-0 truncate text-small text-fg">{value}</span>;
  return (
    <input
      aria-label={tr('文档标题')}
      value={draft}
      maxLength={200}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      className="w-full min-w-0 flex-1 truncate rounded-sm bg-transparent text-small font-semibold text-fg outline-none placeholder:text-fg-subtle focus-visible:bg-subtle"
      placeholder={tr('未命名文档')}
    />
  );
}

// ---------------------------------------------------------------- 大纲

function OutlinePanel({
  items,
  onJump,
}: {
  items: DocumentOutlineItem[];
  onJump: (i: number) => void;
}) {
  const { spring } = useMotionPreset();
  const minLevel = Math.min(...items.map((i) => i.level));
  return (
    <motion.nav
      aria-label={tr('大纲')}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={spring.gentle}
      className="hidden w-56 shrink-0 overflow-y-auto border-r border-line px-3 py-4 xl:block"
    >
      <p className="mb-2 px-2 text-caption text-fg-subtle">{tr('大纲')}</p>
      <ul className="flex flex-col">
        {items.map((item, i) => (
          <li key={`${i}-${item.heading}`}>
            <button
              type="button"
              onClick={() => onJump(i)}
              style={{ paddingLeft: `${8 + (item.level - minLevel) * 12}px` }}
              className={cn(
                'w-full truncate rounded-sm py-1 pr-2 text-left text-small transition-colors duration-(--dur-fast) hover:bg-subtle hover:text-fg',
                item.level === minLevel ? 'text-fg' : 'text-fg-muted',
              )}
            >
              {item.heading}
            </button>
          </li>
        ))}
      </ul>
    </motion.nav>
  );
}

// ---------------------------------------------------------------- 骨架

function DocSkeleton({ back }: { back: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-4 px-4 pt-4 md:px-6">
      {back}
      <div className="flex items-center gap-3">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-7 w-64 max-w-[60%]" />
      </div>
      <EditorSkeleton />
    </div>
  );
}

function EditorSkeleton({ offline = false }: { offline?: boolean }) {
  return (
    <div
      className="mx-auto flex w-full max-w-(--doc-max) flex-col gap-3 px-4 py-8 md:px-6"
      aria-busy
    >
      {offline && <p className="text-small text-warning">{tr('连接不上协同服务，正在重试…')}</p>}
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-4 h-5 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

// ---------------------------------------------------------------- 工具

function safeFileName(title: string) {
  return (title || tr('未命名文档')).replace(/[\\/:*?"<>|]+/gu, '_').slice(0, 80);
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
