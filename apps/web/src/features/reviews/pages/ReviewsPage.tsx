import { previewReturnTo, resourcePageHref } from '@/features/resource-preview/links';
import { useLocation } from 'react-router';
import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, BadgeCheck, Inbox, Plus } from 'lucide-react';
import { Button, EmptyState, Input, Skeleton, Tabs } from '@/components/ui';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useMotionPreset } from '@/lib/motion';
import { useMeUser } from '@/lib/session';
import { useReviewEvents, useReviews } from '../api';
import { RequestReviewDialog } from '../components/RequestReviewDialog';
import { ReviewRow } from '../components/ReviewRow';
import { filterReviews, REVIEW_TABS, reviewTabCounts, type ReviewTab } from '../lib/review-state';
import { tr } from '@/lib/i18n';

const EMPTY: Record<ReviewTab, { title: string; description: string }> = {
  mine: {
    title: tr('没有等你审阅的内容'),
    description: tr('有人请你审阅文档、实验或汇报时会出现在这里，也会进“待我处理”。'),
  },
  requested: {
    title: tr('你还没有发起过审阅'),
    description: tr('写完一节论文或跑完一个实验，可以请导师和同学给 LGTM 或修改意见。'),
  },
  all: {
    title: tr('项目里还没有审阅'),
    description: tr('像 PR 一样：选好要审的内容和审阅人，大家在这里评论、给出结论。'),
  },
  ended: {
    title: tr('还没有结束的审阅'),
    description: tr('全部审阅人 LGTM 或发起人关闭后，审阅会移到这里。'),
  },
};

export function ReviewsPage() {
  const pid = useProjectId();
  const location = useLocation();
  useListStateScope('reviews');
  const me = useMeUser();
  const writable = canWrite(useMyRole(pid));
  const { variants, stagger } = useMotionPreset();
  useReviewEvents(pid);
  const query = useReviews(pid);
  const [rawTab, setTab] = useListQueryState('tab', '');
  const picked = REVIEW_TABS.some((t) => t.value === rawTab) ? (rawTab as ReviewTab) : null;
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useListQueryState('q', '');

  const all = useMemo(() => query.data ?? [], [query.data]);
  const counts = useMemo(() => reviewTabCounts(all, me?.id ?? null), [all, me?.id]);
  // 没手动选过时：有等我审的就看“待我审阅”，否则看全部
  const tab: ReviewTab = picked ?? (counts.mine > 0 || all.length === 0 ? 'mine' : 'all');
  const list = useMemo(
    () =>
      filterReviews(all, tab, me?.id ?? null).filter(
        (r) => !search.trim() || r.title.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [all, tab, me?.id, search],
  );

  const newButton = writable ? (
    <Button
      variant="primary"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => setCreating(true)}
    >
      {tr('发起审阅')}
    </Button>
  ) : null;

  let body;
  if (query.isPending) {
    body = (
      <div
        role="status"
        aria-label={tr('正在加载审阅')}
        className="divide-y divide-line rounded-lg border border-line bg-surface"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-7 shrink-0" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="hidden h-6 w-24 sm:block" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <EmptyState
        framed
        icon={AlertTriangle}
        title={tr('审阅列表没有加载出来')}
        description={tr('{message} 可以稍后重试。', { message: query.error.message })}
        action={
          <Button variant="primary" onClick={() => void query.refetch()} loading={query.isFetching}>
            {tr('重试')}
          </Button>
        }
      />
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        framed
        icon={tab === 'mine' ? Inbox : BadgeCheck}
        title={EMPTY[tab].title}
        description={EMPTY[tab].description}
        action={tab === 'requested' || tab === 'all' ? newButton : undefined}
      />
    );
  } else {
    body = (
      <motion.ul
        key={tab}
        variants={stagger()}
        initial="hidden"
        animate="visible"
        aria-label={tr('审阅列表')}
        className="research-list divide-y divide-line"
      >
        {list.map((r) => (
          <motion.li
            key={r.id}
            variants={variants.fadeUp}
            layout="position"
            className="research-row"
          >
            <ReviewRow
              review={r}
              href={resourcePageHref(pid, { type: 'review', id: r.id }, previewReturnTo(location))}
            />
          </motion.li>
        ))}
      </motion.ul>
    );
  }

  return (
    <Page width="feed" className="max-w-4xl">
      <PageTitle>{tr('审阅')}</PageTitle>
      <PageActions>{newButton}</PageActions>
      <ListToolbar
        className="mb-4"
        search={
          <Input
            type="search"
            aria-label={tr('搜索审阅')}
            placeholder={tr('搜索审阅')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        filters={
          <>
            <Tabs
              aria-label={tr('审阅分类')}
              layoutId="review-tabs"
              className="mb-4"
              value={tab}
              onValueChange={setTab}
              items={REVIEW_TABS.map((t) => ({
                value: t.value,
                label: t.label,
                count: counts[t.value],
              }))}
            />
          </>
        }
        activeFilterCount={Number(picked !== null)}
      />
      {body}
      <RequestReviewDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
