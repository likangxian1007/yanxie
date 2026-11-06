import { previewReturnTo, resourcePageHref } from '@/features/resource-preview/links';
import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { absoluteUrl } from '@/lib/base-path';
import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import type { DocumentMeta } from '@srh/shared';
import { Archive, Inbox, Lock, Search, SearchX, Upload } from 'lucide-react';
import {
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Tabs,
  toast,
  type AvatarStackMember,
} from '@/components/ui';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { useMotionPreset } from '@/lib/motion';
import { usePinStore, usePins } from '@/lib/pins';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import {
  countBySpace,
  readSpaceTab,
  spaceTabOf,
  useShareEvents,
  type SpaceTab,
} from '@/features/sharing/api';
import { SharePanel } from '@/features/sharing/SharePanel';
import { DropOverlay, ImportDialog } from '../import/ImportDialog';
import { useDocsImport } from '../import/useDocsImport';
import { DOC_KIND_META, DOC_KINDS } from '../kinds';
import { ArchivedDialog } from '../list/ArchivedDialog';
import { MoveDocDialog, RenameDocDialog } from '../list/DocDialogs';
import type { DocActions } from '../list/DocActionsMenu';
import { DocGridView } from '../list/DocGridView';
import { DocListView } from '../list/DocListView';
import { DocsEmpty } from '../list/DocsEmpty';
import { TemplateGallery } from '../list/TemplateGallery';
import { NewDocMenu } from '../list/NewDocMenu';
import {
  buildTree,
  compareDocs,
  countByKind,
  filterDocs,
  pinnedFirst,
  type DocKindFilter,
  type DocSort,
} from '../list/doc-tree';
import { useCreateAndOpen } from '../list/use-create-doc';
import { useDocs, useDocsRealtime, useUpdateDoc } from '../list/use-docs';
import { tr } from '@/lib/i18n';

type DocView = 'list' | 'grid';
const VIEW_KEY = 'srh-docs-view';

function readView(): DocView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

const SORT_OPTIONS = [
  { value: 'updated', label: tr('最近更新') },
  { value: 'title', label: tr('标题') },
];

export interface DocsPageProps {
  /**
   * 正在编辑某文档的人（预留接口：协同在线状态接入后传入）。
   * 返回空数组或 undefined 时不显示。
   */
  editorsOf?: (docId: string) => AvatarStackMember[] | undefined;
}

/** 文档首页（飞书云文档式）：类型 Tabs、搜索、排序、列表 / 网格、树形子文档、归档 */
export function DocsPage({ editorsOf }: DocsPageProps = {}) {
  const pid = useProjectId();
  const location = useLocation();
  useListStateScope('docs');
  const navigate = useNavigate();
  const canEdit = canWrite(useMyRole(pid));
  const { variants } = useMotionPreset();

  const me = useMeUser()?.id ?? null;
  // 空间：团队空间（课题共享）/ 我的空间（只有自己）/ 与我共享（别人个人空间里分享给我的）
  const [rawSpace, setSpace] = useListQueryState('space', 'team');
  const space: SpaceTab = readSpaceTab(rawSpace);
  // 在「与我共享」里新建的文档放进自己的个人空间
  const createIn = space === 'team' ? 'team' : 'personal';

  const docsQuery = useDocs(pid);
  useDocsRealtime(pid);
  useShareEvents(pid);
  const update = useUpdateDoc(pid);
  const creator = useCreateAndOpen(pid, createIn);
  const importer = useDocsImport(pid, canEdit, createIn);

  const [rawKind, setKind] = useListQueryState('kind', 'all');
  const kind: DocKindFilter = DOC_KINDS.includes(rawKind as (typeof DOC_KINDS)[number])
    ? (rawKind as DocKindFilter)
    : 'all';
  const [query, setQuery] = useListQueryState('q', '');
  const [rawSort, setSort] = useListQueryState('sort', 'updated');
  const sort: DocSort = rawSort === 'title' ? 'title' : 'updated';
  const [rawView, setViewState] = useListQueryState('view', readView());
  const view: DocView = rawView === 'grid' ? 'grid' : 'list';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renaming, setRenaming] = useState<DocumentMeta | null>(null);
  const [moving, setMoving] = useState<DocumentMeta | null>(null);
  const [sharing, setSharing] = useState<DocumentMeta | null>(null);

  const setView = (v: DocView) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 忽略
    }
  };

  const visible = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  const spaceCounts = useMemo(() => countBySpace(visible, me), [visible, me]);
  const all = useMemo(
    () => visible.filter((d) => spaceTabOf(d, me) === space),
    [visible, me, space],
  );
  const counts = useMemo(() => countByKind(all), [all]);
  const filtered = useMemo(() => filterDocs(all, { kind, query }), [all, kind, query]);
  // 置顶（lib/pins，按课题跟账号走）的文档排在最前面，其余保持原来的排序
  const pins = usePins(pid);
  const togglePin = usePinStore((s) => s.toggle);
  const tree = useMemo(
    () => pinnedFirst(buildTree(filtered, sort), pins, (n) => n.doc.id),
    [filtered, sort, pins],
  );
  const flat = useMemo(
    () => pinnedFirst(filtered.slice().sort(compareDocs(sort)), pins, (d) => d.id),
    [filtered, sort, pins],
  );
  const searching = query.trim().length > 0;

  const hrefOf = (id: string) =>
    resourcePageHref(pid, { type: 'doc', id }, previewReturnTo(location));

  const actions: DocActions = {
    onOpen: (doc) => navigate(hrefOf(doc.id)),
    onOpenInNewTab: (doc) => {
      window.open(hrefOf(doc.id), '_blank', 'noopener');
    },
    isPinned: (doc) => pins.includes(doc.id),
    onTogglePin: (doc) => {
      const was = pins.includes(doc.id);
      togglePin(pid, doc.id);
      toast({ title: was ? tr('已取消置顶') : tr('已置顶，排在列表最前面') });
    },
    onRename: setRenaming,
    onMove: setMoving,
    onShare: setSharing,
    onCopyLink: (doc) => {
      const url = absoluteUrl(hrefOf(doc.id));
      navigator.clipboard
        .writeText(url)
        .then(() => toast.success(tr('链接已复制')))
        .catch(() =>
          toast.error(tr('复制失败'), tr('浏览器不允许访问剪贴板，可以从地址栏复制链接。')),
        );
    },
    onArchive: (doc) => {
      update.mutate(
        { id: doc.id, patch: { archived: true } },
        {
          onSuccess: () =>
            toast({
              title: tr('已归档'),
              description: tr('「{value}」可以在“已归档”里找回', {
                value: doc.title || tr('未命名'),
              }),
              tone: 'success',
              action: {
                label: tr('撤销'),
                onClick: () =>
                  update.mutate(
                    { id: doc.id, patch: { archived: false } },
                    { onError: (err) => toast.error(tr('撤销失败'), err.message) },
                  ),
              },
            }),
          onError: (err) => toast.error(tr('归档失败'), err.message),
        },
      );
    },
  };

  const kindTabs = [
    { value: 'all' as const, label: tr('全部'), count: counts.all },
    ...DOC_KINDS.map((k) => ({ value: k, label: DOC_KIND_META[k].label, count: counts[k] })),
  ];

  const empty = docsQuery.isSuccess && all.length === 0;

  const spaceTabs = (
    <Tabs
      value={space}
      onValueChange={(v) => {
        setSpace(v);
        setKind('all');
      }}
      layoutId="docs-space"
      aria-label={tr('空间')}
      className="mb-4"
      items={[
        { value: 'team' as const, label: tr('团队空间'), count: spaceCounts.team },
        { value: 'personal' as const, label: tr('我的空间'), count: spaceCounts.personal },
        { value: 'shared' as const, label: tr('与我共享'), count: spaceCounts.shared },
      ]}
    />
  );

  return (
    <Page width="full" className="max-w-6xl">
      <PageTitle>{tr('文档')}</PageTitle>
      <PageActions>
        <>
          <Button
            variant="ghost"
            leftIcon={<Archive strokeWidth={1.75} aria-hidden />}
            onClick={() => setArchivedOpen(true)}
          >
            {tr('已归档')}
          </Button>
          {canEdit && (
            <Button
              variant="secondary"
              leftIcon={<Upload strokeWidth={1.75} aria-hidden />}
              aria-label={tr('上传文件')}
              onClick={() => importer.setOpen(true)}
            >
              <span className="sr-only sm:not-sr-only">{tr('上传文件')}</span>
            </Button>
          )}
          {canEdit && (
            <NewDocMenu
              loading={creator.pending !== null && !galleryOpen}
              onCreate={creator.createBlank}
              onTemplates={() => setGalleryOpen(true)}
            />
          )}
        </>
      </PageActions>

      <div className="relative min-h-[50dvh]" {...importer.drop.props}>
        {!docsQuery.isPending && !docsQuery.isError && spaceTabs}
        {docsQuery.isPending ? (
          <DocsSkeleton />
        ) : docsQuery.isError ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-danger-soft p-4 text-small text-danger">
            <p>{tr('文档列表没能加载出来：{message}', { message: docsQuery.error.message })}</p>
            <Button size="sm" variant="secondary" onClick={() => void docsQuery.refetch()}>
              {tr('重试')}
            </Button>
          </div>
        ) : empty && space === 'shared' ? (
          <EmptyState
            framed
            icon={Inbox}
            title={tr('还没有人分享文档给你')}
            description={tr('别人把个人空间里的文档分享给你、或你打开过的分享链接，会出现在这里。')}
          />
        ) : empty && space === 'personal' ? (
          <EmptyState
            framed
            icon={Lock}
            title={tr('我的空间还是空的')}
            description={tr('这里的文档只有你能看到，写好后可以分享给别人，或移到团队空间。')}
            action={
              canEdit ? (
                <NewDocMenu
                  loading={creator.pending !== null && !galleryOpen}
                  onCreate={creator.createBlank}
                  onTemplates={() => setGalleryOpen(true)}
                />
              ) : undefined
            }
          />
        ) : empty ? (
          <DocsEmpty
            canEdit={canEdit}
            pending={creator.pending}
            onCreate={creator.createBlank}
            onTemplate={creator.createFromTemplate}
            onGallery={() => setGalleryOpen(true)}
            onUpload={() => importer.setOpen(true)}
          />
        ) : (
          <>
            <ListToolbar
              className="mb-4"
              search={
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr('搜索文档')}
                  aria-label={tr('搜索文档')}
                  leading={<Search strokeWidth={1.75} aria-hidden />}
                />
              }
              filters={
                <>
                  <Tabs
                    value={kind}
                    onValueChange={setKind}
                    items={kindTabs}
                    layoutId="docs-kind"
                    aria-label={tr('按类型筛选')}
                  />
                  <Select
                    aria-label={tr('排序')}
                    value={sort}
                    onChange={(e) => setSort(e.target.value === 'title' ? 'title' : 'updated')}
                    options={SORT_OPTIONS}
                    wrapperClassName="w-32"
                  />
                </>
              }
              activeFilterCount={Number(kind !== 'all') + Number(sort !== 'updated')}
              view={
                <Tabs
                  variant="segmented"
                  value={view}
                  onValueChange={setView}
                  layoutId="docs-view"
                  aria-label={tr('视图')}
                  items={[
                    { value: 'list', label: tr('列表') },
                    { value: 'grid', label: tr('网格') },
                  ]}
                />
              }
            />

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={filtered.length === 0 ? 'none' : view}
                variants={variants.fadeIn}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                {filtered.length === 0 ? (
                  <EmptyState
                    icon={SearchX}
                    title={
                      searching
                        ? tr('没有找到匹配的文档')
                        : tr('还没有{value}{label}', {
                            value: kind === 'latex' ? ' ' : '',
                            label: DOC_KIND_META[kind === 'all' ? 'doc' : kind].label,
                          })
                    }
                    description={
                      searching
                        ? tr('没有标题或内容包含“{query}”的{value}，换个关键词试试。', {
                            query: query.trim(),
                            value: kind === 'all' ? tr('文档') : DOC_KIND_META[kind].label,
                          })
                        : tr('可以用右上角的“新建”创建一份，或者回到全部文档。')
                    }
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setQuery('');
                          setKind('all');
                        }}
                      >
                        {tr('查看全部文档')}
                      </Button>
                    }
                  />
                ) : view === 'list' ? (
                  <DocListView
                    nodes={tree}
                    expandAll={searching}
                    hrefOf={hrefOf}
                    actions={actions}
                    canEdit={canEdit}
                    editorsOf={editorsOf}
                  />
                ) : (
                  <DocGridView
                    docs={flat}
                    hrefOf={hrefOf}
                    actions={actions}
                    canEdit={canEdit}
                    editorsOf={editorsOf}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </>
        )}
        {canEdit && (
          <DropOverlay
            show={importer.drop.dragging}
            label={tr('松开就上传，每个文件会新建一份文档')}
          />
        )}
      </div>

      <ImportDialog
        open={importer.open}
        onOpenChange={importer.setOpen}
        queue={importer.queue}
        hrefOf={hrefOf}
        onFiles={importer.addFiles}
      />
      <TemplateGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onPick={creator.createFromTemplate}
        pendingId={creator.pending}
      />
      <ArchivedDialog
        pid={pid}
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        canEdit={canEdit}
      />
      <RenameDocDialog
        key={`rename-${renaming?.id ?? ''}`}
        pid={pid}
        doc={renaming}
        onClose={() => setRenaming(null)}
      />
      <MoveDocDialog
        key={`move-${moving?.id ?? ''}`}
        pid={pid}
        doc={moving}
        docs={all}
        onClose={() => setMoving(null)}
      />
      <SharePanel
        pid={pid}
        kind="document"
        target={
          sharing
            ? {
                id: sharing.id,
                title: sharing.title,
                href: hrefOf(sharing.id),
                createdBy: sharing.createdBy.kind === 'user' ? sharing.createdBy.id : null,
              }
            : null
        }
        onClose={() => setSharing(null)}
      />
    </Page>
  );
}

function DocsSkeleton() {
  return (
    <div aria-busy="true" aria-label={tr('正在加载文档')}>
      <Skeleton className="mb-4 h-10 w-full max-w-md" />
      <Skeleton className="mb-4 h-8 w-full sm:w-72" />
      <div className="flex flex-col gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <Skeleton className="size-7 shrink-0 rounded-sm" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="hidden h-3 w-24 sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
