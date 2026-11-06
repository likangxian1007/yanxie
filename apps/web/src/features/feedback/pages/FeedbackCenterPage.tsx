import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { Page, PageHeader } from '@/components/layout/Page';
import { Tabs } from '@/components/ui';
import { useMe } from '@/lib/session';
import { useChangelog } from '../api';
import { ChangelogTab, latestPublished, readChangelogSeen } from '../components/ChangelogTab';
import { IdeasTab } from '../components/IdeasTab';
import { TicketsTab } from '../components/TicketsTab';
import { FEEDBACK_COPY } from '../copy';

type CenterTab = 'tickets' | 'ideas' | 'changelog';
const TABS: CenterTab[] = ['tickets', 'ideas', 'changelog'];

const subscribeSeen = (cb: () => void) => {
  window.addEventListener('srh:changelog-seen', cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener('srh:changelog-seen', cb);
    window.removeEventListener('storage', cb);
  };
};

/** 有没有没看过的已发布更新。 */
export function useChangelogUnseen(): boolean {
  const seen = useSyncExternalStore(subscribeSeen, readChangelogSeen, () => '');
  const latest = latestPublished(useChangelog().data);
  return !!latest && latest > seen;
}

export function FeedbackCenterPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as CenterTab | null;
  const tab: CenterTab = raw && TABS.includes(raw) ? raw : 'tickets';
  const isAdmin = useMe().data?.user.isAdmin === true;
  const unseen = useChangelogUnseen();

  return (
    <Page width="full" className="max-w-6xl">
      <PageHeader title={FEEDBACK_COPY.center} />
      <Tabs<CenterTab>
        layoutId="feedback-center-tab"
        aria-label={FEEDBACK_COPY.center}
        className="mb-5"
        value={tab}
        onValueChange={(v) => setParams(v === 'tickets' ? {} : { tab: v }, { replace: true })}
        items={[
          { value: 'tickets', label: FEEDBACK_COPY.tabs.tickets },
          { value: 'ideas', label: FEEDBACK_COPY.tabs.ideas },
          {
            value: 'changelog',
            label: (
              <span className="relative inline-flex items-center">
                {FEEDBACK_COPY.tabs.changelog}
                {unseen && tab !== 'changelog' && (
                  <span
                    aria-label={FEEDBACK_COPY.changelog.newDot}
                    className="ml-1.5 size-1.5 rounded-full bg-danger-solid"
                  />
                )}
              </span>
            ),
          },
        ]}
      />
      {tab === 'tickets' && <TicketsTab isAdmin={isAdmin} />}
      {tab === 'ideas' && <IdeasTab />}
      {tab === 'changelog' && <ChangelogTab isAdmin={isAdmin} />}
    </Page>
  );
}
