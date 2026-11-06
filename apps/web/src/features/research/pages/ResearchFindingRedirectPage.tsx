import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Page, PageTitle } from '@/components/layout/Page';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { useProjectId } from '@/lib/project';
import { researchApi, researchKey } from '../data';
import { tr } from '@/lib/i18n';

export function ResearchFindingRedirectPage() {
  const pid = useProjectId();
  const { findingId = '' } = useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: researchKey(pid, 'finding', findingId),
    queryFn: ({ signal }) => researchApi.finding(pid, findingId, signal),
    enabled: !!pid && !!findingId,
  });
  useEffect(() => {
    if (query.data)
      navigate(`/p/${pid}/research/${query.data.recordId}?section=findings`, { replace: true });
  }, [query.data, navigate, pid]);
  return (
    <Page>
      <PageTitle>{tr('研究结论')}</PageTitle>
      {query.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('结论没有加载出来')}
          description={query.error.message}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : (
        <div role="status" aria-label={tr('正在打开研究结论')}>
          <Skeleton className="h-20" />
        </div>
      )}
    </Page>
  );
}
