import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { ArrowUpRight, FileQuestion, LockKeyhole, RefreshCw } from 'lucide-react';
import type { DocumentMeta, Paper, Report, Review } from '@srh/shared';
import { Button, EmptyState, RelativeTime } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import {
  RESOURCE_LABEL,
  previewReturnTo,
  resourcePageHref,
  type ResourcePreview as Preview,
} from './links';
import { tr } from '@/lib/i18n';

type Metadata = {
  title: string;
  excerpt: string;
  updatedAt: string;
  status: string;
  archived?: boolean;
  error?: string | null;
  facts?: [string, string][];
};
const STATUS: Record<string, string> = {
  planned: tr('计划中'),
  running: tr('进行中'),
  done: tr('已完成'),
  failed: tr('失败'),
  abandoned: tr('已放弃'),
  open: tr('审阅中'),
  approved: tr('已通过'),
  changes_requested: tr('要求修改'),
  closed: tr('已关闭'),
  draft: tr('草稿'),
  generating: tr('生成中'),
  final: tr('已定稿'),
  pending: tr('待解析'),
  queued: tr('排队中'),
  parsing: tr('解析中'),
  ready: tr('已就绪'),
  error: tr('解析失败'),
};

async function fetchMetadata(
  projectId: string,
  resource: Preview,
  signal: AbortSignal,
): Promise<Metadata> {
  const root = `/projects/${encodeURIComponent(projectId)}`;
  const id = encodeURIComponent(resource.id);
  switch (resource.type) {
    case 'doc': {
      const d = await api.get<DocumentMeta>(`${root}/docs/${id}`, { signal });
      return {
        title: d.title,
        excerpt: d.excerpt,
        updatedAt: d.updatedAt,
        status: d.archivedAt ? tr('已归档') : tr('可阅读'),
        archived: Boolean(d.archivedAt),
        facts: [
          [
            tr('类型'),
            { doc: tr('文档'), sheet: tr('表格'), slides: tr('演示'), latex: 'LaTeX' }[d.kind],
          ],
        ],
      };
    }
    case 'paper': {
      const p = await api.get<Paper>(`${root}/library/papers/${id}`, { signal });
      return {
        title: p.title,
        excerpt: p.abstract ?? p.note,
        updatedAt: p.updatedAt,
        status: STATUS[p.status] ?? p.stage ?? tr('待处理'),
        archived: Boolean(p.archivedAt),
        error: p.error,
        facts: [
          [tr('年份'), p.year?.toString() ?? tr('未填写')],
          [tr('发表'), p.venue ?? tr('未填写')],
          [tr('引用键'), p.citekey],
        ],
      };
    }
    case 'experiment':
      throw new Error(tr('内容已移除'));
    case 'review': {
      const r = await api.get<Review>(`${root}/reviews/${id}`, { signal });
      return {
        title: r.title,
        excerpt: r.summary,
        updatedAt: r.updatedAt,
        status: STATUS[r.status] ?? r.status,
        facts: [
          [tr('审阅人数'), String(r.reviewers.length)],
          [tr('评论'), String(r.commentCount)],
        ],
      };
    }
    case 'report': {
      const r = await api.get<Report>(`${root}/reports/${id}`, { signal });
      return {
        title: r.title,
        excerpt: r.content,
        updatedAt: r.updatedAt,
        status: STATUS[r.status] ?? r.status,
        error: r.error,
        facts: [[tr('周期'), `${r.periodStart.slice(0, 10)} — ${r.periodEnd.slice(0, 10)}`]],
      };
    }
  }
}

/** 只读取元信息，不加载协同编辑器、PDF 或正文渲染依赖。由父面板仅在可见时挂载。 */
export function ResourcePreview({ projectId, resource }: { projectId: string; resource: Preview }) {
  const location = useLocation();
  const qc = useQueryClient();
  const queryKey = ['p', projectId, 'resource-preview', resource.type, resource.id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchMetadata(projectId, resource, signal),
    enabled: Boolean(projectId) && resource.type !== 'experiment',
    retry: false,
    staleTime: 0,
  });
  useProjectEvent(projectId, (event) => {
    const prefix = resource.type === 'doc' ? 'document' : resource.type;
    if (
      event.type.startsWith(`${prefix}.`) &&
      'id' in event.payload &&
      event.payload.id === resource.id
    )
      void qc.invalidateQueries({ queryKey });
  });
  if (resource.type === 'experiment')
    return (
      <div className="p-5">
        <EmptyState
          icon={FileQuestion}
          title={tr('内容已移除')}
          description={tr('实验功能已移除，请在研究空间继续研究。')}
        />
        <Link className="text-accent underline" to={`/p/${projectId}/research`}>
          {tr('打开研究空间')}
        </Link>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" className="p-6 text-small text-fg-muted">
        {tr('正在加载预览…')}
      </p>
    );
  if (query.isError) {
    const status = query.error instanceof ApiRequestError ? query.error.status : 0;
    return (
      <EmptyState
        icon={status === 401 || status === 403 ? LockKeyhole : FileQuestion}
        title={
          status === 401
            ? tr('请重新登录后查看')
            : status === 403
              ? tr('没有查看权限')
              : status === 404
                ? tr('资源已删除或不可见')
                : tr('预览加载失败')
        }
        action={
          status !== 404 && status !== 403 && status !== 401 ? (
            <Button variant="secondary" onClick={() => void query.refetch()}>
              <RefreshCw size={14} aria-hidden />
              {tr('重试')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  const data = query.data;
  const returnTo = previewReturnTo(location);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <p className="mb-2 text-caption text-fg-subtle">{RESOURCE_LABEL[resource.type]}</p>
        <h2 className="text-h2 break-words text-fg">{data.title || tr('未命名')}</h2>
        <dl className="my-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-small">
          <dt className="text-fg-subtle">{tr('状态')}</dt>
          <dd className="text-fg">{data.archived ? tr('已归档') : data.status}</dd>
          <dt className="text-fg-subtle">{tr('更新')}</dt>
          <dd className="text-fg-muted">
            <RelativeTime iso={data.updatedAt} />
          </dd>
          {data.facts?.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-subtle">{label}</dt>
              <dd className="break-words text-fg-muted">{value}</dd>
            </div>
          ))}
        </dl>
        {data.error && (
          <p role="alert" className="mb-4 rounded-md bg-danger-soft p-3 text-small text-danger">
            {data.error}
          </p>
        )}
        {data.excerpt && (
          <p className="line-clamp-[16] whitespace-pre-wrap text-small break-words text-fg-muted">
            {data.excerpt.slice(0, 4000)}
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-4">
        <Link
          to={resourcePageHref(projectId, resource, returnTo)}
          state={{ returnTo }}
          className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-small text-fg hover:bg-subtle"
        >
          {tr('打开完整页面')}
          <ArrowUpRight size={16} aria-hidden />
        </Link>
      </div>
    </div>
  );
}
