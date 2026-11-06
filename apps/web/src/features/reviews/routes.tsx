import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadReviewsPage = () =>
  import('./pages/ReviewsPage').then((m) => ({ Component: m.ReviewsPage }));
const loadReviewDetailPage = () =>
  import('./pages/ReviewDetailPage').then((m) => ({ Component: m.ReviewDetailPage }));
const loadProposalPage = () =>
  import('@/features/versioning/pages/ProposalPage').then((m) => ({ Component: m.ProposalPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const reviewsRoutes: RouteObject[] = [
  { path: 'reviews', lazy: loadReviewsPage, handle: { title: tr('审阅') } },
  { path: 'reviews/:reviewId', lazy: loadReviewDetailPage, handle: { title: tr('审阅详情') } },
  { path: 'proposals/:proposalId', lazy: loadProposalPage, handle: { title: tr('改动提案') } },
];
