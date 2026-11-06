import { useSearchParams } from 'react-router';
import { Skeleton, Tabs, type TabItem } from '@/components/ui';
import { Page, PageHeader } from '@/components/layout/Page';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { usePlansOverview, usePlansRealtime } from '../api';
import { BasisTab } from '../components/BasisTab';
import { ExplorationsTab } from '../components/ExplorationsTab';
import { MemoryTab } from '../components/MemoryTab';
import { OfficialTab } from '../components/OfficialTab';
import { ProposalsTab } from '../components/ProposalsTab';
import { LoadError } from '../components/shared';
import { tr } from '@/lib/i18n';

type TabKey = 'official' | 'explorations' | 'proposals' | 'basis' | 'memory';
const TAB_KEYS: TabKey[] = ['official', 'explorations', 'proposals', 'basis', 'memory'];
const ID = 'plans';

/** 方案与依据：正式方案 / 探索副本 / 提案 / 团队依据 / 我的记忆。tab 与选中的提案写在 URL 里。 */
export function PlansPage() {
  const pid = useProjectId();
  const role = useMyRole(pid);
  const me = useMeUser();
  const query = usePlansOverview(pid);
  usePlansRealtime(pid);
  const [params, setParams] = useSearchParams();

  const raw = params.get('tab');
  const tab: TabKey = TAB_KEYS.includes(raw as TabKey) ? (raw as TabKey) : 'official';
  const proposalId = params.get('proposal');
  const setTab = (next: TabKey) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (next === 'official') n.delete('tab');
        else n.set('tab', next);
        n.delete('proposal');
        return n;
      },
      { replace: true },
    );
  const setProposal = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', 'proposals');
      if (id) n.set('proposal', id);
      else n.delete('proposal');
      return n;
    });

  const data = query.data;
  const writable = canWrite(role);
  const manage = data?.canManage ?? false;
  const pending = data?.proposals.filter((p) => p.status === 'submitted').length ?? 0;
  const review = data?.basis.filter((b) => b.status === 'needs_review').length ?? 0;

  const items: TabItem<TabKey>[] = [
    { value: 'official', label: tr('正式方案') },
    { value: 'explorations', label: tr('探索副本') },
    { value: 'proposals', label: tr('提案'), ...(pending ? { count: pending } : {}) },
    { value: 'basis', label: tr('团队依据'), ...(review ? { count: review } : {}) },
    { value: 'memory', label: tr('我的记忆') },
  ];

  return (
    <Page width="doc">
      <PageHeader
        title={tr('方案与依据')}
        description={tr('正式方案只能通过提案修改；团队依据记录每个判断的来源、条件和证据。')}
      />
      <Tabs
        className="mb-4"
        aria-label={tr('方案与依据')}
        idPrefix={ID}
        layoutId="plans-tabs"
        value={tab}
        onValueChange={setTab}
        items={items}
      />
      <div
        role="tabpanel"
        id={`${ID}-panel-${tab}`}
        aria-labelledby={`${ID}-tab-${tab}`}
        className="min-w-0"
      >
        {tab === 'memory' ? (
          <MemoryTab pid={pid} meId={me?.id} canManage={manage} canWrite={writable} />
        ) : query.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label={tr('正在加载方案')}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-4">
                <Skeleton className="mb-2 h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <LoadError
            message={tr('方案没能加载出来：{message}', { message: query.error.message })}
            onRetry={() => void query.refetch()}
          />
        ) : tab === 'official' ? (
          <OfficialTab pid={pid} official={query.data.official} canManage={manage} />
        ) : tab === 'explorations' ? (
          <ExplorationsTab
            pid={pid}
            official={query.data.official}
            explorations={query.data.explorations}
            meId={me?.id}
            canWrite={writable}
          />
        ) : tab === 'proposals' ? (
          <ProposalsTab
            pid={pid}
            proposals={query.data.proposals}
            official={query.data.official}
            canManage={manage}
            meId={me?.id}
            openId={proposalId}
            onOpenIdChange={setProposal}
          />
        ) : (
          <BasisTab pid={pid} basis={query.data.basis} canManage={manage} />
        )}
      </div>
    </Page>
  );
}
