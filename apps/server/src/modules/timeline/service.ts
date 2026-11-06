import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import {
  ApiError,
  newId,
  type ActorRef,
  type Message,
  type MessageKind,
  type MessageMention,
  type OutputKind,
  type Page,
  type Reaction,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { messages, outputs, reactions, threads } from '../../db/schema';
import { notifyMentions, validateMentions } from './mentions';

export type MessageRow = typeof messages.$inferSelect;

export interface NewOutput {
  kind: OutputKind;
  ref: string;
  title: string;
}

/** 批量把消息行转成 DTO：一次查反应、产出、根线程 */
export async function toMessages(ctx: AppContext, rows: MessageRow[]): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const db = ctx.db.db;
  const [reacts, outs, roots] = await Promise.all([
    db
      .select()
      .from(reactions)
      .where(inArray(reactions.messageId, ids))
      .orderBy(reactions.createdAt),
    db.select().from(outputs).where(inArray(outputs.messageId, ids)).orderBy(outputs.createdAt),
    db
      .select({ id: threads.id, root: threads.rootMessageId })
      .from(threads)
      .where(inArray(threads.rootMessageId, ids)),
  ]);
  const rootBy = new Map(roots.map((r) => [r.root, r.id]));
  return rows.map((row) => {
    const byEmoji = new Map<string, Reaction>();
    for (const r of reacts) {
      if (r.messageId !== row.id) continue;
      let entry = byEmoji.get(r.emoji);
      if (!entry) byEmoji.set(r.emoji, (entry = { emoji: r.emoji, actors: [] }));
      entry.actors.push({ kind: r.actorKind, id: r.actorId, name: r.actorName });
    }
    return {
      id: row.id,
      projectId: row.projectId,
      threadId: row.threadId,
      author: { kind: row.authorKind, id: row.authorId, name: row.authorName },
      kind: row.kind,
      body: row.deletedAt ? '' : row.body,
      meta: row.meta,
      agentVisible: row.agentVisible,
      reactions: [...byEmoji.values()],
      outputs: outs
        .filter((o) => o.messageId === row.id)
        .map((o) => ({ id: o.id, kind: o.kind, ref: o.ref, title: o.title })),
      rootOfThreadId: rootBy.get(row.id) ?? null,
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function getMessageRow(ctx: AppContext, projectId: string, messageId: string) {
  const [row] = await ctx.db.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.projectId, projectId),
        isNull(messages.deletedAt),
      ),
    );
  return row ?? null;
}

export async function getMessage(ctx: AppContext, projectId: string, messageId: string) {
  const row = await getMessageRow(ctx, projectId, messageId);
  return row ? ((await toMessages(ctx, [row]))[0] ?? null) : null;
}

/** 消息分页：threadId=null 为时间线顶层。游标 = 上一页最后一条的 id（ULID 按时间有序）。 */
export async function listMessages(
  ctx: AppContext,
  projectId: string,
  threadId: string | null,
  q: {
    cursor?: string | undefined;
    limit: number;
    order: 'asc' | 'desc';
    channel?: 'all' | 'agent' | 'team' | undefined;
  },
  opts: { agentVisibleOnly?: boolean } = {},
): Promise<Page<Message>> {
  const conds = [
    eq(messages.projectId, projectId),
    threadId === null ? isNull(messages.threadId) : eq(messages.threadId, threadId),
    isNull(messages.deletedAt),
  ];
  // 内部 agent 可见性约束优先于调用者的频道筛选。
  if (opts.agentVisibleOnly || q.channel === 'agent') conds.push(eq(messages.agentVisible, true));
  else if (q.channel === 'team') conds.push(eq(messages.agentVisible, false));
  if (q.cursor)
    conds.push(q.order === 'asc' ? gt(messages.id, q.cursor) : lt(messages.id, q.cursor));
  const rows = await ctx.db.db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(q.order === 'asc' ? asc(messages.id) : desc(messages.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: await toMessages(ctx, page),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export interface CreateMessageInput {
  projectId: string;
  threadId: string | null;
  author: ActorRef;
  kind?: MessageKind;
  body: string;
  mentions?: MessageMention[];
  meta?: Record<string, unknown>;
  agentVisible?: boolean;
  outputs?: NewOutput[];
  /** 预先生成的 id（决策卡需要先知道消息 id） */
  id?: string;
}

/**
 * 写一条消息并发布 message.created；挂上产出（资料库去重：同 kind+ref 只保留第一次）；
 * 处理 @提及（给被 @ 的成员发收件箱）；刷新线程活跃时间与回复数（thread.updated 由 threads 服务发）。
 */
export async function createMessage(ctx: AppContext, input: CreateMessageInput): Promise<Message> {
  const mentions = await validateMentions(
    ctx,
    input.projectId,
    input.threadId,
    input.body,
    input.mentions,
  );
  const id = input.id ?? newId('message');
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        id,
        projectId: input.projectId,
        threadId: input.threadId,
        authorKind: input.author.kind,
        authorId: input.author.id,
        authorName: input.author.name,
        kind: input.kind ?? 'text',
        body: input.body,
        meta: { ...input.meta, ...(mentions.length ? { mentions } : {}) },
        agentVisible: input.agentVisible ?? true,
      })
      .returning();
    for (const o of input.outputs ?? []) {
      await tx
        .insert(outputs)
        .values({
          id: newId('output'),
          projectId: input.projectId,
          threadId: input.threadId,
          messageId: id,
          kind: o.kind,
          ref: o.ref,
          title: o.title,
        })
        .onConflictDoNothing();
    }
    return row!;
  });
  const message = (await toMessages(ctx, [event]))[0]!;
  await ctx.bus.publish({
    projectId: input.projectId,
    threadId: input.threadId,
    type: 'message.created',
    payload: message,
    actor: input.author,
  });
  if (input.threadId) await touchThread(ctx, input.threadId);
  if (mentions.length) await notifyMentions(ctx, message.id);
  return message;
}

/** 刷新线程 lastActivityAt 并发 thread.updated（延迟 import 避免循环依赖） */
async function touchThread(ctx: AppContext, threadId: string) {
  const { refreshThread } = await import('../threads/service');
  await refreshThread(ctx, threadId, { touch: true });
}

export async function republishMessage(ctx: AppContext, row: MessageRow, actor: ActorRef) {
  const message = (await toMessages(ctx, [row]))[0]!;
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.threadId,
    type: 'message.updated',
    payload: message,
    actor,
  });
  return message;
}

export async function editMessage(
  ctx: AppContext,
  projectId: string,
  messageId: string,
  actor: ActorRef,
  body: string,
  mentions?: MessageMention[],
): Promise<Message> {
  const row = await getMessageRow(ctx, projectId, messageId);
  if (!row) throw new ApiError('not_found', '消息不存在');
  if (row.authorKind !== actor.kind || row.authorId !== actor.id) {
    throw new ApiError('forbidden', '只能修改自己的消息');
  }
  if (row.kind !== 'text') throw new ApiError('conflict', '这类消息不能编辑');
  const valid = await validateMentions(ctx, projectId, row.threadId, body, mentions);
  const updated = await ctx.db.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .for('update');
    if (!current || current.deletedAt) throw new ApiError('not_found', '消息不存在');
    const meta = { ...current.meta };
    delete meta.mentions;
    if (valid.length) meta.mentions = valid;
    const [next] = await tx
      .update(messages)
      .set({ body, meta, editedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning();
    return next!;
  });
  if (valid.length) await notifyMentions(ctx, messageId);
  const latest = await getMessageRow(ctx, projectId, messageId);
  return republishMessage(ctx, latest ?? updated!, actor);
}

export async function deleteMessage(
  ctx: AppContext,
  projectId: string,
  messageId: string,
  actor: ActorRef,
): Promise<void> {
  const row = await getMessageRow(ctx, projectId, messageId);
  if (!row) throw new ApiError('not_found', '消息不存在');
  if (row.authorKind !== actor.kind || row.authorId !== actor.id) {
    throw new ApiError('forbidden', '只能删除自己的消息');
  }
  const [root] = await ctx.db.db
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.rootMessageId, messageId));
  if (root) throw new ApiError('conflict', '这条消息下面有线程，不能删除');
  await ctx.db.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId));
  await ctx.bus.publish({
    projectId,
    threadId: row.threadId,
    type: 'message.deleted',
    payload: { id: messageId },
    actor,
  });
}

export async function setReaction(
  ctx: AppContext,
  projectId: string,
  messageId: string,
  actor: ActorRef & { id: string },
  emoji: string,
  on: boolean,
): Promise<Message> {
  const row = await getMessageRow(ctx, projectId, messageId);
  if (!row) throw new ApiError('not_found', '消息不存在');
  if (on) {
    await ctx.db.db
      .insert(reactions)
      .values({
        messageId,
        emoji,
        actorKind: actor.kind,
        actorId: actor.id,
        actorName: actor.name,
      })
      .onConflictDoNothing();
  } else {
    await ctx.db.db
      .delete(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.emoji, emoji),
          eq(reactions.actorId, actor.id),
        ),
      );
  }
  return republishMessage(ctx, row, actor);
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
