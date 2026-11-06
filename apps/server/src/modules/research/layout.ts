import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiError,
  newId,
  type ActorRef,
  type ResearchItem,
  type ResearchLayoutUpdateInput,
  type ResearchRecord,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { researchIdempotency, researchWorkspaceItems } from '../../db/schema';
import { notFound } from '../collab-common';
import { getEntity } from './service';

const dto = (row: typeof researchWorkspaceItems.$inferSelect): ResearchItem => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

/** 位置是独立版本：整批校验并在同一事务内提交，不影响正文版本。 */
export async function updateResearchLayout(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: ResearchLayoutUpdateInput,
): Promise<{ items: ResearchItem[] }> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  if (new Set(input.moves.map((move) => move.itemId)).size !== input.moves.length)
    throw new ApiError('validation_failed', '同一内容不能在一次布局更新中重复出现');

  const action = `research.layout.updated:${recordId}`;
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const findPrior = async () => {
    if (!input.idempotencyKey) return null;
    const [prior] = await ctx.db.db
      .select()
      .from(researchIdempotency)
      .where(
        and(
          eq(researchIdempotency.projectId, projectId),
          eq(researchIdempotency.actorId, actor.id ?? actor.kind),
          eq(researchIdempotency.action, action),
          eq(researchIdempotency.key, input.idempotencyKey),
        ),
      );
    if (!prior) return null;
    if (prior.requestHash !== requestHash) throw new ApiError('conflict', '幂等键已用于其他请求');
    return prior.response as { items: ResearchItem[] };
  };
  const previous = await findPrior();
  if (previous) return previous;

  try {
    const result = await ctx.db.db.transaction(async (tx) => {
      const t = researchWorkspaceItems;
      // 按固定顺序锁定，避免重叠批次按不同顺序拖动造成死锁。
      const rows = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.projectId, projectId),
            eq(t.recordId, recordId),
            isNull(t.archivedAt),
            inArray(
              t.id,
              input.moves.map((move) => move.itemId),
            ),
          ),
        )
        .orderBy(asc(t.id))
        .for('update');
      if (rows.length !== input.moves.length) notFound('研究条目');
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (
        input.moves.some(
          (move) => byId.get(move.itemId)?.positionVersion !== move.basePositionVersion,
        )
      )
        throw new ApiError('version_conflict', '布局已被他人修改', {
          current: input.moves.map((move) => dto(byId.get(move.itemId)!)),
        });

      const items: ResearchItem[] = [];
      const events = [];
      const updatedAt = new Date();
      for (const move of input.moves) {
        const [row] = await tx
          .update(t)
          .set({
            position: move.position,
            positionVersion: sql`${t.positionVersion} + 1`,
            updatedAt,
          })
          .where(eq(t.id, move.itemId))
          .returning();
        const item = dto(row!);
        items.push(item);
        events.push(
          await ctx.bus.record(tx, {
            projectId,
            type: 'research.item.updated',
            payload: item,
            actor,
          }),
        );
      }
      const response = { items };
      if (input.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action,
          key: input.idempotencyKey,
          requestHash,
          response,
        });
      return { response, events };
    });
    for (const event of result.events) ctx.bus.emit(event);
    return result.response;
  } catch (error) {
    // 同键并发时，另一事务可能在等待锁期间先提交。
    const winner = await findPrior();
    if (winner) return winner;
    throw error;
  }
}
