import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileText, LinkIcon, Lock } from 'lucide-react';
import { ACCESS_LEVEL_TEXT, type DocumentContent, type ShareResolveResult } from '@srh/shared';
import { BrandMark } from '@/components/layout/BrandMark';
import { Badge, Button, EmptyState, Markdown, Skeleton } from '@/components/ui';
import { api, ApiRequestError, resolveApiUrl } from '@/lib/api';
import { isUnauthorized, useMe } from '@/lib/session';
import { FullPageError, FullPageLoading } from '@/app/pages/FullPageState';
import { resolveShareLink } from './api';
import { tr } from '@/lib/i18n';

/**
 * /s/:token：打开分享链接。
 * - 没登录 → 先登录再回来（「知道链接的人」也需要研协账号）。
 * - 课题成员 → 直接进课题里的完整页面（编辑、评论、版本都在那里）。
 * - 课题外的人 → 独立的阅读页（课题外暂不开放在线编辑）。
 */
export function ShareLinkPage() {
  const { token = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const [result, setResult] = useState<ShareResolveResult | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const started = useRef(false);
  const loggedIn = Boolean(me.data);

  useEffect(() => {
    if (!loggedIn || started.current) return;
    started.current = true;
    resolveShareLink(token)
      .then((r) => {
        if (r.member) {
          const path =
            r.resourceKind === 'document'
              ? `/p/${r.projectId}/docs/${r.resourceId}`
              : `/p/${r.projectId}/library/${r.resourceId}`;
          navigate(path, { replace: true });
        } else setResult(r);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiRequestError
            ? err
            : new ApiRequestError({
                status: 0,
                code: 'network_error',
                message: tr('打不开这个链接'),
              }),
        ),
      );
  }, [loggedIn, token, navigate]);

  if (me.isPending) return <FullPageLoading />;
  if (me.error) {
    if (isUnauthorized(me.error))
      return <Navigate to={`/login?next=${encodeURIComponent(`/s/${token}`)}`} replace />;
    return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  }
  if (error) {
    const gone = error.status === 404;
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4">
        <EmptyState
          icon={gone ? LinkIcon : Lock}
          title={gone ? tr('链接已失效') : tr('没有访问权限')}
          description={error.message}
          action={
            <Button variant="primary" onClick={() => navigate('/')}>
              {tr('回到首页')}
            </Button>
          }
        />
      </div>
    );
  }
  if (!result) return <FullPageLoading />;
  return <ExternalView r={result} />;
}

function ExternalView({ r }: { r: ShareResolveResult }) {
  const doc = useQuery({
    queryKey: ['share-view', r.projectId, r.resourceId],
    queryFn: ({ signal }) =>
      api.get<DocumentContent>(`/projects/${r.projectId}/docs/${r.resourceId}/markdown`, {
        signal,
      }),
    enabled: r.resourceKind === 'document',
  });
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="chrome sticky top-0 z-sticky flex h-(--topbar-h) items-center gap-3 border-b border-line px-4 md:px-6">
        <BrandMark />
        <span className="min-w-0 truncate text-small text-fg-muted">
          {r.ownerName ?? tr('研协用户')}
          {tr(' 分享自「')}
          {r.projectName}
          {tr('」')}
        </span>
        <Badge className="ml-auto shrink-0">{ACCESS_LEVEL_TEXT[r.access]}</Badge>
      </header>
      <main className="mx-auto w-full max-w-(--doc-max) px-4 py-6 md:px-6 md:py-10">
        <h1 className="mb-6 text-h1 text-fg">{r.title || tr('未命名')}</h1>
        {r.resourceKind === 'paper' ? (
          <Button
            variant="primary"
            leftIcon={<FileText strokeWidth={1.75} aria-hidden />}
            onClick={() =>
              window.open(
                resolveApiUrl(`/projects/${r.projectId}/library/papers/${r.resourceId}/pdf`),
                '_blank',
                'noopener',
              )
            }
          >
            {tr('打开 PDF')}
          </Button>
        ) : doc.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : doc.isError ? (
          <p className="text-small text-danger">{doc.error.message}</p>
        ) : doc.data.meta.kind === 'latex' ? (
          <pre className="overflow-x-auto rounded-md border border-line bg-surface p-4 font-mono text-small">
            {doc.data.markdown}
          </pre>
        ) : (
          <Markdown>{doc.data.markdown}</Markdown>
        )}
        <p className="mt-10 text-caption text-fg-subtle">
          {tr('你不是这个课题的成员，这里以只读方式显示。需要协同编辑时，请所有者邀请你加入课题。')}
        </p>
      </main>
    </div>
  );
}
