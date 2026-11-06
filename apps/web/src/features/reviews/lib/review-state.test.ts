import { describe, expect, it } from 'vitest';
import type { Review, ReviewComment } from '@srh/shared';
import {
  approvedSummaryText,
  deriveReviewStatus,
  filterReviews,
  isAwaitingMe,
  normalizeQuote,
  quoteOf,
  reviewTabCounts,
  sortComments,
  summarizeVerdicts,
  verdictProgressText,
} from './review-state';
import { hasCurrentContent, planDocumentId, targetHref } from './target';

const ME = 'usr_me';

function review(partial: Partial<Review> & { id: string }): Review {
  return {
    projectId: 'prj_1',
    targetKind: 'document',
    targetId: 'doc_1',
    title: partial.id,
    summary: '',
    requestedBy: { kind: 'user', id: 'usr_other', name: '李四' },
    threadId: null,
    status: 'open',
    reviewers: [],
    snapshot: null,
    commentCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    ...partial,
  };
}

const at = '2026-10-01T00:00:00.000Z';
const reviews = [
  review({
    id: 'r1',
    reviewers: [{ userId: ME, verdict: 'pending', updatedAt: at }],
    updatedAt: '2026-10-02T00:00:00.000Z',
  }),
  review({ id: 'r2', reviewers: [{ userId: ME, verdict: 'lgtm', updatedAt: at }] }),
  review({
    id: 'r3',
    requestedBy: { kind: 'user', id: ME, name: '我' },
    reviewers: [{ userId: 'usr_x', verdict: 'pending', updatedAt: at }],
    updatedAt: '2026-10-03T00:00:00.000Z',
  }),
  review({
    id: 'r4',
    status: 'approved',
    reviewers: [{ userId: ME, verdict: 'lgtm', updatedAt: at }],
  }),
  review({
    id: 'r5',
    status: 'closed',
    reviewers: [{ userId: ME, verdict: 'pending', updatedAt: at }],
  }),
  review({
    id: 'r6',
    requestedBy: { kind: 'agent', id: ME, name: '线程 agent' },
    reviewers: [{ userId: ME, verdict: 'commented', updatedAt: at }],
  }),
];

describe('Tab 过滤', () => {
  it('待我审阅：我是审阅人、还没给批准/修改结论、未结束', () => {
    expect(filterReviews(reviews, 'mine', ME).map((r) => r.id)).toEqual(['r1', 'r6']);
    expect(isAwaitingMe(reviews[4]!, ME)).toBe(false);
  });

  it('我发起的：只算人发起的（agent 的 id 不会误判）', () => {
    expect(filterReviews(reviews, 'requested', ME).map((r) => r.id)).toEqual(['r3']);
  });

  it('已结束 = 已通过或已关闭；全部按更新时间倒序', () => {
    expect(
      filterReviews(reviews, 'ended', ME)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['r4', 'r5']);
    expect(
      filterReviews(reviews, 'all', ME)
        .map((r) => r.id)
        .slice(0, 2),
    ).toEqual(['r3', 'r1']);
  });

  it('计数', () => {
    expect(reviewTabCounts(reviews, ME)).toEqual({ mine: 2, requested: 1, all: 6, ended: 2 });
  });

  it('未登录时没有“我的”', () => {
    expect(reviewTabCounts(reviews, null)).toMatchObject({ mine: 0, requested: 0 });
  });
});

describe('结论汇总与状态', () => {
  const v = (...verdicts: Review['reviewers'][number]['verdict'][]) =>
    verdicts.map((verdict, i) => ({ userId: `u${i}`, verdict, updatedAt: at }));

  it('汇总各结论人数', () => {
    expect(summarizeVerdicts(v('lgtm', 'pending', 'changes_requested', 'commented'))).toEqual({
      total: 4,
      lgtm: 1,
      changesRequested: 1,
      commented: 1,
      pending: 1,
      allLgtm: false,
    });
    expect(summarizeVerdicts(v('lgtm', 'lgtm')).allLgtm).toBe(true);
    expect(summarizeVerdicts([]).allLgtm).toBe(false);
  });

  it('推导状态与服务端规则一致', () => {
    expect(deriveReviewStatus(v('lgtm', 'lgtm'))).toBe('approved');
    expect(deriveReviewStatus(v('lgtm', 'changes_requested'))).toBe('changes_requested');
    expect(deriveReviewStatus(v('lgtm', 'pending'))).toBe('open');
    expect(deriveReviewStatus(v('lgtm', 'commented'))).toBe('open');
    expect(deriveReviewStatus([])).toBe('open');
    expect(deriveReviewStatus(v('lgtm'), true)).toBe('closed');
  });

  it('进度文案', () => {
    expect(verdictProgressText(v('lgtm', 'pending', 'changes_requested'))).toBe(
      '1/3 已批准 · 1 人要求修改',
    );
  });
});

describe('全部 LGTM 横幅', () => {
  it('一位审阅人不说「都」，多位才说', () => {
    expect(approvedSummaryText(1)).toBe('审阅人已批准，可以继续推进。');
    expect(approvedSummaryText(1)).not.toContain('都');
    expect(approvedSummaryText(3)).toBe('3 位审阅人都已批准，可以继续推进。');
  });
});

describe('评论', () => {
  const c = (
    id: string,
    createdAt: string,
    anchor: ReviewComment['anchor'] = null,
  ): ReviewComment => ({
    id,
    reviewId: 'r1',
    author: { kind: 'user', id: 'u', name: '张三' },
    body: 'x',
    verdict: null,
    anchor,
    resolved: false,
    createdAt,
  });

  it('从旧到新排序', () => {
    const list = [c('b', '2026-10-02T00:00:00Z'), c('a', '2026-10-01T00:00:00Z')];
    expect(sortComments(list).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('读取引用原文', () => {
    expect(quoteOf(c('a', at, { quote: '第二段' }))).toBe('第二段');
    expect(quoteOf(c('a', at, { quote: '  ' }))).toBeNull();
    expect(quoteOf(c('a', at, { messageId: 'msg_1' }))).toBeNull();
    expect(quoteOf(c('a', at))).toBeNull();
  });

  it('整理选中的文字', () => {
    expect(normalizeQuote('  a\n\n b  ')).toBe('a b');
    expect(normalizeQuote('x'.repeat(10), 4)).toBe('xxxx…');
  });
});

describe('目标', () => {
  it('站内链接', () => {
    expect(targetHref('p1', 'document', 'd1')).toBe('/p/p1/docs/d1');
    expect(targetHref('p1', 'experiment', 'e1')).toBe('/p/p1/experiments/e1');
    expect(targetHref('p1', 'report', 'r1')).toBe('/p/p1/reports/r1');
    expect(targetHref('p1', 'thread', 't1')).toBe('/p/p1/threads/t1');
    expect(targetHref('p1', 'message', 'm1')).toBeNull();
  });

  it('计划目标是文档（doc_…）时链到文档，并可对比当前内容', () => {
    expect(targetHref('p1', 'plan', 'doc_01X')).toBe('/p/p1/docs/doc_01X');
    expect(targetHref('p1', 'plan', 'msg_01X')).toBeNull();
    expect(planDocumentId('plan', 'doc_01X')).toBe('doc_01X');
    expect(planDocumentId('document', 'doc_01X')).toBeNull();
    expect(hasCurrentContent('plan', 'doc_01X')).toBe(true);
    expect(hasCurrentContent('plan', 'msg_01X')).toBe(false);
  });

  it('旧实验可打开移除说明，但不再查询当前内容', () => {
    expect(hasCurrentContent('experiment', 'exp_old')).toBe(false);
  });
});
