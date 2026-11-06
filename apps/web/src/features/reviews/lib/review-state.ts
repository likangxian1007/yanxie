import type {
  Review,
  ReviewComment,
  ReviewParticipant,
  ReviewStatus,
  ReviewVerdict,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 审阅的纯逻辑：列表 Tabs 过滤、结论汇总、状态推导、评论排序。
 */

export type ReviewTab = 'mine' | 'requested' | 'all' | 'ended';

export const REVIEW_TABS: { value: ReviewTab; label: string }[] = [
  { value: 'mine', label: tr('待我审阅') },
  { value: 'requested', label: tr('我发起的') },
  { value: 'all', label: tr('全部') },
  { value: 'ended', label: tr('已结束') },
];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  open: tr('审阅中'),
  approved: tr('已通过'),
  changes_requested: tr('要求修改'),
  closed: tr('已关闭'),
};

export const REVIEW_STATUS_TONE: Record<ReviewStatus, 'accent' | 'success' | 'danger' | 'neutral'> =
  {
    open: 'accent',
    approved: 'success',
    changes_requested: 'danger',
    closed: 'neutral',
  };

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pending: tr('待审阅'),
  lgtm: tr('已批准（LGTM）'),
  changes_requested: tr('要求修改'),
  commented: tr('已评论'),
};

/** 时间线上的结论事件：“张三 批准了（LGTM）” */
export const VERDICT_EVENT: Record<Exclude<ReviewVerdict, 'pending'>, string> = {
  lgtm: tr('批准了（LGTM）'),
  changes_requested: tr('要求修改'),
  commented: tr('发表了审阅意见'),
};

export function isEnded(review: Pick<Review, 'status'>): boolean {
  return review.status === 'closed' || review.status === 'approved';
}

export function isRequestedBy(review: Pick<Review, 'requestedBy'>, userId: string | null): boolean {
  return Boolean(userId) && review.requestedBy.kind === 'user' && review.requestedBy.id === userId;
}

export function reviewerOf(
  review: Pick<Review, 'reviewers'>,
  userId: string | null,
): ReviewParticipant | undefined {
  if (!userId) return undefined;
  return review.reviewers.find((r) => r.userId === userId);
}

/** 等我给结论：我是审阅人、还没批准也没要求修改、审阅没结束 */
export function isAwaitingMe(review: Review, userId: string | null): boolean {
  if (isEnded(review)) return false;
  const me = reviewerOf(review, userId);
  return me?.verdict === 'pending' || me?.verdict === 'commented';
}

export function matchesTab(review: Review, tab: ReviewTab, userId: string | null): boolean {
  switch (tab) {
    case 'mine':
      return isAwaitingMe(review, userId);
    case 'requested':
      return isRequestedBy(review, userId);
    case 'ended':
      return isEnded(review);
    case 'all':
      return true;
  }
}

/** 按 Tab 过滤，新的在前 */
export function filterReviews(reviews: Review[], tab: ReviewTab, userId: string | null): Review[] {
  return reviews
    .filter((r) => matchesTab(r, tab, userId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function reviewTabCounts(
  reviews: Review[],
  userId: string | null,
): Record<ReviewTab, number> {
  const counts: Record<ReviewTab, number> = { mine: 0, requested: 0, all: 0, ended: 0 };
  for (const r of reviews) {
    for (const tab of ['mine', 'requested', 'all', 'ended'] as const) {
      if (matchesTab(r, tab, userId)) counts[tab] += 1;
    }
  }
  return counts;
}

export interface VerdictSummary {
  total: number;
  lgtm: number;
  changesRequested: number;
  commented: number;
  pending: number;
  /** 至少一位审阅人且全部 LGTM */
  allLgtm: boolean;
}

export function summarizeVerdicts(reviewers: Pick<ReviewParticipant, 'verdict'>[]): VerdictSummary {
  const s = { total: reviewers.length, lgtm: 0, changesRequested: 0, commented: 0, pending: 0 };
  for (const r of reviewers) {
    if (r.verdict === 'lgtm') s.lgtm += 1;
    else if (r.verdict === 'changes_requested') s.changesRequested += 1;
    else if (r.verdict === 'commented') s.commented += 1;
    else s.pending += 1;
  }
  return { ...s, allLgtm: s.total > 0 && s.lgtm === s.total };
}

/**
 * 与服务端规则一致的状态推导（API.md §2.10）：
 * 已关闭 → closed；任一要求修改 → changes_requested；全部 LGTM → approved；否则 open。
 */
export function deriveReviewStatus(
  reviewers: Pick<ReviewParticipant, 'verdict'>[],
  closed = false,
): ReviewStatus {
  if (closed) return 'closed';
  const s = summarizeVerdicts(reviewers);
  if (s.changesRequested > 0) return 'changes_requested';
  if (s.allLgtm) return 'approved';
  return 'open';
}

/** 一句话进度：“2/3 已批准 · 1 人要求修改” */
export function verdictProgressText(reviewers: Pick<ReviewParticipant, 'verdict'>[]): string {
  const s = summarizeVerdicts(reviewers);
  const parts = [tr('{lgtm}/{total} 已批准', { lgtm: s.lgtm, total: s.total })];
  if (s.changesRequested > 0)
    parts.push(tr('{changesRequested} 人要求修改', { changesRequested: s.changesRequested }));
  return parts.join(' · ');
}

/** 全部 LGTM 横幅的说明：只有一位审阅人时不说「都」 */
export function approvedSummaryText(reviewerCount: number): string {
  return reviewerCount <= 1
    ? tr('审阅人已批准，可以继续推进。')
    : tr('{reviewerCount} 位审阅人都已批准，可以继续推进。', { reviewerCount });
}

/** 评论从旧到新 */
export function sortComments(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** 评论的引用原文（anchor.quote） */
export function quoteOf(comment: Pick<ReviewComment, 'anchor'>): string | null {
  const q = comment.anchor?.['quote'];
  return typeof q === 'string' && q.trim() ? q : null;
}

/** 把选中的文字整理成引用：合并空白、最多 500 字 */
export function normalizeQuote(text: string, max = 500): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
