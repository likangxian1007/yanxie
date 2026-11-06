import { and, eq, isNull } from 'drizzle-orm';
import { ApiError, newId, type InboxItem, type InboxKind } from '@srh/shared';
import type { AppContext } from '../../context';
import { inboxItems } from '../../db/schema';
import { SYSTEM_ACTOR } from '../projects/service';

export type InboxRow = typeof inboxItems.$inferSelect;

export function toInboxItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    kind: row.kind,
    title: row.title,
    href: row.href,
    sourceId: row.sourceId,
    readAt: row.readAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 给某位成员生成一条“待我处理”。去重：同一用户、同一类型、同一来源已有未完成条目时直接返回它，
 * 不重复打扰（例如同一个认领反复冲突）。
 */
export async function createInboxItem(
  ctx: AppContext,
  input: {
    projectId: string;
    userId: string;
    kind: InboxKind;
    title: string;
    href: string;
    sourceId: string;
  },
): Promise<InboxItem> {
  const [existing] = await ctx.db.db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.userId, input.userId),
        eq(inboxItems.kind, input.kind),
        eq(inboxItems.sourceId, input.sourceId),
        isNull(inboxItems.doneAt),
      ),
    )
    .limit(1);
  if (existing) return toInboxItem(existing);

  const { item, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(inboxItems)
      .values({
        id: newId('inbox'),
        projectId: input.projectId,
        userId: input.userId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        href: input.href,
        sourceId: input.sourceId,
      })
      .returning();
    if (!row) throw new ApiError('internal', '收件箱条目写入失败');
    const item = toInboxItem(row);
    const ev = await ctx.bus.record(tx, {
      projectId: input.projectId,
      type: 'inbox.created',
      payload: item,
      actor: SYSTEM_ACTOR,
    });
    return { item, ev };
  });
  ctx.bus.emit(ev);
  return item;
}

/** 来源对象已处理（决策卡已答、审阅已结、冲突已解除……）：把相关未完成条目标为完成。 */
export async function markInboxDoneBySource(
  ctx: AppContext,
  sourceId: string,
  /** 也接受直接传 userId 字符串（与协作线程约定的旧签名兼容） */
  optsOrUserId: { userId?: string; kind?: InboxKind } | string = {},
): Promise<void> {
  const opts = typeof optsOrUserId === 'string' ? { userId: optsOrUserId } : optsOrUserId;
  const conds = [eq(inboxItems.sourceId, sourceId), isNull(inboxItems.doneAt)];
  if (opts.userId) conds.push(eq(inboxItems.userId, opts.userId));
  if (opts.kind) conds.push(eq(inboxItems.kind, opts.kind));
  const evs = await ctx.db.db.transaction(async (tx) => {
    const rows = await tx
      .update(inboxItems)
      .set({ doneAt: new Date() })
      .where(and(...conds))
      .returning();
    const out = [];
    for (const row of rows) {
      out.push(
        await ctx.bus.record(tx, {
          projectId: row.projectId,
          type: 'inbox.updated',
          payload: toInboxItem(row),
          actor: SYSTEM_ACTOR,
        }),
      );
    }
    return out;
  });
  for (const ev of evs) ctx.bus.emit(ev);
}
