import { Navigate, useParams } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { BackLink } from '@/components/layout/BackLink';
import { Page, PageTitle } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { ApiRequestError } from '@/lib/api';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useProposal } from '../api';
import { ProposalPanel } from '../components/ProposalPanel';
import { tr } from '@/lib/i18n';

/**
 * 改动提案的独立页：有审阅时跳到审阅（逐条决定在审阅的「改动」页签里做）；
 * 项目里没有可以请的审阅人时，提案没有审阅，就在这里直接处理。
 */
export function ProposalPage() {
  const pid = useProjectId();
  const { proposalId = '' } = useParams();
  const role = useMyRole(pid);
  const q = useProposal(pid, proposalId);
  const back = <BackLink to={projectPath(pid, 'reviews')}>{tr('全部审阅')}</BackLink>;

  if (q.data?.reviewId) {
    return <Navigate replace to={projectPath(pid, `reviews/${q.data.reviewId}`)} />;
  }
  return (
    <Page width="full" className="max-w-4xl">
      <div className="mb-4">{back}</div>
      {q.isPending ? (
        <div role="status" aria-label={tr('正在加载改动提案')} className="flex flex-col gap-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-28" />
        </div>
      ) : q.isError ? (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('改动提案没有加载出来')}
          description={q.error instanceof ApiRequestError ? q.error.message : tr('可以稍后重试。')}
          action={
            <Button variant="primary" onClick={() => void q.refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : (
        <>
          <PageTitle>{q.data.title}</PageTitle>
          <ProposalPanel
            pid={pid}
            proposalId={proposalId}
            writable={canWrite(role)}
            isReviewer={false}
          />
        </>
      )}
    </Page>
  );
}
