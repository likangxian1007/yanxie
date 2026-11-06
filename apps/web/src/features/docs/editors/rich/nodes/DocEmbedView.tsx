import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { Check, ExternalLink, Link2Off, Pencil, RotateCw, Trash2, WifiOff } from 'lucide-react';
import { DOCUMENT_KIND_LABEL, type DocumentKind, type DocumentMeta } from '@srh/shared';
import { Button, IconButton, Skeleton, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { canWrite, useMyRole } from '@/lib/project';
import { useCollabDoc } from '../../../collab/useCollabDoc';
import { useDocMeta } from '../../../detail/api';
import { DocKindIcon } from '../../../kinds';
import type { DocEditorProps } from '../../types';
import { ICON_STROKE } from '../components/icons';
import { useRichEnv } from '../context';
import { SheetPreview, SlidesPreview } from '../embed/EmbedPreviews';
import { docHref, embedProblem, isLiveKind } from '../embed/lib';
import { tr } from '@/lib/i18n';

const SheetEditor = lazy(() => import('../../sheet').then((m) => ({ default: m.SheetEditor })));
const SlidesEditor = lazy(() => import('../../slides').then((m) => ({ default: m.SlidesEditor })));
const LIVE_EDITORS: Partial<Record<DocumentKind, ComponentType<DocEditorProps>>> = {
  sheet: SheetEditor,
  slides: SlidesEditor,
};

const DEFAULT_HEIGHT: Record<DocumentKind, number> = { sheet: 320, slides: 0, doc: 0, latex: 0 };
const EDIT_MIN_HEIGHT = 440;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1200;
/** 滚出视口多久后断开内嵌文档的协同连接 */
const DISCONNECT_DELAY = 4000;

/**
 * 内嵌文档块（飞书式“嵌入表格 / 幻灯片”）：
 * - 表格、幻灯片：滚到视口附近才建立自己的 /collab 连接（滚走几秒后断开），实时显示原文档；
 *   有写权限时可以“就地编辑”（直接用表格 / 幻灯片编辑器），或在新页面打开；
 * - 文档、LaTeX：显示标题与摘要卡片；
 * - 原文档被删、没有权限：退化成链接卡片。
 */
export function DocEmbedView({
  node,
  updateAttributes,
  selected,
  editor,
  deleteNode,
}: ReactNodeViewProps) {
  const { projectId } = useRichEnv();
  const docId = String(node.attrs.docId ?? '');
  const attrKind = String(node.attrs.kind ?? 'sheet') as DocumentKind;
  const attrTitle = String(node.attrs.title ?? '');
  const attrHeight = Number(node.attrs.height) || null;
  const editable = editor.isEditable;
  const metaQuery = useDocMeta(projectId, docId);
  const meta = metaQuery.data;
  const kind = meta?.kind ?? attrKind;
  const title = meta?.title ?? attrTitle;
  const role = useMyRole(projectId);
  const canEditSource = canWrite(role) && !meta?.archivedAt;

  // 原文档改名：同步到节点属性（导出 markdown、agent 读到的标题跟着变）
  useEffect(() => {
    if (editable && meta && meta.title !== attrTitle) updateAttributes({ title: meta.title });
    if (editable && meta && meta.kind !== attrKind) updateAttributes({ kind: meta.kind });
  }, [editable, meta, attrTitle, attrKind, updateAttributes]);

  const [editing, setEditing] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const live = useNearViewport(bodyRef, isLiveKind(kind) && !!meta);

  const height = Math.max(
    dragHeight ?? attrHeight ?? DEFAULT_HEIGHT[kind],
    editing ? EDIT_MIN_HEIGHT : 0,
  );
  const fixedHeight = kind === 'sheet' || editing;

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = body.getBoundingClientRect().height;
    let latest = startH;
    const onMove = (ev: PointerEvent) => {
      latest = Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH + ev.clientY - startY)));
      setDragHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragHeight(null);
      updateAttributes({ height: latest });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const href = docHref(projectId, docId);
  const problem = metaQuery.isError ? embedProblem(metaQuery.error) : null;

  return (
    <NodeViewWrapper data-type="doc-embed" className="my-2">
      <div
        className={cn(
          'overflow-hidden rounded-lg border border-line bg-surface shadow-xs',
          selected && editable && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
        )}
      >
        <div
          data-drag-handle
          className="flex min-h-10 items-center gap-2 border-b border-line bg-canvas px-3 py-1.5"
        >
          <DocKindIcon kind={kind} size="sm" label={DOCUMENT_KIND_LABEL[kind]} />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={title}>
            {title || tr('未命名文档')}
          </span>
          {meta?.archivedAt && (
            <span className="shrink-0 text-caption text-fg-subtle">{tr('已归档')}</span>
          )}
          <span data-node-interactive className="flex shrink-0 items-center gap-0.5">
            {meta && isLiveKind(kind) && canEditSource && (
              <Button
                size="sm"
                variant={editing ? 'secondary' : 'ghost'}
                leftIcon={
                  editing ? (
                    <Check strokeWidth={ICON_STROKE} aria-hidden />
                  ) : (
                    <Pencil strokeWidth={ICON_STROKE} aria-hidden />
                  )
                }
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? tr('完成') : tr('编辑')}
              </Button>
            )}
            <Tooltip content={tr('在新页面打开')}>
              <a
                href={href}
                target="_blank"
                rel="noopener"
                aria-label={tr('在新页面打开')}
                className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors duration-(--dur-fast) hover:bg-subtle hover:text-fg"
              >
                <ExternalLink size={16} strokeWidth={ICON_STROKE} aria-hidden />
              </a>
            </Tooltip>
            {editable && (
              <IconButton
                size="sm"
                label={tr('移除嵌入（不会删除原文档）')}
                className="hover:bg-danger-soft hover:text-danger"
                onClick={() => deleteNode()}
              >
                <Trash2 strokeWidth={ICON_STROKE} />
              </IconButton>
            )}
          </span>
        </div>

        <div
          ref={bodyRef}
          data-node-interactive
          className="relative flex min-h-0 flex-col"
          style={fixedHeight && height ? { height } : undefined}
        >
          {metaQuery.isPending ? (
            <div
              className="flex flex-col gap-2 p-4"
              aria-busy="true"
              aria-label={tr('正在加载内嵌文档')}
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : problem === 'gone' ? (
            <DegradedCard
              icon={<Link2Off size={16} strokeWidth={ICON_STROKE} aria-hidden />}
              text={tr('原文档已被删除，或者你没有权限查看。')}
            />
          ) : problem === 'error' ? (
            <DegradedCard
              icon={<WifiOff size={16} strokeWidth={ICON_STROKE} aria-hidden />}
              text={tr('内嵌文档没有加载出来。')}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  leftIcon={<RotateCw strokeWidth={ICON_STROKE} aria-hidden />}
                  onClick={() => void metaQuery.refetch()}
                >
                  {tr('重试')}
                </Button>
              }
            />
          ) : meta && isLiveKind(kind) ? (
            live ? (
              <LiveEmbed
                projectId={projectId}
                meta={meta}
                editing={editing && canEditSource}
                kind={kind}
              />
            ) : (
              <EmbedSkeleton kind={kind} />
            )
          ) : meta ? (
            <a
              href={href}
              className="block px-4 py-3 text-small text-fg-muted transition-colors duration-(--dur-fast) hover:bg-subtle"
            >
              <span className="line-clamp-3">{meta.excerpt || tr('（还没有内容）')}</span>
              <span className="mt-1 inline-flex items-center gap-1 text-caption text-accent-text">
                {tr('打开')}
                {DOCUMENT_KIND_LABEL[kind]}
                <ExternalLink size={12} strokeWidth={ICON_STROKE} aria-hidden />
              </span>
            </a>
          ) : null}
        </div>
        {editable && fixedHeight && meta && (
          <div
            data-node-interactive
            role="separator"
            aria-orientation="horizontal"
            aria-label={tr('拖动调整高度')}
            onPointerDown={startResize}
            className="group/resize flex h-2.5 cursor-ns-resize touch-none items-center justify-center border-t border-line bg-canvas"
          >
            <span className="h-0.5 w-8 rounded-full bg-line-strong transition-colors duration-(--dur-fast) group-hover/resize:bg-accent" />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

function DegradedCard({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-small text-fg-muted">
      <span className="text-fg-subtle">{icon}</span>
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

function EmbedSkeleton({ kind }: { kind: DocumentKind }) {
  return (
    <div
      className={cn('flex flex-col gap-2 p-3', kind === 'slides' && 'aspect-video')}
      aria-busy="true"
      aria-label={tr('正在连接内嵌文档')}
    >
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

function LiveEmbed({
  projectId,
  meta,
  kind,
  editing,
}: {
  projectId: string;
  meta: DocumentMeta;
  kind: DocumentKind;
  editing: boolean;
}) {
  const collab = useCollabDoc(meta.id);
  if (collab?.status === 'denied') {
    return (
      <DegradedCard
        icon={<Link2Off size={16} strokeWidth={ICON_STROKE} aria-hidden />}
        text={tr('没有连上原文档，你可能没有权限查看。')}
      />
    );
  }
  if (!collab || !collab.synced) return <EmbedSkeleton kind={kind} />;
  const Editor = LIVE_EDITORS[kind];
  if (editing && Editor) {
    return (
      <Suspense fallback={<EmbedSkeleton kind={kind} />}>
        <div className="rich-embed-editor flex min-h-0 flex-1 flex-col">
          <Editor projectId={projectId} docId={meta.id} meta={meta} collab={collab} editable />
        </div>
      </Suspense>
    );
  }
  return kind === 'sheet' ? <SheetPreview doc={collab.doc} /> : <SlidesPreview doc={collab.doc} />;
}

/**
 * 元素进入视口附近（上下 300px）时为 true；离开后延迟 DISCONNECT_DELAY 才变回 false，
 * 来回滚动不会反复建连。没有 IntersectionObserver 的环境（测试）一直是 false。
 */
function useNearViewport(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    let timer = 0;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        window.clearTimeout(timer);
        if (visible) setNear(true);
        else timer = window.setTimeout(() => setNear(false), DISCONNECT_DELAY);
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => {
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [ref, enabled]);
  return near && enabled;
}
