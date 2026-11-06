import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { ResearchItem } from '@srh/shared';
import { AlertTriangle } from 'lucide-react';
import { Page, PageTitle } from '@/components/layout/Page';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useProjectId } from '@/lib/project';
import { tr } from '@/lib/i18n';

/** 产出与汇报中的稳定条目链接，解析后落到同一研究空间。 */
export function ResearchItemRedirectPage() {
  const pid = useProjectId();
  const { itemId = '' } = useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['research-item-link', pid, itemId],
    queryFn: ({ signal }) =>
      api.get<ResearchItem>(`/projects/${pid}/research/items/${itemId}`, { signal }),
    enabled: !!pid && !!itemId,
  });
  useEffect(() => {
    if (query.data)
      navigate(`/p/${pid}/research/${query.data.recordId}?item=${encodeURIComponent(itemId)}`, {
        replace: true,
      });
  }, [itemId, navigate, pid, query.data]);
  return (
    <Page>
      <PageTitle>{tr('研究内容')}</PageTitle>
      {query.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('内容没有加载出来')}
          description={query.error.message}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : (
        <div role="status" aria-label={tr('正在打开研究内容')}>
          <Skeleton className="h-20" />
        </div>
      )}
    </Page>
  );
}
