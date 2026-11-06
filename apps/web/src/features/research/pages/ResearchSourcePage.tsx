import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Archive,
  BookMarked,
  Download,
  ExternalLink,
  RotateCcw,
} from 'lucide-react';
import type { ResearchSnapshotCoverage, ResearchSource } from '@srh/shared';
import { Page, PageActions, PageTitle } from '@/components/layout/Page';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  RelativeTime,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { ApiRequestError } from '@/lib/api';
import { resolveApiUrl } from '@/lib/api';
import {
  researchApi,
  researchKey,
  useResearchEvents,
  useResearchRecords,
  useResearchSources,
} from '../data';
import { tr } from '@/lib/i18n';

const COVERAGE: Record<ResearchSnapshotCoverage, string> = {
  complete: tr('完整原件'),
  excerpt: tr('仅摘录'),
  external: tr('仅外部链接'),
};
const KIND_LABEL: Record<ResearchSource['kind'], string> = {
  file: tr('项目文件'),
  document: tr('文档'),
  paper: tr('论文'),
  notebook: 'Notebook',
  bibliography: tr('手工书目'),
  url: tr('网址'),
};

export function ResearchSourcePage() {
  const pid = useProjectId();
  const { sourceId = '' } = useParams();
  const writable = canWrite(useMyRole(pid));
  const sources = useResearchSources(pid);
  const records = useResearchRecords(pid);
  const source = sources.data?.find((item) => item.id === sourceId);
  const snapshots = useQuery({
    queryKey: researchKey(pid, 'source', sourceId, 'snapshots'),
    queryFn: ({ signal }) => researchApi.snapshots(pid, sourceId, signal),
    enabled: !!pid && !!sourceId,
  });
  useResearchEvents(pid);

  return (
    <Page width="doc">
      <PageTitle>{source?.title ?? tr('研究资料')}</PageTitle>
      <PageActions>
        <Link
          to={`/p/${pid}/research-sources`}
          className="inline-flex items-center gap-1 text-small text-accent-text hover:underline"
        >
          <ArrowLeft size={16} />
          {tr('返回资料')}
        </Link>
      </PageActions>
      {sources.isPending ? (
        <div role="status" aria-label={tr('正在加载资料')}>
          <Skeleton className="h-24" />
        </div>
      ) : sources.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('资料没有加载出来')}
          description={sources.error.message}
          action={
            <Button variant="secondary" onClick={() => void sources.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : !source ? (
        <EmptyState framed icon={BookMarked} title={tr('这份资料不存在')} />
      ) : (
        <SourceDetail
          key={source.id}
          pid={pid}
          source={source}
          allSources={sources.data}
          writable={writable}
          records={records.data ?? []}
          snapshots={snapshots}
        />
      )}
    </Page>
  );
}

function SourceDetail({
  pid,
  source,
  allSources,
  writable,
  records,
  snapshots,
}: {
  pid: string;
  source: ResearchSource;
  allSources: ResearchSource[];
  writable: boolean;
  records: Awaited<ReturnType<typeof researchApi.records>>;
  snapshots: ReturnType<typeof useQuery<Awaited<ReturnType<typeof researchApi.snapshots>>>>;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    title: source.title,
    citation: source.citation,
    url: source.url ?? '',
    originalSourceId: source.originalSourceId ?? '',
  });
  const [baseVersion, setBaseVersion] = useState(source.version);
  const [coverage, setCoverage] = useState<ResearchSnapshotCoverage>(
    source.kind === 'url'
      ? 'external'
      : ['file', 'paper', 'document', 'notebook'].includes(source.kind)
        ? 'complete'
        : 'excerpt',
  );
  const [snapshotText, setSnapshotText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [snapshotError, setSnapshotError] = useState('');
  const availability = useQuery({
    queryKey: researchKey(pid, 'source', source.id, 'availability'),
    queryFn: ({ signal }) => researchApi.availability(pid, source.id, signal),
  });
  const resourceHref = (() => {
    if (!availability.data?.available || !source.resourceId) return null;
    switch (source.kind) {
      case 'file':
        return resolveApiUrl(`/projects/${pid}/files/${source.resourceId}`);
      case 'document':
        return `/p/${pid}/docs/${source.resourceId}`;
      case 'paper':
        return `/p/${pid}/library/${source.resourceId}`;
      case 'notebook':
        return `/p/${pid}/notebooks/${source.resourceId}`;
      default:
        return null;
    }
  })();
  const related = records.filter((record) => record.sourceIds.includes(source.id));
  const original = allSources.find((item) => item.id === source.originalSourceId);
  const derived = allSources.filter((item) => item.originalSourceId === source.id);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: researchKey(pid) });
  };
  const reload = async () => {
    setPending(true);
    try {
      const latest = (await researchApi.sources(pid)).find((item) => item.id === source.id);
      if (!latest) {
        setError(tr('资料已不可用。'));
        return;
      }
      setDraft({
        title: latest.title,
        citation: latest.citation,
        url: latest.url ?? '',
        originalSourceId: latest.originalSourceId ?? '',
      });
      setBaseVersion(latest.version);
      setError('');
      qc.setQueryData(researchKey(pid, 'sources'), (current: ResearchSource[] | undefined) =>
        current?.map((item) => (item.id === latest.id ? latest : item)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('重读失败，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const save = async (archived?: boolean) => {
    setPending(true);
    setError('');
    try {
      const updated = await researchApi.updateSource(pid, source.id, {
        title: draft.title.trim(),
        citation: draft.citation.trim(),
        url: source.kind === 'url' ? draft.url || null : null,
        originalSourceId: draft.originalSourceId || null,
        ...(archived === undefined ? {} : { archived }),
        baseVersion,
      });
      setBaseVersion(updated.version);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError && cause.status === 409
          ? tr('资料已被他人更新，草稿仍在。请重读当前版本，再保存。')
          : cause instanceof Error
            ? cause.message
            : tr('保存失败，请重试。'),
      );
    } finally {
      setPending(false);
    }
  };
  const createSnapshot = async () => {
    setPending(true);
    setSnapshotError('');
    try {
      await researchApi.createSnapshot(pid, source.id, {
        coverage,
        ...(coverage === 'excerpt' ? { text: snapshotText } : {}),
      });
      setSnapshotText('');
      await refresh();
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : tr('快照没有创建成功，请重试。'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{KIND_LABEL[source.kind]}</Badge>
        {source.archivedAt && <Badge>{tr('已归档')}</Badge>}
        {source.needsReview && <Badge tone="warning">{tr('依据更新待复核')}</Badge>}
        <span className="text-caption text-fg-muted">
          {tr('第 ')}
          {baseVersion}
          {tr(' 版 · ')}
          <RelativeTime iso={source.updatedAt} />
        </span>
      </div>
      <section className="space-y-4" aria-label={tr('资料信息')}>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('标题')}
          <Input
            value={draft.title}
            disabled={!writable}
            maxLength={500}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label className="block space-y-1.5 text-small text-fg">
          {tr('书目或说明')}
          <Textarea
            value={draft.citation}
            disabled={!writable}
            maxLength={4000}
            rows={3}
            onChange={(e) => setDraft({ ...draft, citation: e.target.value })}
          />
        </label>
        {source.kind === 'url' && (
          <label className="block space-y-1.5 text-small text-fg">
            {tr('网址')}
            <Input
              type="url"
              value={draft.url}
              disabled={!writable}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
            <span className="text-caption text-fg-muted">
              {tr('仅保存网址；没有保存网页原件。')}
            </span>
          </label>
        )}
        {source.url && (
          <a
            className="inline-flex items-center gap-1 text-small text-accent-text hover:underline"
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={14} />
            {tr('打开来源网址')}
          </a>
        )}
        <label className="block space-y-1.5 text-small text-fg">
          {tr('原件关联')}
          <Select
            value={draft.originalSourceId}
            disabled={!writable}
            onChange={(e) => setDraft({ ...draft, originalSourceId: e.target.value })}
          >
            <option value="">{tr('无原件关联')}</option>
            {allSources
              .filter((item) => item.id !== source.id && !item.archivedAt)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </Select>
        </label>
        {original && (
          <p className="text-small text-fg-muted">
            {tr('原件：')}
            <Link
              className="text-accent-text hover:underline"
              to={`/p/${pid}/research-sources/${original.id}`}
            >
              {original.title}
            </Link>
          </p>
        )}
        {derived.length > 0 && (
          <div className="text-small text-fg-muted">
            {tr('导入或转写关联：')}
            {derived.map((item) => (
              <Link
                key={item.id}
                className="mr-2 text-accent-text hover:underline"
                to={`/p/${pid}/research-sources/${item.id}`}
              >
                {item.title}
              </Link>
            ))}
          </div>
        )}
        {resourceHref && (
          <a
            className="inline-flex items-center gap-1 text-small text-accent-text hover:underline"
            href={resourceHref}
          >
            <ExternalLink size={14} />
            {tr('打开项目原件')}
          </a>
        )}
        {availability.data?.reason === 'missing' && (
          <p role="status" className="text-small text-warning">
            {tr('原件已缺失或不可访问。')}
            {snapshots.data?.length ? tr('下方历史快照仍可查看。') : tr('目前没有保存的历史快照。')}
          </p>
        )}
        {source.kind === 'notebook' && availability.data?.available && !resourceHref && (
          <p className="text-small text-fg-muted">
            {tr('Notebook 原件仍在项目中，但所属实验入口不可用。')}
          </p>
        )}
        {availability.isError && (
          <p role="alert" className="text-small text-danger">
            {tr('暂时无法检查项目原件是否可用。')}
            <Button size="sm" variant="ghost" onClick={() => void availability.refetch()}>
              {tr('重试')}
            </Button>
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-danger bg-danger-soft p-3 text-small text-danger"
          >
            <p>{error}</p>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RotateCcw size={14} />}
              loading={pending}
              onClick={() => void reload()}
            >
              {tr('放弃草稿并重读')}
            </Button>
          </div>
        )}
        {writable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={pending} onClick={() => void save()}>
              {tr('保存资料')}
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Archive size={16} />}
              loading={pending}
              onClick={() => void save(!source.archivedAt)}
            >
              {source.archivedAt ? tr('取消归档') : tr('归档资料')}
            </Button>
          </div>
        )}
      </section>
      <section className="space-y-3" aria-label={tr('资料快照')}>
        <h2 className="text-h2 text-fg">{tr('版本快照')}</h2>
        {snapshots.isPending ? (
          <Skeleton className="h-20" />
        ) : snapshots.isError ? (
          <div role="alert" className="text-small text-danger">
            {tr('快照没有加载出来。')}
            <Button size="sm" variant="ghost" onClick={() => void snapshots.refetch()}>
              {tr('重试')}
            </Button>
          </div>
        ) : snapshots.data?.length ? (
          <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
            {snapshots.data.map((snapshot) => (
              <li key={snapshot.id} className="flex flex-wrap items-start gap-2 p-3 text-small">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-fg">
                    {COVERAGE[snapshot.coverage]} · <RelativeTime iso={snapshot.createdAt} />
                  </div>
                  <div className="mt-1 text-caption text-fg-muted">
                    {tr('快照时来源：{title} · 第 {sourceVersion} 版{value}', {
                      title: snapshot.sourceMetadata.title,
                      sourceVersion: snapshot.sourceVersion,
                      value:
                        snapshot.sourceMetadata.citation &&
                        ` · ${snapshot.sourceMetadata.citation}`,
                    })}
                  </div>
                  {snapshot.sourceMetadata.url && (
                    <a
                      className="mt-1 inline-flex items-center gap-1 text-caption text-accent-text hover:underline"
                      href={snapshot.sourceMetadata.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={12} />
                      {tr('快照时来源网址')}
                    </a>
                  )}
                  <div className="mt-1 break-all text-caption text-fg-muted">
                    {tr('{originalName} · {byteLength} 字节', {
                      originalName: snapshot.originalName,
                      byteLength: snapshot.byteLength,
                    })}
                  </div>
                  {snapshot.text && (
                    <details className="mt-2">
                      <summary className="cursor-pointer">{tr('查看保存的摘录')}</summary>
                      <p className="mt-2 whitespace-pre-wrap text-fg">{snapshot.text}</p>
                    </details>
                  )}
                  <details className="mt-2 text-caption text-fg-muted">
                    <summary className="cursor-pointer">{tr('版本详情')}</summary>
                    <p className="mt-1 break-all font-mono">
                      {tr('快照 {id} · 第 {version} 版{value}', {
                        id: snapshot.id,
                        version: snapshot.version,
                        value: snapshot.sha256 && ` · SHA-256 ${snapshot.sha256}`,
                      })}
                    </p>
                  </details>
                </div>
                {snapshot.coverage === 'external' ? (
                  <span className="text-caption text-fg-muted">
                    {tr('仅存来源元数据，无原件下载')}
                  </span>
                ) : (
                  <a
                    className="inline-flex items-center gap-1 text-accent-text hover:underline"
                    href={researchApi.snapshotUrl(pid, snapshot.id)}
                    download
                  >
                    <Download size={14} />
                    {tr('下载历史版本')}
                  </a>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-small text-fg-muted">{tr('还没有快照。')}</p>
        )}
        {writable && !source.archivedAt && (
          <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <p className="text-small font-medium text-fg">{tr('创建固定版本')}</p>
            <Select
              aria-label={tr('快照保存范围')}
              value={coverage}
              onChange={(e) => setCoverage(e.target.value as ResearchSnapshotCoverage)}
            >
              <option value="external">{tr('仅外部链接')}</option>
              {source.kind !== 'url' && <option value="excerpt">{tr('仅摘录')}</option>}
              {['file', 'paper', 'document', 'notebook'].includes(source.kind) && (
                <option value="complete">{tr('完整原件')}</option>
              )}
            </Select>
            {coverage === 'excerpt' && (
              <Textarea
                aria-label={tr('快照摘录原文')}
                value={snapshotText}
                rows={4}
                onChange={(e) => setSnapshotText(e.target.value)}
                placeholder={tr('粘贴此版本要保存的原文')}
              />
            )}
            <p className="text-caption text-fg-muted">
              {coverage === 'complete'
                ? tr('保存当前项目资源的完整内容；后续原件变化不影响此版本。')
                : coverage === 'excerpt'
                  ? tr('只保存填写的文字；不能代表完整原件。')
                  : tr('只保存来源链接与元数据；不会抓取网页。')}
            </p>
            {snapshotError && (
              <p role="alert" className="text-small text-danger">
                {snapshotError}
              </p>
            )}
            <Button variant="secondary" loading={pending} onClick={() => void createSnapshot()}>
              {tr('创建快照')}
            </Button>
          </div>
        )}
      </section>
      <section className="space-y-3" aria-label={tr('引用此资料的研究空间')}>
        <h2 className="text-h2 text-fg">{tr('关联研究空间')}</h2>
        {related.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {related.map((record) => (
              <li key={record.id} className="p-3">
                <Link
                  className="text-small text-accent-text hover:underline"
                  to={`/p/${pid}/research/${record.id}?section=materials`}
                >
                  {record.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-fg-muted">{tr('暂无研究空间关联这份资料。')}</p>
        )}
      </section>
    </div>
  );
}
