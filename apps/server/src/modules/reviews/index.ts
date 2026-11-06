import {
  ReviewCommentCreateInput,
  ReviewCommentUpdateInput,
  ReviewCreateInput,
  ReviewVerdictInput,
} from '@srh/shared';
import { registerCollabPort } from '../../agents/tools/collab-port';
import { parse } from '../../lib/http';
import { requireProject, type Params } from '../collab-common';
import type { ModuleDef } from '../types';
import {
  addComment,
  closeReview,
  createReview,
  getReview,
  giveVerdict,
  listReviews,
  ReviewListQuery,
  updateComment,
} from './service';

/**
 * 审阅 / LGTM
 * 归属：协作功能线程。端点契约见 API.md §2.10，请求体 schema 见 @srh/shared api-collab.ts。
 *
 *   GET   /projects/:projectId/reviews?status=&mine=1&targetKind=&targetId=
 *   POST  /projects/:projectId/reviews
 *   GET   /projects/:projectId/reviews/:reviewId
 *   POST  /projects/:projectId/reviews/:reviewId/verdict
 *   POST  /projects/:projectId/reviews/:reviewId/comments
 *   PATCH /projects/:projectId/reviews/:reviewId/comments/:commentId
 *   POST  /projects/:projectId/reviews/:reviewId/close
 */
type P = Params<'projectId'>;
type PR = Params<'projectId' | 'reviewId'>;
type PRC = Params<'projectId' | 'reviewId' | 'commentId'>;

export const reviewsModule: ModuleDef = {
  name: 'reviews',
  owner: 'collab',
  register(app) {
    // close：agent 重新送审时关闭它自己在同一对象上的旧审阅（canClose 允许发起人自己关）
    registerCollabPort({ reviews: { create: createReview, close: closeReview } });

    app.get<{ Params: P }>('/projects/:projectId/reviews', async (req) => {
      const { projectId } = req.params;
      const access = await requireProject(req, projectId, 'view');
      const filter = parse(ReviewListQuery, req.query);
      return listReviews(app.ctx, access.actor, projectId, filter);
    });

    app.post<{ Params: P }>('/projects/:projectId/reviews', async (req, reply) => {
      const { projectId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const input = parse(ReviewCreateInput, req.body);
      const review = await createReview(app.ctx, access.actor, projectId, input);
      return reply.status(201).send(review);
    });

    app.get<{ Params: PR }>('/projects/:projectId/reviews/:reviewId', async (req) => {
      const { projectId, reviewId } = req.params;
      await requireProject(req, projectId, 'view');
      return getReview(app.ctx, projectId, reviewId);
    });

    app.post<{ Params: PR }>('/projects/:projectId/reviews/:reviewId/verdict', async (req) => {
      const { projectId, reviewId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const input = parse(ReviewVerdictInput, req.body);
      return giveVerdict(app.ctx, access.actor, projectId, reviewId, input);
    });

    app.post<{ Params: PR }>(
      '/projects/:projectId/reviews/:reviewId/comments',
      async (req, reply) => {
        const { projectId, reviewId } = req.params;
        const access = await requireProject(req, projectId, 'write');
        const input = parse(ReviewCommentCreateInput, req.body);
        const comment = await addComment(app.ctx, access.actor, projectId, reviewId, input);
        return reply.status(201).send(comment);
      },
    );

    app.patch<{ Params: PRC }>(
      '/projects/:projectId/reviews/:reviewId/comments/:commentId',
      async (req) => {
        const { projectId, reviewId, commentId } = req.params;
        const access = await requireProject(req, projectId, 'write');
        const input = parse(ReviewCommentUpdateInput, req.body);
        return updateComment(app.ctx, access.actor, projectId, reviewId, commentId, input);
      },
    );

    app.post<{ Params: PR }>('/projects/:projectId/reviews/:reviewId/close', async (req) => {
      const { projectId, reviewId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      return closeReview(app.ctx, access.actor, projectId, reviewId);
    });
  },
};
