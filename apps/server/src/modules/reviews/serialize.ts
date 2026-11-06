import type { Review, ReviewComment, ReviewParticipant } from '@srh/shared';
import type { reviewComments, reviewParticipants, reviews } from '../../db/schema';
import { iso, isoReq } from '../collab-common';

export type ReviewRow = typeof reviews.$inferSelect;
export type ReviewParticipantRow = typeof reviewParticipants.$inferSelect;
export type ReviewCommentRow = typeof reviewComments.$inferSelect;

export function toParticipant(row: ReviewParticipantRow): ReviewParticipant {
  return { userId: row.userId, verdict: row.verdict, updatedAt: isoReq(row.updatedAt) };
}

export function toReview(
  row: ReviewRow,
  reviewers: ReviewParticipantRow[],
  commentCount: number,
): Review {
  return {
    id: row.id,
    projectId: row.projectId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    title: row.title,
    summary: row.summary,
    requestedBy: row.requestedBy,
    threadId: row.threadId,
    status: row.status,
    reviewers: reviewers.map(toParticipant),
    snapshot: row.snapshot,
    supersededById: row.supersededById ?? null,
    commentCount,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
    closedAt: iso(row.closedAt),
  };
}

export function toReviewComment(row: ReviewCommentRow): ReviewComment {
  return {
    id: row.id,
    reviewId: row.reviewId,
    author: row.author,
    body: row.body,
    verdict: row.verdict ?? null,
    anchor: row.anchor ?? null,
    resolved: row.resolved,
    createdAt: isoReq(row.createdAt),
  };
}
