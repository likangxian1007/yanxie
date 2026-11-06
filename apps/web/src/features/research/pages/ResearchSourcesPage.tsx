import { lazy, Suspense, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, BookMarked, Plus, Search, Upload } from 'lucide-react';
import type { ResearchSourceKind, ResearchResourceRef } from '@srh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Page, PageActions, PageTitle } from '@/components/layout/Page';
import { ListToolbar } from '@/components/layout/ListToolbar';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RelativeTime,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { researchApi, researchKey, useResearchEvents, useResearchSources } from '../data';
import { ResourcePicker } from '../components/ResourcePicker';
import { tr } from '@/lib/i18n';

const ImportResearchFile = lazy(() =>
  import('../components/ImportResearchFile').then((module) => ({
    default: module.ImportResearchFile,
  })),
);

const KINDS: Record<ResearchSourceKind, string> = {
  file: tr('项目文件'),
  document: tr('文档'),
  paper: tr('论文'),
  notebook: 'Notebook',
  bibliography: tr('手工书目'),
  url: tr('网址'),
};

export function ResearchSourcesPage() {
  const pid = useProjectId();
  const writable = canWrite(useMyRole(pid));
  const query = useResearchSources(pid);
  useResearchEvents(pid);
  useListStateScope('research-sources');
  const [search, setSearch] = useListQueryState('q', '');
  const [kind, setKind] = useListQueryState('kind', 'all');
  const [archive, setArchive] = useListQueryState('archive', 'active');
  const [sort, setSort] = useListQueryState('sort', 'newest');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const rows = useMemo(
    () =>
      (query.data ?? [])
        .filter(
          (source) =>
            (source.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ||
              source.citation.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) &&
            (kind === 'all' || source.kind === kind) &&
            (archive === 'all' || (archive === 'archived') === !!source.archivedAt),
        )
        .sort((a, b) =>
          sort === 'title'
            ? a.title.localeCompare(b.title, 'zh-CN')
            : sort === 'oldest'
              ? a.updatedAt.localeCompare(b.updatedAt)
              : b.updatedAt.localeCompare(a.updatedAt),
        ),
    [query.data, search, kind, archive, sort],
  );

  return (
    <Page width="full">
      <PageTitle>{tr('研究资料')}</PageTitle>
      <PageActions>
        {writable && (
          <>
            <Button
              variant="secondary"
              leftIcon={<Upload size={16} />}
              onClick={() => setImporting(true)}
            >
              {tr('导入文件')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Plus size={16} />}
              onClick={() => setCreating(true)}
            >
              {tr('添加资料')}
            </Button>
          </>
        )}
      </PageActions>
      {(query.data?.length ?? 0) > 0 && (
        <ListToolbar
          className="mb-4"
          search={
            <Input
              type="search"
              aria-label={tr('搜索研究资料')}
              placeholder={tr('搜索标题或书目')}
              leading={<Search size={16} />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          }
          filters={
            <>
              <Select
                aria-label={tr('按资料类型筛选')}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                wrapperClassName="w-auto min-w-32"
              >
                <option value="all">{tr('全部类型')}</option>
                {Object.entries(KINDS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={tr('按归档状态筛选')}
                value={archive}
                onChange={(e) => setArchive(e.target.value)}
                wrapperClassName="w-auto min-w-28"
              >
                <option value="active">{tr('未归档')}</option>
                <option value="archived">{tr('已归档')}</option>
                <option value="all">{tr('全部资料')}</option>
              </Select>
              <Select
                aria-label={tr('排序')}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                wrapperClassName="w-auto min-w-28"
              >
                <option value="newest">{tr('最近更新')}</option>
                <option value="oldest">{tr('最早更新')}</option>
                <option value="title">{tr('按标题')}</option>
              </Select>
            </>
          }
          activeFilterCount={Number(kind !== 'all') + Number(archive !== 'active')}
        />
      )}
      {query.isPending ? (
        <div role="status" aria-label={tr('正在加载研究资料')} className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : query.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('研究资料没有加载出来')}
          description={query.error.message}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : query.data.length === 0 ? (
        <EmptyState
          framed
          icon={BookMarked}
          title={tr('还没有研究资料')}
          action={
            writable ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {tr('添加资料')}
              </Button>
            ) : undefined
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Search}
          title={tr('没有符合条件的资料')}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch('');
                setKind('all');
                setArchive('all');
              }}
            >
              {tr('清除筛选')}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {rows.map((source) => (
            <li key={source.id} data-list-item={source.id}>
              <Link
                to={`/p/${pid}/research-sources/${source.id}`}
                className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-subtle"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium text-fg">{source.title}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-caption text-fg-muted">
                    <span>{KINDS[source.kind]}</span>
                    <span>·</span>
                    <RelativeTime iso={source.updatedAt} />
                    {source.citation && (
                      <span className="max-w-64 truncate">· {source.citation}</span>
                    )}
                  </div>
                </div>
                {source.archivedAt && <Badge>{tr('已归档')}</Badge>}
                {source.needsReview && <Badge tone="warning">{tr('待复核')}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NewSourceDialog open={creating} onOpenChange={setCreating} pid={pid} />
      {importing && (
        <Suspense
          fallback={
            <p role="status" className="text-small text-fg-muted">
              {tr('正在打开导入器…')}
            </p>
          }
        >
          <ImportResearchFile open onOpenChange={setImporting} pid={pid} />
        </Suspense>
      )}
    </Page>
  );
}

export function NewSourceDialog({
  open,
  onOpenChange,
  pid,
  recordId,
  originalSourceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: string;
  recordId?: string;
  originalSourceId?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sources = useResearchSources(pid);
  const [kind, setKind] = useState<ResearchSourceKind>('bibliography');
  const [resource, setResource] = useState<ResearchResourceRef | null>(null);
  const [title, setTitle] = useState('');
  const [citation, setCitation] = useState('');
  const [url, setUrl] = useState('');
  const [originalId, setOriginalId] = useState(originalSourceId ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError(tr('请填写资料标题。'));
      return;
    }
    if (kind === 'url' && !/^https?:\/\//u.test(url)) {
      setError(tr('请填写完整的 http 或 https 网址。'));
      return;
    }
    if (!['url', 'bibliography'].includes(kind) && (!resource || !resource.id)) {
      setError(tr('请选择已有的项目资源。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      const source = await (recordId
        ? researchApi.createSourceForRecord(pid, recordId, {
            recordId,
            kind,
            resourceId: resource?.id ?? null,
            title: title.trim(),
            citation: citation.trim(),
            url: kind === 'url' ? url : null,
            originalSourceId: originalId || null,
          })
        : researchApi.createSource(pid, {
            recordId: recordId ?? null,
            kind,
            resourceId: resource?.id ?? null,
            title: title.trim(),
            citation: citation.trim(),
            url: kind === 'url' ? url : null,
            originalSourceId: originalId || null,
          }));
      await qc.invalidateQueries({ queryKey: researchKey(pid) });
      onOpenChange(false);
      navigate(`/p/${pid}/research-sources/${source.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('添加失败，请重试。'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('添加研究资料')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button variant="primary" type="submit" form="research-new-source" loading={pending}>
            {tr('添加资料')}
          </Button>
        </>
      }
    >
      <form id="research-new-source" className="space-y-4" onSubmit={submit}>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('资料类型')}
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ResearchSourceKind);
              setResource(null);
            }}
          >
            {Object.entries(KINDS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        {!['url', 'bibliography'].includes(kind) && (
          <div className="space-y-1.5 text-small text-fg">
            <span>{tr('项目资源')}</span>
            <ResourcePicker
              pid={pid}
              fixedKind={kind as ResearchResourceRef['kind']}
              value={resource}
              onChange={setResource}
              label={tr('项目资源')}
            />
          </div>
        )}
        <label className="block space-y-1.5 text-small text-fg">
          {tr('标题')}
          <Input value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('书目或说明')}
          <Textarea
            value={citation}
            maxLength={4000}
            rows={2}
            onChange={(e) => setCitation(e.target.value)}
          />
        </label>
        {kind === 'url' && (
          <label className="block space-y-1.5 text-small text-fg">
            {tr('网址')}
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
            <span className="text-caption text-fg-muted">
              {tr('添加网址只保存链接，不会保存网页原件。')}
            </span>
          </label>
        )}
        {!originalSourceId && (
          <label className="block space-y-1.5 text-small text-fg">
            {tr('原件来源（可选）')}
            <Select value={originalId} onChange={(e) => setOriginalId(e.target.value)}>
              <option value="">{tr('无关联原件')}</option>
              {(sources.data ?? [])
                .filter((source) => !source.archivedAt)
                .map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.title}
                  </option>
                ))}
            </Select>
          </label>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
