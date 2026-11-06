import { and, eq } from 'drizzle-orm';
import { ApiError, MessageMentions, newId, type MessageMention } from '@srh/shared';
import type { AppContext } from '../../context';
import { inboxItems, messages, projectMembers, threads, users } from '../../db/schema';

export async function validateMentions(
  ctx: AppContext,
  projectId: string,
  threadId: string | null,
  body: string,
  raw: MessageMention[] = [],
): Promise<MessageMention[]> {
  if (!raw.length) return [];
  if (threadId) {
    const [thread] = await ctx.db.db
      .select({ kind: threads.kind })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.projectId, projectId)));
    if (!thread || thread.kind === 'personal')
      throw new ApiError('validation_failed', '个人会话不能提及其他成员');
  }
  const members = await ctx.db.db
    .select({ id: users.id, name: users.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
  const ids = new Map(members.map((m) => [m.id, m.name]));
  const mentions = MessageMentions.parse(raw).sort((a, b) => a.start - b.start);
  let end = 0;
  for (const mention of mentions) {
    if (
      ids.get(mention.userId) !== mention.label ||
      mention.start < end ||
      mention.end <= mention.start ||
      mention.end > body.length ||
      body.slice(mention.start, mention.end) !== `@${mention.label}`
    )
      throw new ApiError('validation_failed', '提及的成员或正文范围无效，请重新选择成员');
    end = mention.end;
  }
  return mentions;
}

/** 行锁保证并发编辑也只对每个消息/成员提醒一次；已处理的提醒不会再次生成。 */
export async function notifyMentions(ctx: AppContext, messageId: string) {
  const events = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
    if (!row || row.deletedAt) return [];
    if (row.threadId) {
      const [thread] = await tx
        .select({ kind: threads.kind })
        .from(threads)
        .where(eq(threads.id, row.threadId));
      if (!thread || thread.kind === 'personal') return [];
    }
    const mentions = MessageMentions.safeParse(row.meta.mentions).data ?? [];
    if (!mentions.length) return [];
    const notified = new Set(
      Array.isArray(row.meta.notifiedMentionUserIds)
        ? row.meta.notifiedMentionUserIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const previous = await tx
      .select({ userId: inboxItems.userId })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, row.projectId),
          eq(inboxItems.sourceId, row.id),
          eq(inboxItems.kind, 'mention'),
        ),
      );
    for (const item of previous) notified.add(item.userId);
    const members = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, row.projectId));
    const ids = new Set(members.map((m) => m.userId));
    const out = [];
    for (const userId of new Set(mentions.map((m) => m.userId))) {
      if (userId === row.authorId || notified.has(userId) || !ids.has(userId)) continue;
      const scope = row.threadId ?? 'project';
      const base = `/p/${row.projectId}${row.threadId ? `/threads/${row.threadId}` : ''}`;
      const href = `${base}${row.agentVisible ? '' : `?discussion=${scope}`}#${row.id}`;
      const [item] = await tx
        .insert(inboxItems)
        .values({
          id: newId('inbox'),
          projectId: row.projectId,
          userId,
          kind: 'mention',
          title: `${row.authorName} 提到了你：${row.body.replace(/\s+/gu, ' ').slice(0, 40)}`,
          href,
          sourceId: row.id,
        })
        .returning();
      out.push(
        await ctx.bus.record(tx, {
          projectId: row.projectId,
          type: 'inbox.created',
          actor: { kind: row.authorKind, id: row.authorId, name: row.authorName },
          payload: {
            ...item!,
            readAt: null,
            doneAt: null,
            createdAt: item!.createdAt.toISOString(),
          },
        }),
      );
      notified.add(userId);
    }
    await tx
      .update(messages)
      .set({ meta: { ...row.meta, notifiedMentionUserIds: [...notified] } })
      .where(eq(messages.id, row.id));
    return out;
  });
  for (const event of events) ctx.bus.emit(event);
}
