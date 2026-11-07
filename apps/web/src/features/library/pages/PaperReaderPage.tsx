import { PageTitle } from '@/components/layout/Page';
import { useListReturnHref } from '@/components/layout/list-return';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ExternalLink,
  FileUp,
  FileText,
  MoreHorizontal,
  RotateCw,
  Share2,
  Trash2,
  Maximize,
  Minimize,
} from 'lucide-react';
import type { PdfBox, PaperAnnotation, PaperQaAskInput } from '@srh/shared';
import { useReaderFullscreen } from '../lib/useReaderFullscreen';
import { useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Skeleton,
  Tabs,
  toast,
} from '@/components/ui';
import { canWrite, useMyRole } from '@/lib/project';
import { accessAtLeast } from '@srh/shared';
import { effectiveAccess, useShareEvents } from '@/features/sharing/api';
import { SharePanel } from '@/features/sharing/SharePanel';
import { SpaceBadge } from '@/features/sharing/SpaceBadge';
import { cn } from '@/lib/cn';
import {
  useAttachPdf,
  useDeletePaper,
  useLibraryEvents,
  useLibraryStatus,
  usePaper,
  usePaperPdf,
  useReparse,
  useUpdatePaper,
} from '../api';
import { BibtexPanel } from '../components/BibtexPanel';
import { NotesPanel } from '../components/NotesPanel';
import { AnnotationsPanel } from '../components/AnnotationsPanel';
import { AnnotationCreateDialog, type AnnotationDraft } from '../components/AnnotationCreateDialog';
import { annotationsKey, usePaperAnnotations } from '../annotations-api';
import { ParseProgress } from '../components/ParseProgress';
import { QaPanel } from '../components/QaPanel';
import { PublishPaperDialog } from '../components/PublishPaperDialog';
import { PaperMetadataDialog } from '../components/PaperMetadataDialog';
import { ParsingHelpDialog } from '../components/ParsingHelpDialog';
import { StructurePanel } from '../components/StructurePanel';
import {
  PARSER_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  isWorking,
  sharedReady,
  shortAuthors,
  sourceLine,
} from '../lib/format';
import { ReaderContext, chunkAt, useMedia, useReader, type ReaderCtx } from '../lib/reader';
import { type PdfJumpTarget, type PdfMark } from '../pdf/PaperPdfViewer';
import { PaperSelectionReader } from '../pdf/PaperSelectionReader';
import { SelectionTranslation } from '../pdf/SelectionTranslation';
import type { PdfTextSelection } from '../pdf/selection';
import { usePdfDocument } from '../pdf/usePdfDocument';
import { PdfTranslateButton } from '../pdf/PdfTranslateDialog';
import { isPersonalLibrary, libraryKey, libraryPath, type LibraryScope } from '../lib/scope';
import { useLibraryScope } from '../lib/use-library-scope';
import '../library.css';
import { tr } from '@/lib/i18n';

type Panel = 'pdf' | 'structure' | 'qa' | 'notes' | 'bibtex' | 'translation' | 'annotations';

/**
 * 论文阅读页：左边 PDF（高亮、跳转），右边 结构 / 问答 / 笔记 / BibTeX。
 * 窄屏（< 1024px）时 PDF 也变成一个标签页，点引用会自动切回原文。
 */
export function PaperReaderPage() {
  const scope = useLibraryScope();
  const { paperId = '' } = useParams();
  return (
    <PaperReader
      key={`${JSON.stringify(libraryKey(scope))}:${paperId}`}
      pid={scope}
      paperId={paperId}
    />
  );
}

function PaperReader({ pid, paperId }: { pid: LibraryScope; paperId: string }) {
  const fullscreen = useReaderFullscreen();
  const [qaSelection, setQaSelection] = useState<PaperQaAskInput['selection'] | null>(null);
  const returnHref = useListReturnHref(libraryPath(pid));
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const personal = isPersonalLibrary(pid);
  const role = useMyRole(personal ? '' : pid);
  const roleWrite = personal || canWrite(role);
  useLibraryEvents(pid);
  useShareEvents(typeof pid === 'string' ? pid : '');
  const query = usePaper(pid, paperId);
  const paper = query.data;
  const annotations = usePaperAnnotations(pid, paperId);
  const qc = useQueryClient();
  const [annotationDraft, setAnnotationDraft] = useState<AnnotationDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState('');
  const writable = personal || accessAtLeast(effectiveAccess(paper?.access, roleWrite), 'edit');
  const editable = personal || (paper?.space === 'personal' ? writable : role !== null);
  const status = useLibraryStatus(pid);
  const pdfBytes = usePaperPdf(pid, paper);
  const pdf = usePdfDocument(pdfBytes.data);
  const wide = useMedia('(min-width: 1024px)');
  const [panelState, setPanel] = useState<Panel>('pdf');
  const [qaVisited, setQaVisited] = useState('');
  // 宽屏没有“原文”标签（PDF 常驻左侧）
  const panel: Panel = wide && panelState === 'pdf' ? 'structure' : panelState;
  const [target, setTarget] = useState<PdfJumpTarget | null>(null);
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
  const [selected, setSelected] = useState<{ fileId: string; value: PdfTextSelection } | null>(
    null,
  );
  const fileId = paper?.fileId ?? '';
  const onTextSelected = useCallback(
    (value: PdfTextSelection) => {
      setSelected((previous) =>
        previous?.fileId === fileId &&
        previous.value.text === value.text &&
        previous.value.page === value.page &&
        JSON.stringify(previous.value.boxes) === JSON.stringify(value.boxes)
          ? previous
          : { fileId, value },
      );
      if (wide) setPanel('translation');
    },
    [fileId, wide],
  );
  const openTranslation = useCallback(() => setPanel('translation'), []);
  const askSelection = (value: PdfTextSelection) => {
    if (!writable || !fileId) return;
    if (value.text.length > 4000) {
      toast({
        tone: 'info',
        title: tr('请缩小引用范围'),
        description: tr('每次最多引用 4000 字符。'),
      });
      return;
    }
    setQaSelection({ fileId, page: value.page, text: value.text });
    setQaVisited(paperId);
    setPanel('qa');
  };
  const createAnnotation = (kind: 'highlight' | 'comment', selection: PdfTextSelection) => {
    if (!fileId || !editable || paper?.archivedAt) return;
    setAnnotationDraft({ kind, selection, fileId });
  };
  const jumpAnnotation = (annotation: PaperAnnotation, revealPdf = true) => {
    if (annotation.fileId !== fileId || annotation.anchorStatus !== 'current') return;
    setTarget((t) => ({
      n: (t?.n ?? 0) + 1,
      page: annotation.page,
      boxes: annotation.boxes,
      coordinateSpace: 'pdf',
    }));
    if (!wide && revealPdf) setPanel('pdf');
  };

  /** 跳到某页并闪烁高亮；窄屏先切到“原文”，PDF 视图挂载后按 target 滚动 */
  const jump = useCallback(
    (page: number, boxes?: PdfBox[]) => {
      setTarget((t) => ({ n: (t?.n ?? 0) + 1, page, boxes: boxes ?? [] }));
      if (!wide) setPanel('pdf');
    },
    [wide],
  );

  // ?seq=12：从全文检索 / 跨论文引用跳过来
  const seqParam = params.get('seq');
  useEffect(() => {
    if (seqParam === null || !paper?.structure) return;
    const c = paper.structure.chunks.find((x) => x.seq === Number(seqParam));
    const t = setTimeout(() => {
      if (c) {
        setActiveSeq(c.seq);
        jump(c.page, c.boxes);
      }
      const next = new URLSearchParams(params);
      next.delete('seq');
      setParams(next, { replace: true });
    }, 0);
    return () => clearTimeout(t);
  }, [seqParam, paper?.structure, jump, params, setParams]);

  const marks = useMemo<PdfMark[]>(() => {
    const out: PdfMark[] = [];
    const active =
      activeSeq !== null ? paper?.structure?.chunks.find((c) => c.seq === activeSeq) : undefined;
    if (active) out.push({ key: `sel-${active.seq}`, boxes: active.boxes, tone: 'select' });
    if (target?.boxes.length && target.coordinateSpace !== 'pdf')
      out.push({ key: `flash-${target.n}`, boxes: target.boxes, tone: 'flash' });
    for (const a of annotations.data ?? []) {
      if (!a.deletedAt && a.fileId === fileId && a.anchorStatus === 'current')
        out.push({
          key: a.id,
          boxes: a.boxes,
          tone: a.kind,
          color: a.color,
          active: a.id === activeAnnotation,
        });
    }
    return out;
  }, [activeSeq, target, paper?.structure, annotations.data, fileId, activeAnnotation]);

  const ctx = useMemo<ReaderCtx | null>(
    () => (paper ? { paper, doc: pdf.doc, jump, activeSeq, writable, editable, scope: pid } : null),
    [paper, pdf.doc, jump, activeSeq, writable, editable, pid],
  );

  if (query.isPending) {
    return (
      <div
        className="flex h-[calc(100dvh-var(--topbar-h))] flex-col gap-3 p-4"
        role="status"
        aria-label={tr('正在加载论文')}
      >
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <div className="flex min-h-0 flex-1 gap-3">
          <Skeleton className="h-full flex-1" />
          <Skeleton className="hidden h-full w-[40%] lg:block" />
        </div>
      </div>
    );
  }
  if (query.isError || !paper || !ctx) {
    return (
      <div className="p-6">
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('论文没有打开')}
          description={query.error?.message ?? tr('可能已被删除，或所有者关闭了分享。')}
          action={
            <Button variant="secondary" onClick={() => navigate(returnHref)}>
              {tr('回文献库')}
            </Button>
          }
        />
      </div>
    );
  }

  const pdfArea = (
    <PdfArea
      ctx={ctx}
      pdfState={pdf}
      pdfError={pdfBytes.error?.message ?? null}
      target={target}
      marks={marks}
      onTextSelected={onTextSelected}
      onOpenTranslation={openTranslation}
      onAskSelection={writable ? askSelection : undefined}
      onCreateAnnotation={editable && !paper.archivedAt ? createAnnotation : undefined}
      onPointer={(page, x, y) => {
        const c = paper.structure ? chunkAt(paper.structure.chunks, page, x, y) : undefined;
        // 点到段落：选中它（结构面板的“正文”会滚到这一段）
        setActiveSeq(c ? c.seq : null);
      }}
    />
  );

  const panelItems: { value: Panel; label: string }[] = [
    ...(wide ? [] : [{ value: 'pdf' as const, label: tr('原文') }]),
    { value: 'structure', label: tr('结构') },
    { value: 'translation', label: tr('翻译') },
    { value: 'qa', label: tr('问答') },
    { value: 'notes', label: tr('笔记') },
    { value: 'annotations', label: tr('标注') },
    { value: 'bibtex', label: 'BibTeX' },
  ];

  return (
    <ReaderContext.Provider value={ctx}>
      {annotationDraft && (
        <AnnotationCreateDialog
          scope={pid}
          paperId={paper.id}
          draft={annotationDraft}
          onClose={() => setAnnotationDraft(null)}
          onCreated={(a) => {
            setAnnotationDraft(null);
            setActiveAnnotation(a.id);
            void qc.invalidateQueries({ queryKey: annotationsKey(pid, paper.id) });
            window.getSelection()?.removeAllRanges();
            toast({
              tone: 'success',
              title: a.kind === 'highlight' ? tr('高亮已保存') : tr('批注已保存'),
            });
          }}
        />
      )}
      <div
        data-reader-fullscreen={fullscreen.active || undefined}
        className={cn(
          'flex w-full flex-col bg-surface',
          fullscreen.active
            ? 'fixed inset-0 z-40 h-dvh'
            : 'h-[calc(100dvh-var(--topbar-h)-var(--tabbar-h))] min-h-[480px]',
        )}
      >
        <ReaderHeader
          pid={pid}
          writable={writable}
          parserDown={status.data ? !status.data.reachable : false}
          fullscreen={fullscreen.active}
          onFullscreen={() => void fullscreen.toggle()}
        />
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col',
              wide ? 'flex border-r border-line' : panel === 'pdf' ? 'flex' : 'hidden',
            )}
          >
            {pdfArea}
          </div>
          <aside
            className={cn(
              'flex min-h-0 min-w-0 flex-col bg-surface',
              wide
                ? 'w-[min(46%,600px)] shrink-0'
                : panel === 'pdf'
                  ? 'order-first shrink-0'
                  : 'flex-1',
            )}
            aria-label={tr('论文面板')}
          >
            <div className="shrink-0 overflow-x-auto border-b border-line px-2">
              <Tabs
                aria-label={tr('面板')}
                layoutId="lib-reader-panel"
                value={panel}
                onValueChange={(value) => {
                  setPanel(value);
                  if (value === 'qa') setQaVisited(paperId);
                }}
                items={panelItems}
              />
            </div>
            <div className={panel === 'translation' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <SelectionTranslation
                key={fileId}
                scope={pid}
                paperId={paperId}
                fileId={fileId}
                writable={writable}
                selection={selected?.fileId === fileId ? selected.value : null}
                onClear={() => {
                  window.getSelection()?.removeAllRanges();
                  setSelected(null);
                }}
              />
            </div>
            {panel === 'structure' && <StructurePanel />}
            <div className={panel === 'qa' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {(panel === 'qa' || qaVisited === paperId) && (
                <QaPanel
                  key={paper.id}
                  pid={pid}
                  llm={status.data?.llm ?? true}
                  selection={qaSelection}
                  onClearSelection={(sent) =>
                    setQaSelection((current) => (current === sent ? null : current))
                  }
                />
              )}
            </div>
            {panel === 'notes' && <NotesPanel />}
            <div className={panel === 'annotations' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <AnnotationsPanel
                activeId={activeAnnotation}
                onSelect={setActiveAnnotation}
                onJump={jumpAnnotation}
                onOpenNotes={() => setPanel('notes')}
              />
            </div>
            {panel === 'bibtex' && <BibtexPanel />}
          </aside>
        </div>
      </div>
    </ReaderContext.Provider>
  );
}

function PdfArea({
  ctx,
  pdfState,
  pdfError,
  target,
  marks,
  onPointer,
  onTextSelected,
  onOpenTranslation,
  onCreateAnnotation,
  onAskSelection,
}: {
  ctx: ReaderCtx;
  pdfState: ReturnType<typeof usePdfDocument>;
  pdfError: string | null;
  target: PdfJumpTarget | null;
  marks: PdfMark[];
  onPointer: (page: number, x: number, y: number) => void;
  onTextSelected: (selection: PdfTextSelection) => void;
  onOpenTranslation: () => void;
  onCreateAnnotation?: (kind: 'highlight' | 'comment', selection: PdfTextSelection) => void;
  onAskSelection?: (selection: PdfTextSelection) => void;
}) {
  const { paper } = ctx;
  if (!paper.fileId) {
    return <NoPdf />;
  }
  return (
    <PaperSelectionReader
      key={paper.fileId}
      onTextSelected={onTextSelected}
      onOpenTranslation={onOpenTranslation}
      onCreateAnnotation={onCreateAnnotation}
      onAskSelection={onAskSelection}
      target={target}
      doc={pdfState.doc}
      sizes={pdfState.sizes}
      error={pdfError ?? pdfState.error}
      marks={marks}
      onPointer={onPointer}
      className="min-h-0 flex-1"
    />
  );
}

function NoPdf() {
  const { paper, writable, scope: pid } = useReader();
  const attach = useAttachPdf(pid, paper.id);
  const input = useRef<HTMLInputElement | null>(null);
  if (isWorking(paper.status)) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <EmptyState
            icon={FileText}
            title={tr('正在获取 PDF')}
            description={tr('元数据和开放获取 PDF 拉取完成后会自动解析。')}
          />
          <ParseProgress paper={paper} className="mt-4" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <EmptyState
        icon={FileUp}
        title={tr('还没有 PDF')}
        description={paper.error ?? tr('这篇论文没有找到开放获取的 PDF。')}
        action={
          writable ? (
            <>
              <Button
                variant="primary"
                loading={attach.isPending}
                leftIcon={<FileUp strokeWidth={1.75} aria-hidden />}
                onClick={() => input.current?.click()}
              >
                {tr('上传 PDF')}
              </Button>
              <input
                ref={input}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    attach.mutate(f, {
                      onSuccess: () =>
                        toast({ tone: 'success', title: tr('PDF 已上传，正在解析') }),
                      onError: (err) =>
                        toast({ tone: 'danger', title: tr('上传失败'), description: err.message }),
                    });
                  e.target.value = '';
                }}
              />
            </>
          ) : null
        }
      />
    </div>
  );
}

function ReaderHeader({
  pid,
  writable,
  parserDown,
  fullscreen,
  onFullscreen,
}: {
  pid: LibraryScope;
  writable: boolean;
  parserDown: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const { paper, editable } = useReader();
  const returnHref = useListReturnHref(libraryPath(pid));
  const navigate = useNavigate();
  const reparse = useReparse(pid, paper.id);
  const update = useUpdatePaper(pid, paper.id);
  const del = useDeletePaper(pid);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [parsingHelp, setParsingHelp] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // 个人文献只有所有者能归档、删除
  const canRemove =
    writable && (isPersonalLibrary(pid) || paper.space !== 'personal' || paper.access === 'manage');
  const link = paper.arxivId
    ? `https://arxiv.org/abs/${paper.arxivId}`
    : paper.doi
      ? `https://doi.org/${paper.doi}`
      : paper.url;
  const degraded = paper.status === 'ready' && paper.error;

  return (
    <header className="shrink-0 border-b border-line bg-surface px-3 py-2.5 sm:px-4">
      <div className="flex items-start gap-2">
        <IconButton label={tr('回文献库')} size="sm" onClick={() => navigate(returnHref)}>
          <ArrowLeft strokeWidth={1.75} aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1">
          <PageTitle>{paper.title}</PageTitle>
          <p className="mt-0.5 truncate text-small text-fg-muted">
            {shortAuthors(paper.authors)}
            {sourceLine(paper) && <span className="text-fg-subtle"> · {sourceLine(paper)}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={fullscreen ? tr('退出全屏阅读') : tr('全屏阅读')}
            size="sm"
            onClick={onFullscreen}
          >
            {fullscreen ? (
              <Minimize strokeWidth={1.75} aria-hidden />
            ) : (
              <Maximize strokeWidth={1.75} aria-hidden />
            )}
          </IconButton>
          <SpaceBadge
            space={paper.space}
            ownerUserId={paper.ownerUserId}
            access={paper.access}
            shared={paper.shared}
          />
          {!sharedReady(paper) && (
            <Badge tone={STATUS_TONE[paper.status]} className="hidden sm:inline-flex">
              {STATUS_LABEL[paper.status]}
            </Badge>
          )}
          {paper.parser && paper.status === 'ready' && (
            <Badge className="hidden md:inline-flex">
              {PARSER_LABEL[paper.parser] ?? paper.parser}
            </Badge>
          )}
          {!isPersonalLibrary(pid) && (
            <Button
              size="sm"
              variant={
                paper.space === 'personal' && paper.access === 'manage' ? 'primary' : 'secondary'
              }
              className="max-md:size-10 max-md:px-0"
              aria-label={tr('分享')}
              leftIcon={<Share2 strokeWidth={1.75} aria-hidden />}
              onClick={() => setShareOpen(true)}
            >
              <span className="max-md:sr-only">{tr('分享')}</span>
            </Button>
          )}
          <Menu
            label={tr('更多操作')}
            align="end"
            trigger={
              <IconButton label={tr('更多操作')} size="sm">
                <MoreHorizontal strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            {link && (
              <MenuItem
                icon={<ExternalLink strokeWidth={1.75} aria-hidden />}
                onSelect={() => window.open(link, '_blank', 'noopener,noreferrer')}
              >
                {tr('打开原始页面')}
              </MenuItem>
            )}
            {writable && (
              <MenuItem
                icon={<RotateCw strokeWidth={1.75} aria-hidden />}
                disabled={isWorking(paper.status) || reparse.isPending}
                onSelect={() =>
                  reparse.mutate(undefined, {
                    onSuccess: () => toast({ tone: 'info', title: tr('已重新排队解析') }),
                    onError: (e) =>
                      toast({ tone: 'danger', title: tr('重新解析失败'), description: e.message }),
                  })
                }
              >
                {tr('重新解析')}
              </MenuItem>
            )}
            {canRemove && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Archive strokeWidth={1.75} aria-hidden />}
                  onSelect={() =>
                    update.mutate(
                      { archived: true },
                      {
                        onSuccess: () => {
                          toast({
                            tone: 'success',
                            title: tr('已归档'),
                            description: tr('再次导入同一篇会恢复'),
                          });
                          navigate(libraryPath(pid));
                        },
                      },
                    )
                  }
                >
                  {tr('归档')}
                </MenuItem>
                <MenuItem
                  danger
                  icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                  onSelect={() => setConfirmDelete(true)}
                >
                  {tr('删除')}
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-fg-muted">
        <Badge>
          {isPersonalLibrary(pid)
            ? tr('个人文献库 · 仅自己可见')
            : paper.space === 'personal'
              ? tr('项目内个人文献 · 按分享权限可见')
              : tr('项目文献库 · 成员共享')}
        </Badge>
        {isPersonalLibrary(pid) && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setPublishing(true)}>
              {tr('发布到项目')}
            </Button>
            <span>{tr('当前资料仅自己可见，发布时创建独立项目副本。')}</span>
          </>
        )}
        {writable && (
          <PdfTranslateButton scope={pid} paperId={paper.id} hasPdf={Boolean(paper.fileId)} />
        )}
        {editable && (
          <Button size="sm" variant="secondary" onClick={() => setEditingMetadata(true)}>
            {tr('编辑论文信息')}
          </Button>
        )}
      </div>
      {publishing && isPersonalLibrary(pid) && (
        <PublishPaperDialog scope={pid} paper={paper} onClose={() => setPublishing(false)} />
      )}
      {editingMetadata && (
        <PaperMetadataDialog scope={pid} paper={paper} onClose={() => setEditingMetadata(false)} />
      )}
      {parsingHelp && (
        <ParsingHelpDialog scope={pid} paper={paper} onClose={() => setParsingHelp(false)} />
      )}
      {!isPersonalLibrary(pid) && (
        <SharePanel
          pid={typeof pid === 'string' ? pid : ''}
          kind="paper"
          target={
            shareOpen
              ? {
                  id: paper.id,
                  title: paper.title,
                  href: libraryPath(pid, paper.id),
                  createdBy: paper.createdBy.kind === 'user' ? paper.createdBy.id : null,
                }
              : null
          }
          onClose={() => setShareOpen(false)}
        />
      )}
      {isWorking(paper.status) && paper.fileId && <ParseProgress paper={paper} className="mt-2" />}
      {(paper.status === 'failed' || degraded) && (
        <div
          className={cn(
            'mt-2 flex items-start gap-2 rounded-md px-2.5 py-1.5 text-caption',
            paper.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-fg',
          )}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1">
            {degraded && paper.parser === 'pdf-text'
              ? tr('已提取正文，可阅读与翻译；结构解析暂不可用。')
              : paper.error || tr('解析未完成，请查看解析帮助。')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setParsingHelp(true)}>
            {tr('解析帮助')}
          </Button>
          {writable && !parserDown && (
            <Button
              size="sm"
              variant="ghost"
              loading={reparse.isPending}
              onClick={() =>
                reparse.mutate(undefined, {
                  onSuccess: () => toast({ tone: 'info', title: tr('已重新排队解析') }),
                  onError: (e) =>
                    toast({ tone: 'danger', title: tr('重新解析失败'), description: e.message }),
                })
              }
            >
              {tr('重新解析')}
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr('删除这篇论文')}
        description={tr(
          '论文、解析结果和文献库里存的 PDF 都会删除；已经写进 LaTeX 文档的 BibTeX 不受影响。',
        )}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(paper.id, {
                  onSuccess: () => {
                    toast({ tone: 'success', title: tr('已删除') });
                    navigate(libraryPath(pid));
                  },
                  onError: (e) =>
                    toast({ tone: 'danger', title: tr('删除失败'), description: e.message }),
                })
              }
            >
              {tr('删除论文')}
            </Button>
          </>
        }
      />
      <Link to={libraryPath(pid)} className="sr-only">
        {tr('回文献库')}
      </Link>
    </header>
  );
}
