import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  DocumentCreateInput,
  DocumentEdit,
  DocumentUpdateInput,
  DocumentVersionCreateInput,
  newId,
  type ActorRef,
  type DocumentContent,
  type DocumentKind,
  type DocumentMeta,
  type DocumentSearchHit,
  type DocumentVersion,
  type ProjectRole,
  type ResourceSpace,
  type SpaceFilter,
} from '@srh/shared';
import type { z } from 'zod';
import type { AppContext } from '../../context';
import { documents, documentVersions } from '../../db/schema';
import { closeDocumentConnections, liveDocument, withLiveDocument } from '../../realtime/collab';
import { notFound } from '../collab-common';
import { accessMap, sharedIds, TEAM_VIEWER, visibleWhere, type Viewer } from '../sharing/access';
import { clearSharing, notifySpaceChanged } from '../sharing/service';
import { clearPersonalAudience, setPersonalAudience } from '../../realtime/audience';
import { latexFileList, latexFilesComment } from './latex/project';
import { forgetCompiled } from './latex/service';
import { documentExcerpt, markdownExcerpt } from './markdown';
import { applyEdit, initContent, outlineOf, replaceContent, toMarkdown } from './ydoc';
import { mentionIdsInMarkdown, notifyDocMentions } from './comments';

type Row = typeof documents.$inferSelect;

export function toMeta(row: Row): DocumentMeta {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    title: row.title,
    icon: row.icon,
    excerpt: documentExcerpt(row.kind, row.contentText),
    createdBy: row.createdBy,
    updatedBy: (row.updatedBy as ActorRef | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    space: row.space,
    ownerUserId: row.ownerUserId,
  };
}

function versionDto(row: typeof documentVersions.$inferSelect): DocumentVersion {
  return {
    id: row.id,
    documentId: row.documentId,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getRow(ctx: AppContext, projectId: string, docId: string): Promise<Row> {
  const [row] = await ctx.db.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.projectId, projectId)));
  if (!row) notFound('文档');
  return row;
}

/**
 * 新文档放在哪：团队空间（默认）或某人的个人空间。父文档必须和它在同一个空间、同一个所有者下
 * （不能把个人草稿挂在团队文档下面，反之亦然）。
 */
export async function placementFor(
  ctx: AppContext,
  projectId: string,
  space: ResourceSpace | undefined,
  ownerUserId: string | null,
  parentId: string | null | undefined,
): Promise<{ space: ResourceSpace; ownerUserId: string | null; parentId: string | null }> {
  const target: ResourceSpace = space ?? 'team';
  if (target === 'personal' && !ownerUserId) {
    throw new ApiError('validation_failed', '只有成员本人能在自己的个人空间里新建文档');
  }
  const owner = target === 'personal' ? ownerUserId : null;
  if (parentId) {
    const parent = await getRow(ctx, projectId, parentId);
    if (parent.space !== target || (parent.ownerUserId ?? null) !== owner) {
      throw new ApiError('validation_failed', '父文档和它不在同一个空间');
    }
  }
  return { space: target, ownerUserId: owner, parentId: parentId ?? null };
}

/** REST 响应里给每篇文档标上当前用户的权限，所有者的个人文档标上是否已分享 */
export async function annotateDocs(
  ctx: AppContext,
  metas: DocumentMeta[],
  viewer: Viewer,
): Promise<DocumentMeta[]> {
  const rows = metas.map((m) => ({
    id: m.id,
    space: m.space ?? 'team',
    ownerUserId: m.ownerUserId ?? null,
  }));
  const access = await accessMap(ctx, 'document', rows, viewer);
  const mine = rows.filter((r) => r.space === 'personal' && r.ownerUserId === viewer.userId);
  const shared = await sharedIds(
    ctx,
    'document',
    mine.map((r) => r.id),
  );
  return metas.map((m) => ({
    ...m,
    access: access.get(m.id) ?? 'none',
    ...(m.space === 'personal' && m.ownerUserId === viewer.userId
      ? { shared: shared.has(m.id) }
      : {}),
  }));
}

/** 文档当前的 Y.Doc：有人在线编辑时用内存里的最新状态，否则从库里读 */
async function currentYDoc(ctx: AppContext, row: Row): Promise<Y.Doc> {
  const live = liveDocument(ctx, row.id);
  if (live) return live;
  const doc = new Y.Doc();
  if (row.ydocState) Y.applyUpdate(doc, row.ydocState);
  return doc;
}

/** 在文档当前状态上执行只读操作（LaTeX 编译等）；临时加载的 Y.Doc 用完即销毁 */
export async function withDocumentSnapshot<T>(
  ctx: AppContext,
  row: Row,
  fn: (doc: Y.Doc) => Promise<T>,
): Promise<T> {
  const live = liveDocument(ctx, row.id);
  if (live) return fn(live);
  const doc = await currentYDoc(ctx, row);
  try {
    return await fn(doc);
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------- 读

export interface DocumentListFilter {
  archived?: boolean;
  kind?: DocumentKind;
  parentId?: string;
  /** 空间筛选，默认 all（观看者能看到的全部） */
  space?: SpaceFilter;
}

export async function listDocuments(
  ctx: AppContext,
  projectId: string,
  filter: DocumentListFilter = {},
  viewer: Viewer = TEAM_VIEWER,
): Promise<DocumentMeta[]> {
  const where = [
    eq(documents.projectId, projectId),
    visibleWhere('document', documents, viewer, filter.space),
    filter.archived ? isNotNull(documents.archivedAt) : isNull(documents.archivedAt),
  ];
  if (filter.kind) where.push(eq(documents.kind, filter.kind));
  if (filter.parentId) where.push(eq(documents.parentId, filter.parentId));
  const rows = await ctx.db.db
    .select()
    .from(documents)
    .where(and(...where))
    .orderBy(desc(documents.updatedAt));
  return rows.map(toMeta);
}

export async function getDocument(ctx: AppContext, projectId: string, docId: string) {
  return toMeta(await getRow(ctx, projectId, docId));
}

export async function readDocument(
  ctx: AppContext,
  projectId: string,
  docId: string,
): Promise<DocumentContent> {
  const row = await getRow(ctx, projectId, docId);
  // 没有协同状态的旧行（例如直接导入的数据）：退回纯文本快照
  if (!row.ydocState && !liveDocument(ctx, row.id)) {
    return { meta: toMeta(row), markdown: row.contentText, outline: [] };
  }
  const doc = await currentYDoc(ctx, row);
  const content: DocumentContent = {
    meta: toMeta(row),
    markdown: toMarkdown(doc, row.kind),
    outline: outlineOf(doc, row.kind),
  };
  if (row.kind === 'latex') {
    // 多文件工程：附上文件清单（结构化编辑仍只作用于 main.tex）
    const files = latexFileList(doc);
    if (files) {
      content.files = files;
      content.markdown = `${latexFilesComment(doc)}${content.markdown}`;
    }
  }
  return content;
}

/** 文档的 markdown 表示（审阅快照、组会汇报用） */
export async function getDocumentMarkdown(
  ctx: AppContext,
  projectId: string,
  docId: string,
): Promise<string> {
  return (await readDocument(ctx, projectId, docId)).markdown;
}

export async function searchDocuments(
  ctx: AppContext,
  projectId: string,
  query: string,
  limit = 20,
  viewer: Viewer = TEAM_VIEWER,
): Promise<DocumentSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
  const rows = await ctx.db.db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        visibleWhere('document', documents, viewer),
        isNull(documents.archivedAt),
        or(ilike(documents.title, pattern), ilike(documents.contentText, pattern)),
      ),
    )
    .orderBy(desc(documents.updatedAt))
    .limit(limit);
  return rows.map((row) => {
    const text = row.contentText;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    const snippet =
      i < 0
        ? markdownExcerpt(text, 120)
        : `${i > 40 ? '…' : ''}${text.slice(Math.max(0, i - 40), i + q.length + 80).replace(/\s+/gu, ' ')}…`;
    return { id: row.id, kind: row.kind, title: row.title, snippet };
  });
}

// ---------------------------------------------------------------- 写

export async function createDocument(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: z.input<typeof DocumentCreateInput>,
  /** 建在个人空间时的所有者（发起的成员）；没有则不能建个人文档 */
  ownerUserId: string | null = null,
): Promise<DocumentMeta> {
  const data = DocumentCreateInput.parse(input);
  const placement = await placementFor(ctx, projectId, data.space, ownerUserId, data.parentId);
  const title = data.title || '未命名文档';
  const doc = new Y.Doc();
  initContent(doc, data.kind, data.markdown, title);
  const markdown = toMarkdown(doc, data.kind);
  const id = newId('document');
  const { meta, event } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        id,
        projectId,
        kind: data.kind,
        title,
        icon: data.icon,
        ydocState: Y.encodeStateAsUpdate(doc),
        contentText: markdown,
        createdBy: actor,
        updatedBy: actor,
        ...placement,
      })
      .returning();
    const meta = toMeta(row!);
    const event = await ctx.bus.record(tx, {
      projectId,
      type: 'document.created',
      payload: meta,
      actor,
    });
    return { meta, event };
  });
  ctx.bus.emit(event);
  doc.destroy();
  return meta;
}

/** 写回协同状态（onStoreDocument 与结构化编辑共用），发 document.updated */
export async function persistDocument(
  ctx: AppContext,
  docId: string,
  doc: Y.Doc,
  actor: ActorRef,
): Promise<DocumentMeta | null> {
  const [current] = await ctx.db.db
    .select({ kind: documents.kind, projectId: documents.projectId })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!current) return null;
  const markdown = toMarkdown(doc, current.kind);
  const { meta, event } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(documents)
      .set({
        ydocState: Y.encodeStateAsUpdate(doc),
        contentText: markdown,
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, docId))
      .returning();
    const meta = toMeta(row!);
    const event = await ctx.bus.record(tx, {
      projectId: current.projectId,
      type: 'document.updated',
      payload: meta,
      actor,
    });
    return { meta, event };
  });
  ctx.bus.emit(event);
  return meta;
}

async function assertNoCycle(ctx: AppContext, projectId: string, docId: string, parentId: string) {
  let cur: string | null = parentId;
  for (let depth = 0; cur && depth < 50; depth += 1) {
    if (cur === docId)
      throw new ApiError('validation_failed', '不能把文档移动到它自己或它的子文档下面');
    const row = await getRow(ctx, projectId, cur);
    cur = row.parentId;
  }
}

export async function updateDocument(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  input: z.input<typeof DocumentUpdateInput>,
): Promise<DocumentMeta> {
  const data = DocumentUpdateInput.parse(input);
  const before = await getRow(ctx, projectId, docId);
  if (data.parentId) {
    await assertNoCycle(ctx, projectId, docId, data.parentId);
    const parent = await getRow(ctx, projectId, data.parentId);
    if (parent.space !== before.space || parent.ownerUserId !== before.ownerUserId) {
      throw new ApiError('validation_failed', '只能移到同一个空间里的文档下面');
    }
  }
  const set: Partial<typeof documents.$inferInsert> = { updatedBy: actor, updatedAt: new Date() };
  if (data.title !== undefined) set.title = data.title || '未命名文档';
  if (data.parentId !== undefined) set.parentId = data.parentId;
  if (data.icon !== undefined) set.icon = data.icon;
  if (data.archived !== undefined) set.archivedAt = data.archived ? new Date() : null;
  const { meta, event } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx.update(documents).set(set).where(eq(documents.id, docId)).returning();
    const meta = toMeta(row!);
    const event = await ctx.bus.record(tx, {
      projectId,
      type: 'document.updated',
      payload: meta,
      actor,
    });
    return { meta, event };
  });
  ctx.bus.emit(event);
  // 归档 / 恢复会改变连接的读写权限（握手时决定）：断开在线编辑者，让他们重连拿到新的权限
  if (data.archived !== undefined && data.archived !== Boolean(before.archivedAt)) {
    closeDocumentConnections(ctx, docId);
  }
  return meta;
}

export async function deleteDocument(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
): Promise<void> {
  await getRow(ctx, projectId, docId);
  closeDocumentConnections(ctx, docId);
  const event = await ctx.db.db.transaction(async (tx) => {
    // 子文档挂到上一级
    const [row] = await tx.select().from(documents).where(eq(documents.id, docId));
    await tx
      .update(documents)
      .set({ parentId: row?.parentId ?? null })
      .where(eq(documents.parentId, docId));
    await tx.delete(documents).where(eq(documents.id, docId));
    return ctx.bus.record(tx, {
      projectId,
      type: 'document.deleted',
      payload: { id: docId },
      actor,
    });
  });
  ctx.bus.emit(event);
  forgetCompiled(ctx, docId);
  await clearSharing(ctx, 'document', [docId]);
}

/** 文档和它在同一空间里的全部子孙（按 parentId 广度优先） */
async function subtree(ctx: AppContext, root: Row): Promise<Row[]> {
  const out: Row[] = [root];
  let frontier = [root.id];
  for (let depth = 0; frontier.length && depth < 50; depth += 1) {
    const children = await ctx.db.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.projectId, root.projectId),
          inArray(documents.parentId, frontier),
          eq(documents.space, root.space),
          root.ownerUserId
            ? eq(documents.ownerUserId, root.ownerUserId)
            : isNull(documents.ownerUserId),
        ),
      );
    out.push(...children);
    frontier = children.map((c) => c.id);
  }
  return out;
}

/**
 * 在个人空间和团队空间之间移动（连同子文档一起）。
 * - 个人 → 团队：只有所有者；分享链接与邀请随之作废（团队空间对全体成员可见）。
 * - 团队 → 个人：创建者本人或负责人 / 导师；文档进入操作者的个人空间，其他人立即失去访问。
 * 被移动的文档如果原来挂在别的文档下面，会移到新空间的顶层。
 */
export async function moveDocumentSpace(
  ctx: AppContext,
  actor: ActorRef & { kind: 'user'; id: string },
  role: ProjectRole,
  projectId: string,
  docId: string,
  space: ResourceSpace,
): Promise<DocumentMeta> {
  const row = await getRow(ctx, projectId, docId);
  if (role === 'guest') throw new ApiError('forbidden', '访客不能移动文档');
  if (row.space === space) return toMeta(row);
  if (space === 'team') {
    if (row.ownerUserId !== actor.id)
      throw new ApiError('forbidden', '只有所有者能把它移到团队空间');
  } else {
    const creator = row.createdBy.kind === 'user' && row.createdBy.id === actor.id;
    if (!creator && role !== 'owner' && role !== 'advisor') {
      throw new ApiError('forbidden', '只有创建者或负责人、导师能把团队文档移到个人空间');
    }
  }
  const owner = space === 'personal' ? actor.id : null;
  const moved = await subtree(ctx, row);
  const ids = moved.map((d) => d.id);
  // 先改受众再发事件：移入个人空间后，其他人的连接与事件立即收紧
  for (const id of ids) {
    if (owner) setPersonalAudience(id, owner);
    else clearPersonalAudience(id);
  }
  const now = new Date();
  const events = await ctx.db.db.transaction(async (tx) => {
    const out = [];
    for (const d of moved) {
      const [next] = await tx
        .update(documents)
        .set({
          space,
          ownerUserId: owner,
          ...(d.id === row.id ? { parentId: null } : {}),
          updatedBy: actor,
          updatedAt: now,
        })
        .where(eq(documents.id, d.id))
        .returning();
      out.push(
        await ctx.bus.record(tx, {
          projectId,
          type: 'document.updated',
          payload: toMeta(next!),
          actor,
        }),
      );
    }
    return out;
  });
  for (const ev of events) ctx.bus.emit(ev);
  await clearSharing(ctx, 'document', ids);
  for (const id of ids) closeDocumentConnections(ctx, id);
  await notifySpaceChanged(
    ctx,
    { kind: 'document', id: row.id, projectId, space, ownerUserId: owner },
    actor,
  );
  return toMeta(await getRow(ctx, projectId, docId));
}

/** 结构化编辑（agent 工具、POST P/docs/:docId/edit），作为一次 Yjs 事务应用到在线文档 */
export async function applyDocumentEdit(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  input: z.input<typeof DocumentEdit>,
): Promise<{ meta: DocumentMeta; markdown: string }> {
  const edit = DocumentEdit.parse(input);
  const row = await getRow(ctx, projectId, docId);
  if (row.archivedAt) throw new ApiError('conflict', '文档已归档，恢复后才能修改');
  let before = '';
  const markdown = await withLiveDocument(ctx, docId, actor, (doc) => {
    if (row.kind === 'doc') before = toMarkdown(doc, row.kind);
    applyEdit(doc, row.kind, edit);
    return toMarkdown(doc, row.kind);
  });
  if (row.kind === 'doc') {
    // agent / 脚本写进正文的 @提及：新出现的成员收到提醒
    const old = mentionIdsInMarkdown(before);
    const added = [...mentionIdsInMarkdown(markdown)].filter((id) => !old.has(id));
    if (added.length) {
      await notifyDocMentions(ctx, actor, projectId, docId, { userIds: added.slice(0, 20) });
    }
  }
  return { meta: toMeta(await getRow(ctx, projectId, docId)), markdown };
}

// ---------------------------------------------------------------- 版本

export async function listVersions(ctx: AppContext, projectId: string, docId: string) {
  await getRow(ctx, projectId, docId);
  const rows = await ctx.db.db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, docId))
    .orderBy(desc(documentVersions.createdAt), desc(documentVersions.id));
  return rows.map(versionDto);
}

export async function createVersion(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  input: z.input<typeof DocumentVersionCreateInput>,
): Promise<DocumentVersion> {
  const { label } = DocumentVersionCreateInput.parse(input);
  const row = await getRow(ctx, projectId, docId);
  const doc = await currentYDoc(ctx, row);
  const { dto, event } = await ctx.db.db.transaction(async (tx) => {
    const [v] = await tx
      .insert(documentVersions)
      .values({
        id: newId('documentVersion'),
        documentId: docId,
        label,
        ydocState: Y.encodeStateAsUpdate(doc),
        createdBy: actor,
      })
      .returning();
    const dto = versionDto(v!);
    const event = await ctx.bus.record(tx, {
      projectId,
      type: 'document.version_created',
      payload: dto,
      actor,
    });
    return { dto, event };
  });
  ctx.bus.emit(event);
  return dto;
}

async function versionRow(ctx: AppContext, docId: string, versionId: string) {
  const [v] = await ctx.db.db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, docId)));
  if (!v) notFound('版本');
  return v;
}

export async function readVersion(
  ctx: AppContext,
  projectId: string,
  docId: string,
  versionId: string,
): Promise<{ version: DocumentVersion; markdown: string }> {
  const row = await getRow(ctx, projectId, docId);
  const v = await versionRow(ctx, docId, versionId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, v.ydocState);
  return { version: versionDto(v), markdown: toMarkdown(doc, row.kind) };
}

/** 恢复到某个版本：先自动存一个“恢复前”版本，再把内容整体替换（在线编辑者实时看到） */
export async function restoreVersion(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
  versionId: string,
): Promise<DocumentMeta> {
  const row = await getRow(ctx, projectId, docId);
  const v = await versionRow(ctx, docId, versionId);
  if (row.archivedAt) throw new ApiError('conflict', '文档已归档，恢复后才能修改');
  await createVersion(ctx, actor, projectId, docId, {
    label: `恢复「${v.label}」前自动保存`.slice(0, 80),
  });
  const source = new Y.Doc();
  Y.applyUpdate(source, v.ydocState);
  await withLiveDocument(ctx, docId, actor, (doc) => replaceContent(doc, source, row.kind));
  source.destroy();
  return toMeta(await getRow(ctx, projectId, docId));
}

/** 项目成员可编辑性检查用的辅助：文档数（测试与统计） */
export async function countDocuments(ctx: AppContext, projectId: string): Promise<number> {
  const [r] = await ctx.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.projectId, projectId));
  return r?.n ?? 0;
}
