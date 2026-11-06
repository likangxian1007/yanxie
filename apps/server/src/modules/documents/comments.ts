import { and, asc, eq, inArray, or } from 'drizzle-orm';
import {
  ApiError,
  DocCommentCreateInput,
  DocCommentUpdateInput,
  DocMentionInput,
  ulid,
  type ActorRef,
  type DocComment,
  type ProjectRole,
} from '@srh/shared';
import type { z } from 'zod';
import type { AppContext } from '../../context';
import { documentComments, projectMembers } from '../../db/schema';
import { memberRole, notFound, roleCan } from '../collab-common';
import { accessOf } from '../sharing/access';
import { loadResource } from '../sharing/service';
import { createInboxItem, markInboxDoneBySource } from '../collab-common/inbox';
import { getRow } from './service';

/**
 * 富文本行内评论（飞书式批注）：评论串 = 首条（带锚点、引用原文、解决状态）+ 回复。
 * 权限：看 = 全部成员（含访客）；写 / 回复 / 解决 = owner、advisor、member；
 * 改正文只限作者；删除 = 作者或 owner / advisor（删首条连同回复一起删）。
 * @ 到的成员、被回复的首条作者会收到 mention 类“待我处理”；解决评论串时这些提醒一起标记完成。
 */
type Row = typeof documentComments.$inferSelect;

/** 评论 id：dcm_ + ULID（ids.ts 归后端线程，这里自己拼前缀） */
const commentId = () => `dcm_${ulid()}`;

export function toComment(row: Row): DocComment {
  return {
    id: row.id,
    documentId: row.documentId,
    projectId: row.projectId,
    parentId: row.parentId,
    author: row.author,
    body: row.body,
    mentions: row.mentions,
    anchor: row.anchor ?? null,
    quote: row.quote,
    resolved: !!row.resolvedAt,
    resolvedBy: (row.resolvedBy as ActorRef | null) ?? null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function commentRow(ctx: AppContext, docId: string, id: string): Promise<Row> {
  const [row] = await ctx.db.db
    .select()
    .from(documentComments)
    .where(and(eq(documentComments.id, id), eq(documentComments.documentId, docId)));
  if (!row) notFound('评论');
  return row;
}

export async function listComments(
  ctx: AppContext,
  projectId: string,
  docId: string,
): Promise<DocComment[]> {
  await getRow(ctx, projectId, docId);
  const rows = await ctx.db.db
    .select()
    .from(documentComments)
    .where(eq(documentComments.documentId, docId))
    .orderBy(asc(documentComments.createdAt), asc(documentComments.id));
  return rows.map(toComment);
}

/**
 * 只保留真的是项目成员、而且能看到这篇文档的 id（去重、去掉自己）。
 * 个人空间的文档：@ 了没被分享到的人不发通知（通知里有标题和摘录）。
 */
async function memberIds(
  ctx: AppContext,
  projectId: string,
  ids: readonly string[],
  except: string | null,
  docId: string,
): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => id && id !== except);
  if (wanted.length === 0) return [];
  const rows = await ctx.db.db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, wanted)));
  const ok = new Set(rows.map((r) => r.userId));
  const res = await loadResource(ctx, 'document', docId);
  if (res?.space === 'personal') {
    for (const id of [...ok]) {
      const role = await memberRole(ctx, projectId, id);
      if ((await accessOf(ctx, res, { userId: id, role })) === 'none') ok.delete(id);
    }
  }
  return wanted.filter((id) => ok.has(id));
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/gu, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export const docHref = (projectId: string, docId: string, commentId?: string) =>
  `/p/${projectId}/docs/${docId}${commentId ? `?comment=${commentId}` : ''}`;

export async function createComment(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  input: z.input<typeof DocCommentCreateInput>,
): Promise<DocComment> {
  const data = DocCommentCreateInput.parse(input);
  const doc = await getRow(ctx, projectId, docId);
  if (doc.kind !== 'doc') throw new ApiError('bad_request', '只有富文本文档支持行内评论');
  let root: Row | null = null;
  if (data.parentId) {
    root = await commentRow(ctx, docId, data.parentId);
    if (root.parentId) root = await commentRow(ctx, docId, root.parentId);
  }
  const mentions = await memberIds(ctx, projectId, data.mentions, actor.id, docId);
  const now = new Date();
  const { dto, event, reopened } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(documentComments)
      .values({
        id: commentId(),
        documentId: docId,
        projectId,
        parentId: root?.id ?? null,
        author: actor,
        body: data.body,
        mentions,
        anchor: root ? null : data.anchor,
        quote: root ? '' : data.quote.slice(0, 2000),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const dto = toComment(row!);
    const event = await ctx.bus.record(tx, {
      projectId,
      type: 'document.comment_created',
      payload: dto,
      actor,
    });
    // 已解决的评论串收到新回复：自动重新打开（飞书同款）
    let reopened = null;
    if (root?.resolvedAt) {
      const [r] = await tx
        .update(documentComments)
        .set({ resolvedAt: null, resolvedBy: null, updatedAt: now })
        .where(eq(documentComments.id, root.id))
        .returning();
      reopened = await ctx.bus.record(tx, {
        projectId,
        type: 'document.comment_updated',
        payload: toComment(r!),
        actor,
      });
    }
    return { dto, event, reopened };
  });
  ctx.bus.emit(event);
  if (reopened) ctx.bus.emit(reopened);

  const href = docHref(projectId, docId, root?.id ?? dto.id);
  const excerpt = clip(data.body, 60);
  for (const userId of mentions) {
    await createInboxItem(ctx, {
      projectId,
      userId,
      kind: 'mention',
      title: `${actor.name} 在《${doc.title}》的评论里提到了你：${excerpt}`,
      href,
      sourceId: dto.id,
    });
  }
  // 回复：提醒首条作者（他没被 @ 到、也不是自己时）
  if (
    root &&
    root.author.kind === 'user' &&
    root.author.id &&
    root.author.id !== actor.id &&
    !mentions.includes(root.author.id)
  ) {
    const [stillMember] = await memberIds(ctx, projectId, [root.author.id], actor.id, docId);
    if (stillMember) {
      await createInboxItem(ctx, {
        projectId,
        userId: stillMember,
        kind: 'mention',
        title: `${actor.name} 回复了你在《${doc.title}》的评论：${excerpt}`,
        href,
        sourceId: dto.id,
      });
    }
  }
  return dto;
}

export async function updateComment(
  ctx: AppContext,
  access: { actor: ActorRef; role: ProjectRole },
  projectId: string,
  docId: string,
  id: string,
  input: z.input<typeof DocCommentUpdateInput>,
): Promise<DocComment> {
  const data = DocCommentUpdateInput.parse(input);
  const doc = await getRow(ctx, projectId, docId);
  const row = await commentRow(ctx, docId, id);
  const { actor } = access;
  const set: Partial<typeof documentComments.$inferInsert> = { updatedAt: new Date() };
  let newMentions: string[] = [];
  if (data.body !== undefined) {
    if (row.author.kind !== 'user' || row.author.id !== actor.id) {
      throw new ApiError('forbidden', '只能修改自己写的评论');
    }
    set.body = data.body;
    const mentions = await memberIds(
      ctx,
      projectId,
      data.mentions ?? row.mentions,
      actor.id,
      docId,
    );
    set.mentions = mentions;
    newMentions = mentions.filter((m) => !row.mentions.includes(m));
  }
  if (data.resolved !== undefined) {
    if (row.parentId) throw new ApiError('validation_failed', '只能解决整个评论串（首条评论）');
    set.resolvedAt = data.resolved ? new Date() : null;
    set.resolvedBy = data.resolved ? actor : null;
  }
  const { dto, event } = await ctx.db.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(documentComments)
      .set(set)
      .where(eq(documentComments.id, id))
      .returning();
    const dto = toComment(updated!);
    const event = await ctx.bus.record(tx, {
      projectId,
      type: 'document.comment_updated',
      payload: dto,
      actor,
    });
    return { dto, event };
  });
  ctx.bus.emit(event);

  for (const userId of newMentions) {
    await createInboxItem(ctx, {
      projectId,
      userId,
      kind: 'mention',
      title: `${actor.name} 在《${doc.title}》的评论里提到了你：${clip(dto.body, 60)}`,
      href: docHref(projectId, docId, row.parentId ?? row.id),
      sourceId: dto.id,
    });
  }
  // 解决：这串评论带来的提醒都算处理完了
  if (data.resolved === true) {
    const thread = await ctx.db.db
      .select({ id: documentComments.id })
      .from(documentComments)
      .where(or(eq(documentComments.id, id), eq(documentComments.parentId, id)));
    for (const c of thread) await markInboxDoneBySource(ctx, projectId, c.id, actor);
  }
  return dto;
}

export async function deleteComment(
  ctx: AppContext,
  access: { actor: ActorRef; role: ProjectRole },
  projectId: string,
  docId: string,
  id: string,
): Promise<void> {
  await getRow(ctx, projectId, docId);
  const row = await commentRow(ctx, docId, id);
  const own = row.author.kind === 'user' && row.author.id === access.actor.id;
  if (!own && !roleCan(access.role, 'manage')) {
    throw new ApiError('forbidden', '只能删除自己写的评论');
  }
  const removed = await ctx.db.db
    .select({ id: documentComments.id })
    .from(documentComments)
    .where(or(eq(documentComments.id, id), eq(documentComments.parentId, id)));
  const event = await ctx.db.db.transaction(async (tx) => {
    await tx
      .delete(documentComments)
      .where(or(eq(documentComments.id, id), eq(documentComments.parentId, id)));
    return ctx.bus.record(tx, {
      projectId,
      type: 'document.comment_deleted',
      payload: { id, documentId: docId },
      actor: access.actor,
    });
  });
  ctx.bus.emit(event);
  for (const c of removed) await markInboxDoneBySource(ctx, projectId, c.id, access.actor);
}

/** 正文里 @ 了成员（前端插入提及节点时调用；agent 写入的提及由 applyDocumentEdit 处理） */
export async function notifyDocMentions(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  input: z.input<typeof DocMentionInput>,
): Promise<{ notified: string[] }> {
  const data = DocMentionInput.parse(input);
  const doc = await getRow(ctx, projectId, docId);
  const ids = await memberIds(ctx, projectId, data.userIds, actor.id, docId);
  const context = clip(data.context, 60);
  for (const userId of ids) {
    await createInboxItem(ctx, {
      projectId,
      userId,
      kind: 'mention',
      title: `${actor.name} 在《${doc.title}》里提到了你${context ? `：${context}` : ''}`,
      href: docHref(projectId, docId),
      sourceId: `${docId}:mention`,
    });
  }
  return { notified: ids };
}

/** markdown 里 `[@名字](mention:<id>)` 的 id 集合 */
export function mentionIdsInMarkdown(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\(mention:([^)\s]+)\)/gu)) out.add(m[1]!);
  return out;
}
