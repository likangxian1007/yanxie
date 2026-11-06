import { previewReturnTo } from '@/features/resource-preview/links';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { motion } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Download,
  FileCode2,
  LibraryBig,
  Plus,
  Search,
  SearchX,
  ServerCrash,
  TextSearch,
} from 'lucide-react';
import type { Paper } from '@srh/shared';
import { Badge, Button, EmptyState, Input, Select, Skeleton, Tabs, toast } from '@/components/ui';
import { Page, PageHeader } from '@/components/layout/Page';
import { canWrite, useMyRole } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { countBySpace, readSpaceTab, spaceTabOf, useShareEvents } from '@/features/sharing/api';
import { useMotionPreset } from '@/lib/motion';
import { cn } from '@/lib/cn';
import {
  downloadText,
  fetchBibtex,
  searchLibrary,
  useLibraryEvents,
  useLibraryStatus,
  usePapers,
} from '../api';
import { CiteToDocDialog } from '../components/CiteToDocDialog';
import { ImportDialog } from '../components/ImportDialog';
import { PaperCard } from '../components/PaperCard';
import { ParseProgress } from '../components/ParseProgress';
import { STATUS_LABEL, STATUS_TONE, isWorking, shortAuthors } from '../lib/format';
import { isPersonalLibrary, libraryKey, paperHref, type LibraryScope } from '../lib/scope';
import { useLibraryScope } from '../lib/use-library-scope';
import '../library.css';
import { tr } from '@/lib/i18n';

type View = 'cards' | 'table';
type Filter = 'all' | 'ready' | 'working' | 'attention';
const VIEW_KEY = 'srh-library-view';
/** 同屏循环动画 ≤ 3（STYLE §4.3） */
const MAX_ANIMATED = 3;

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

const matchFilter = (p: Paper, f: Filter) =>
  f === 'all' ||
  (f === 'ready' && p.status === 'ready') ||
  (f === 'working' && isWorking(p.status)) ||
  (f === 'attention' && (p.status === 'needs_pdf' || p.status === 'failed'));

export function LibraryPage() {
  const scope = useLibraryScope();
  return <LibraryContents key={JSON.stringify(libraryKey(scope))} pid={scope} />;
}

function LibraryContents({ pid }: { pid: LibraryScope }) {
  const personal = isPersonalLibrary(pid);
  const projectId = personal ? '' : pid;
  const location = useLocation();
  useListStateScope('library');
  const writable = canWrite(useMyRole(projectId));
  const { variants, stagger } = useMotionPreset();
  useLibraryEvents(pid);
  useShareEvents(projectId);
  const me = useMeUser()?.id ?? null;
  const [rawSpace, setSpace] = useListQueryState('space', 'team');
  const space = readSpaceTab(rawSpace);
  const query = usePapers(pid);
  const status = useLibraryStatus(pid);

  const [importing, setImporting] = useState(false);
  const [citing, setCiting] = useState(false);
  const [rawView, setViewState] = useListQueryState('view', readView());
  const view: View = rawView === 'table' ? 'table' : 'cards';
  const [rawFilter, setFilter] = useListQueryState('status', 'all');
  const filter: Filter = ['ready', 'working', 'attention'].includes(rawFilter)
    ? (rawFilter as Filter)
    : 'all';
  const [tagValue, setTag] = useListQueryState('tag', '');
  const tag = tagValue || null;
  const [search, setSearch] = useListQueryState('q', '');
  const [picked, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const setView = (v: View) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // 忽略
    }
  };

  const visible = useMemo(() => query.data ?? [], [query.data]);
  const spaceCounts = useMemo(() => countBySpace(visible, me), [visible, me]);
  const all = useMemo(
    () => (personal ? visible : visible.filter((p) => spaceTabOf(p, me) === space)),
    [visible, personal, me, space],
  );
  const tags = useMemo(() => [...new Set(all.flatMap((p) => p.tags))].sort(), [all]);
  const q = search.trim().toLowerCase();
  const base = useMemo(
    () =>
      all.filter(
        (p) =>
          (!tag || p.tags.includes(tag)) &&
          (!q ||
            [
              p.title,
              p.citekey,
              p.doi ?? '',
              p.arxivId ?? '',
              p.tags.join(' '),
              p.authors.map((a) => a.name).join(' '),
            ]
              .join(' ')
              .toLowerCase()
              .includes(q)),
      ),
    [all, tag, q],
  );
  const list = useMemo(() => base.filter((p) => matchFilter(p, filter)), [base, filter]);
  const counts = useMemo(
    () => ({
      all: base.length,
      ready: base.filter((p) => matchFilter(p, 'ready')).length,
      working: base.filter((p) => matchFilter(p, 'working')).length,
      attention: base.filter((p) => matchFilter(p, 'attention')).length,
    }),
    [base],
  );
  const animated = useMemo(
    () =>
      new Set(
        list
          .filter((p) => isWorking(p.status))
          .slice(0, MAX_ANIMATED)
          .map((p) => p.id),
      ),
    [list],
  );

  // 选中的论文被别人删除 / 归档后自动不算在内
  const selected = useMemo(() => {
    const ids = new Set(all.map((p) => p.id));
    return new Set([...picked].filter((id) => ids.has(id)));
  }, [all, picked]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exportBib = async (ids?: string[]) => {
    setExporting(true);
    try {
      const text = await fetchBibtex(pid, ids);
      downloadText(ids?.length ? `references-${ids.length}.bib` : 'library.bib', text);
    } catch (e) {
      toast({
        tone: 'danger',
        title: tr('导出失败'),
        description: e instanceof Error ? e.message : '',
      });
    } finally {
      setExporting(false);
    }
  };

  const importButton = (
    <Button
      variant="primary"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => setImporting(true)}
    >
      {personal ? tr('导入论文') : tr('导入到个人库')}
    </Button>
  );

  let body;
  if (query.isPending) {
    body = (
      <div className="research-list" role="status" aria-label={tr('正在加载文献库')}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface p-4">
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="mt-2 h-4 w-1/2" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-1.5 h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <EmptyState
        framed
        icon={AlertTriangle}
        title={tr('文献库没有加载出来')}
        description={tr('{message} 可以稍后重试。', { message: query.error.message })}
        action={
          <Button variant="primary" onClick={() => void query.refetch()} loading={query.isFetching}>
            {tr('重试')}
          </Button>
        }
      />
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        framed
        icon={LibraryBig}
        title={personal ? tr('个人库还是空的') : tr('项目库还是空的')}
        action={importButton}
      />
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title={tr('没有符合条件的论文')}
        description={tr('换个关键词或标签试试；下面的全文检索会在论文正文里找。')}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setFilter('all');
              setTag(null);
              setSearch('');
            }}
          >
            {tr('清除筛选')}
          </Button>
        }
      />
    );
  } else if (view === 'table') {
    body = (
      <PaperTable
        papers={list}
        pid={pid}
        selected={selected}
        onToggle={toggle}
        animated={animated}
      />
    );
  } else {
    body = (
      <motion.ul
        variants={stagger()}
        initial="hidden"
        animate="visible"
        className="research-list"
        aria-label={tr('论文列表')}
      >
        {list.map((p) => (
          <motion.li key={p.id} variants={variants.fadeUp} className="research-row min-w-0">
            <PaperCard
              paper={p}
              href={paperHref(pid, p.id, previewReturnTo(location))}
              animate={animated.has(p.id)}
              selected={selected.has(p.id)}
              onToggle={() => toggle(p.id)}
            />
          </motion.li>
        ))}
      </motion.ul>
    );
  }

  return (
    <Page width="full">
      <PageHeader
        title={personal ? tr('个人文献库') : tr('项目文献库')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {all.length > 0 && (
              <Button
                variant="secondary"
                loading={exporting && selected.size === 0}
                leftIcon={<Download strokeWidth={1.75} aria-hidden />}
                onClick={() => void exportBib()}
              >
                {tr('导出全部')}
              </Button>
            )}
            {importButton}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <Badge>{personal ? tr('仅自己可见') : tr('项目成员共享')}</Badge>
        <span>
          {personal
            ? tr('论文和阅读记录保存在你的个人库。')
            : tr('新导入先存入个人库，不会自动向项目公开。')}
        </span>
        {!personal && (
          <Link
            to="/library"
            className="inline-flex min-h-11 items-center text-accent-text hover:underline"
          >
            {tr('打开个人库')}
          </Link>
        )}
      </div>

      {!personal && query.isSuccess && (
        <Tabs
          value={space}
          onValueChange={(v) => {
            setSpace(v);
            setSelected(new Set());
          }}
          layoutId="lib-space"
          aria-label={tr('空间')}
          className="mb-4"
          items={[
            { value: 'team' as const, label: tr('团队文献库'), count: spaceCounts.team },
            {
              value: 'personal' as const,
              label: tr('项目内我的文献'),
              count: spaceCounts.personal,
            },
            { value: 'shared' as const, label: tr('与我共享'), count: spaceCounts.shared },
          ]}
        />
      )}
      {status.data && !status.data.reachable && (
        <div className="mb-4 flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-small">
          <ServerCrash
            className="mt-0.5 size-4 shrink-0 text-warning"
            strokeWidth={1.75}
            aria-hidden
          />
          <p className="text-fg">
            {tr(
              '版面解析服务（{value}）现在连不上，新导入的论文会降级为逐页纯文本：可以检索和问答，但没有章节、公式和图表结构。服务恢复后在论文页点“重新解析”。',
              { value: status.data.parser === 'grobid' ? 'GROBID' : 'MinerU' },
            )}
          </p>
        </div>
      )}

      {all.length > 0 && (
        <div className="mb-4 flex flex-col gap-3">
          <ListToolbar
            className="mb-4"
            search={
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tr('搜索论文')}
                aria-label={tr('搜索论文')}
                leading={<Search strokeWidth={1.75} aria-hidden />}
              />
            }
            filters={
              <>
                <Tabs
                  aria-label={tr('按状态筛选')}
                  layoutId="lib-status"
                  value={filter}
                  onValueChange={setFilter}
                  items={[
                    { value: 'all', label: tr('全部'), count: counts.all },
                    { value: 'ready', label: tr('可阅读'), count: counts.ready },
                    { value: 'working', label: tr('解析中'), count: counts.working },
                    { value: 'attention', label: tr('需处理'), count: counts.attention },
                  ]}
                />{' '}
                {tags.length > 0 && (
                  <Select
                    aria-label={tr('按标签筛选')}
                    value={tag ?? ''}
                    onChange={(e) => setTag(e.target.value || null)}
                    wrapperClassName="w-auto min-w-0 max-w-44"
                  >
                    <option value="">{tr('全部标签')}</option>
                    {tags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                )}
              </>
            }
            activeFilterCount={Number(filter !== 'all') + Number(Boolean(tag))}
            view={
              <Tabs
                variant="segmented"
                aria-label={tr('视图')}
                layoutId="library-view"
                value={view}
                onValueChange={setView}
                items={[
                  { value: 'cards', label: tr('列表') },
                  { value: 'table', label: tr('表格') },
                ]}
              />
            }
          />
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-subtle px-3 py-2">
              <span className="text-small text-fg">
                {tr('已选 {count} 篇', { count: selected.size })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={exporting}
                onClick={() => void exportBib([...selected])}
              >
                {tr('导出 BibTeX')}
              </Button>
              {writable && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<FileCode2 strokeWidth={1.75} aria-hidden />}
                  onClick={() => setCiting(true)}
                >
                  {tr('插入引用')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setSelected(new Set())}
              >
                {tr('取消选择')}
              </Button>
            </div>
          )}
        </div>
      )}

      {body}

      {all.some((p) => p.status === 'ready') && <FullTextHits pid={pid} q={search} />}

      <ImportDialog
        fromProject={projectId || undefined}
        open={importing}
        onOpenChange={setImporting}
      />
      {!personal && (
        <CiteToDocDialog
          pid={projectId}
          paperIds={[...selected]}
          open={citing}
          onOpenChange={setCiting}
        />
      )}
    </Page>
  );
}

/** 搜索框里有内容时，同时在全部论文正文里做段落检索 */
function FullTextHits({ pid, q }: { pid: LibraryScope; q: string }) {
  const location = useLocation();
  const deferred = useDeferredValue(q.trim());
  const [debounced, setDebounced] = useState(deferred);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(deferred), 350);
    return () => clearTimeout(t);
  }, [deferred]);
  const hits = useQuery({
    queryKey: [...libraryKey(pid), 'search', debounced],
    queryFn: ({ signal }) => searchLibrary(pid, debounced, undefined, signal),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
  if (debounced.length < 2) return null;
  return (
    <section className="mt-8" aria-label={tr('全文检索结果')}>
      <h2 className="mb-3 flex items-center gap-2 text-h3">
        <TextSearch className="size-4 text-fg-muted" strokeWidth={1.75} aria-hidden />
        {tr('正文里的段落')}
        {hits.data && (
          <span className="text-small font-normal text-fg-muted">
            {tr('{count} 段', { count: hits.data.length })}
          </span>
        )}
      </h2>
      {hits.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : hits.isError ? (
        <p className="text-small text-danger">{hits.error.message}</p>
      ) : hits.data.length === 0 ? (
        <p className="text-small text-fg-muted">
          {tr('正文里没有找到。论文是英文的话试试英文术语。')}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {hits.data.map((h) => (
            <li key={h.chunkId} className="research-row">
              <Link
                data-list-item={`paper-hit:${h.chunkId}`}
                to={paperHref(pid, h.paperId, previewReturnTo(location), h.seq)}
                className="block rounded-md border border-line bg-surface px-3 py-2.5 transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                  <span className="font-medium text-fg">{h.paperTitle}</span>
                  <span className="lib-cite">
                    {h.citekey}, p.{h.page} ¶{h.para}
                  </span>
                  <span className="truncate text-fg-subtle">{h.sectionPath}</span>
                </div>
                <p className="mt-1 line-clamp-3 text-small leading-relaxed text-fg-muted">
                  {h.text}
                </p>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PaperTable({
  papers,
  pid,
  selected,
  onToggle,
  animated,
}: {
  papers: Paper[];
  pid: LibraryScope;
  selected: Set<string>;
  onToggle: (id: string) => void;
  animated: Set<string>;
}) {
  const location = useLocation();
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-small">
        <thead>
          <tr className="border-b border-line bg-subtle text-left text-caption text-fg-muted">
            <th className="w-8 px-3 py-2">
              <span className="sr-only">{tr('选择')}</span>
            </th>
            <th className="px-3 py-2 font-medium">{tr('标题')}</th>
            <th className="px-3 py-2 font-medium">{tr('作者')}</th>
            <th className="px-3 py-2 font-medium">{tr('年份')}</th>
            <th className="px-3 py-2 font-medium">{tr('引用键')}</th>
            <th className="w-40 px-3 py-2 font-medium">{tr('状态')}</th>
          </tr>
        </thead>
        <tbody>
          {papers.map((p) => (
            <tr
              key={p.id}
              className={cn(
                'research-row border-b border-line last:border-0 hover:bg-subtle',
                selected.has(p.id) && 'bg-accent-soft',
              )}
            >
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={tr('选择《{title}》', { title: p.title })}
                  checked={selected.has(p.id)}
                  onChange={() => onToggle(p.id)}
                  className="size-4 accent-(--accent)"
                />
              </td>
              <td className="max-w-[28rem] px-3 py-2">
                <Link
                  data-list-item={`paper:${p.id}`}
                  to={paperHref(pid, p.id, previewReturnTo(location))}
                  className="line-clamp-2 font-medium text-fg hover:text-accent-text"
                >
                  {p.title}
                </Link>
                {!isPersonalLibrary(pid) && (
                  <ResourcePreviewLink
                    type="paper"
                    id={p.id}
                    aria-label={tr('预览《{title}》', { title: p.title })}
                    className="inline-flex min-h-8 items-center text-caption text-fg-muted hover:text-fg max-md:min-h-11"
                  >
                    {tr('预览')}
                  </ResourcePreviewLink>
                )}
                {p.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-fg-muted">{shortAuthors(p.authors)}</td>
              <td className="px-3 py-2 text-fg-muted tabular-nums">{p.year ?? '—'}</td>
              <td className="px-3 py-2">
                <code className="font-mono text-caption text-fg-muted">{p.citekey}</code>
              </td>
              <td className="px-3 py-2">
                {isWorking(p.status) ? (
                  <ParseProgress paper={p} animate={animated.has(p.id)} />
                ) : (
                  <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
