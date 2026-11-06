import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_LOG_BYTES,
  FEEDBACK_MAX_LOGS,
  newId,
  parseTicketCode,
  ticketCode,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type ChangelogEntry,
  type CreateChangelogInput,
  type FEEDBACK_IMAGE_MIMES,
  type FeedbackContext,
  type FeedbackUserRef,
  type TicketAttachment,
  type TicketDetail,
  type TicketKind,
  type TicketListQuery,
  type TicketMessage,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
  type TicketSummary,
  type UpdateChangelogInput,
  type UpdateTicketInput,
  type UserNotification,
  type UserNotificationKind,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  changelogEntries,
  opsEvents,
  ticketMessages,
  ticketReads,
  tickets,
  ticketVotes,
  userNotifications,
  users,
  type TicketAttachmentMeta,
} from '../../db/schema';

/**
 * 反馈工单、建议投票、更新日志、站内通知的业务逻辑（routes 在 index.ts，admin 模块也复用这里）。
 *
 * 可见性：管理员看全部；普通用户看自己提交的 + 所有「建议」（idea 公开，可投票）。
 * 诊断上下文与诊断日志只给提交人和管理员；其他人只拿到 hiddenLogCount。
 * 对话只有提交人与管理员能发；管理员一方显示为「研协支持」（isStaff）。
 */
export type TicketRow = typeof tickets.$inferSelect;
type MessageRow = typeof ticketMessages.$inferSelect;
type ChangelogRow = typeof changelogEntries.$inferSelect;

export interface Viewer {
  id: string;
  name: string;
  isAdmin: boolean;
}

const OPEN_STATUSES: TicketStatus[] = ['open', 'doing'];
export const ticketHref = (no: number) => `/feedback/${ticketCode(no)}`;

// ---------------------------------------------------------------- 附件

export function feedbackRoot(ctx: AppContext): string {
  return resolve(ctx.config.STORAGE_DIR, 'feedback');
}

export interface PendingUpload {
  kind: 'image' | 'log';
  name: string;
  mime: string;
  data: Buffer;
}

/** 去掉路径、控制字符与引号，保留中文；空了给默认名 */
export function cleanName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/u).pop() ?? '';
  const cleaned = base
    .replace(/[\p{Cc}"<>|*?:]/gu, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** 按文件头判断图片类型（不信任客户端给的 Content-Type） */
export function sniffImage(buf: Buffer): (typeof FEEDBACK_IMAGE_MIMES)[number] | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/u.test(buf.subarray(0, 6).toString('latin1')))
    return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 校验一份上传：files 字段只收图片，logs 字段只收纯文本（不含 NUL） */
export function prepareUpload(
  field: 'files' | 'logs',
  filename: string | undefined,
  data: Buffer,
): PendingUpload {
  if (field === 'logs') {
    if (data.length > FEEDBACK_MAX_LOG_BYTES) {
      throw new ApiError('payload_too_large', '每份诊断日志不能超过 1 MB');
    }
    if (data.includes(0)) {
      throw new ApiError('unsupported_media_type', '诊断日志只能是纯文本文件');
    }
    return { kind: 'log', name: cleanName(filename, 'diagnostics.log'), mime: 'text/plain', data };
  }
  if (data.length > FEEDBACK_MAX_ATTACHMENT_BYTES) {
    throw new ApiError('payload_too_large', '每张截图不能超过 8 MB');
  }
  const mime = sniffImage(data);
  if (!mime) throw new ApiError('unsupported_media_type', '截图只支持 PNG、JPEG、GIF、WebP');
  return { kind: 'image', name: cleanName(filename, `screenshot.${IMAGE_EXT[mime]}`), mime, data };
}

/** 一次提交里的数量限制（图片 ≤ 5、日志 ≤ 3） */
export function assertUploadCounts(uploads: PendingUpload[]): void {
  if (uploads.filter((u) => u.kind === 'image').length > FEEDBACK_MAX_ATTACHMENTS) {
    throw new ApiError('payload_too_large', `一次最多 ${FEEDBACK_MAX_ATTACHMENTS} 张截图`);
  }
  if (uploads.filter((u) => u.kind === 'log').length > FEEDBACK_MAX_LOGS) {
    throw new ApiError('payload_too_large', `一次最多 ${FEEDBACK_MAX_LOGS} 份诊断日志`);
  }
}

export async function saveUploads(
  ctx: AppContext,
  ticketId: string,
  uploads: PendingUpload[],
): Promise<TicketAttachmentMeta[]> {
  const root = feedbackRoot(ctx);
  const out: TicketAttachmentMeta[] = [];
  for (const u of uploads) {
    const id = newId('file');
    const rel = `${ticketId}/${id}.${u.kind === 'log' ? 'txt' : IMAGE_EXT[u.mime]}`;
    const abs = resolve(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, u.data);
    out.push({ id, kind: u.kind, name: u.name, mime: u.mime, size: u.data.length, path: rel });
  }
  return out;
}

/** 写库失败时清掉刚存的文件（尽力而为） */
export async function discardUploads(
  ctx: AppContext,
  metas: TicketAttachmentMeta[],
): Promise<void> {
  for (const m of metas)
    await rm(resolve(feedbackRoot(ctx), m.path), { force: true }).catch(() => undefined);
}

/** 附件的磁盘绝对路径；越界返回 null */
export function attachmentPath(ctx: AppContext, meta: TicketAttachmentMeta): string | null {
  const root = feedbackRoot(ctx);
  const abs = resolve(root, meta.path);
  return abs.startsWith(root + sep) ? abs : null;
}

/** 在工单本体与全部回复里找附件 */
export async function findAttachment(
  ctx: AppContext,
  t: TicketRow,
  attachmentId: string,
): Promise<TicketAttachmentMeta | null> {
  const msgs = await ctx.db.db
    .select({ attachments: ticketMessages.attachments })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, t.id));
  return (
    [...t.attachments, ...msgs.flatMap((m) => m.attachments)].find((a) => a.id === attachmentId) ??
    null
  );
}

function toAttachment(no: number, m: TicketAttachmentMeta): TicketAttachment {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    mime: m.mime,
    size: m.size,
    url: `/api/v1/feedback/tickets/${no}/attachments/${m.id}`,
  };
}

// ---------------------------------------------------------------- 权限

export const isReporter = (t: TicketRow, v: Viewer) => t.reporterUserId === v.id;
/** 能看这张工单：管理员、提交人，或公开的建议 */
export const canView = (t: TicketRow, v: Viewer) =>
  v.isAdmin || isReporter(t, v) || t.kind === 'idea';
/** 能看诊断上下文 / 诊断日志 / 能在对话里发言 */
export const isParty = (t: TicketRow, v: Viewer) => v.isAdmin || isReporter(t, v);

export async function ticketByNo(ctx: AppContext, rawNo: string): Promise<TicketRow> {
  const no = parseTicketCode(rawNo);
  if (no === null) throw new ApiError('not_found', '工单不存在');
  const [row] = await ctx.db.db.select().from(tickets).where(eq(tickets.no, no));
  if (!row) throw new ApiError('not_found', '工单不存在');
  return row;
}

/** 看不到的工单一律 404（不泄露存在与否） */
export async function viewableTicket(
  ctx: AppContext,
  rawNo: string,
  v: Viewer,
): Promise<TicketRow> {
  const row = await ticketByNo(ctx, rawNo);
  if (!canView(row, v)) throw new ApiError('not_found', '工单不存在');
  return row;
}

// ---------------------------------------------------------------- 序列化

export async function userRefs(
  db: Db,
  ids: (string | null | undefined)[],
): Promise<Map<string, FeedbackUserRef>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, FeedbackUserRef>();
  if (uniq.length === 0) return map;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      avatarColor: users.avatarColor,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, uniq));
  for (const r of rows) map.set(r.id, r);
  return map;
}

function isWaiting(t: TicketRow, v: Viewer): boolean {
  if (!OPEN_STATUSES.includes(t.status)) return false;
  if (v.isAdmin) return t.lastReplyBy === 'user';
  return isReporter(t, v) && t.lastReplyBy === 'admin';
}

function isUnread(t: TicketRow, v: Viewer, readAt: Date | undefined): boolean {
  const peerSide = v.isAdmin ? 'user' : isReporter(t, v) ? 'admin' : null;
  if (!peerSide || t.lastReplyBy !== peerSide) return false;
  return !readAt || t.lastReplyAt > readAt;
}

async function summaries(ctx: AppContext, rows: TicketRow[], v: Viewer): Promise<TicketSummary[]> {
  if (rows.length === 0) return [];
  const db = ctx.db.db;
  const ids = rows.map((r) => r.id);
  const [refs, votes, reads] = await Promise.all([
    userRefs(
      db,
      rows.flatMap((r) => [r.reporterUserId, r.assigneeUserId]),
    ),
    db
      .select({ ticketId: ticketVotes.ticketId })
      .from(ticketVotes)
      .where(and(eq(ticketVotes.userId, v.id), inArray(ticketVotes.ticketId, ids))),
    db
      .select({ ticketId: ticketReads.ticketId, at: ticketReads.lastReadAt })
      .from(ticketReads)
      .where(and(eq(ticketReads.userId, v.id), inArray(ticketReads.ticketId, ids))),
  ]);
  const voted = new Set(votes.map((x) => x.ticketId));
  const readMap = new Map(reads.map((x) => [x.ticketId, x.at]));
  return rows.map((t) => ({
    id: t.id,
    no: t.no,
    code: ticketCode(t.no),
    kind: t.kind,
    title: t.title,
    status: t.status,
    priority: t.priority,
    roadmap: t.roadmap,
    source: t.source,
    reporter: (t.reporterUserId && refs.get(t.reporterUserId)) || null,
    assignee: (t.assigneeUserId && refs.get(t.assigneeUserId)) || null,
    projectId: t.projectId,
    voteCount: t.voteCount,
    voted: voted.has(t.id),
    lastReplyBy: t.lastReplyBy,
    lastReplyAt: t.lastReplyAt.toISOString(),
    unread: isUnread(t, v, readMap.get(t.id)),
    waiting: isWaiting(t, v),
    mine: isReporter(t, v),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  }));
}

export async function ticketDetail(
  ctx: AppContext,
  t: TicketRow,
  v: Viewer,
): Promise<TicketDetail> {
  const db = ctx.db.db;
  const party = isParty(t, v);
  const [summary] = await summaries(ctx, [t], v);
  const msgs = await db
    .select()
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, t.id))
    .orderBy(ticketMessages.createdAt, ticketMessages.id);
  const refs = await userRefs(
    db,
    msgs.map((m) => m.authorUserId),
  );
  let hidden = 0;
  const visible = (list: TicketAttachmentMeta[]) =>
    list.filter((a) => {
      if (a.kind === 'log' && !party) {
        hidden += 1;
        return false;
      }
      return true;
    });
  const attachments = visible(t.attachments).map((a) => toAttachment(t.no, a));
  const messages: TicketMessage[] = msgs.map((m: MessageRow) => ({
    id: m.id,
    ticketId: m.ticketId,
    author: (m.authorUserId && refs.get(m.authorUserId)) || null,
    isStaff: m.isStaff,
    isSystem: m.isSystem,
    body: m.body,
    attachments: visible(m.attachments).map((a) => toAttachment(t.no, a)),
    createdAt: m.createdAt.toISOString(),
  }));
  const [ops] = await db
    .select({ id: opsEvents.id })
    .from(opsEvents)
    .where(eq(opsEvents.ticketId, t.id))
    .limit(1);
  return {
    ...summary!,
    body: t.body,
    context: party ? (t.context ?? null) : null,
    attachments,
    hiddenLogCount: hidden,
    messages,
    peerReadAt: await peerReadAt(ctx, t, v),
    opsEventId: ops?.id ?? null,
  };
}

/** 对方最后读到的时间：提交人看管理员一方（任一管理员），管理员看提交人 */
async function peerReadAt(ctx: AppContext, t: TicketRow, v: Viewer): Promise<string | null> {
  const db = ctx.db.db;
  if (v.isAdmin) {
    if (!t.reporterUserId || t.reporterUserId === v.id) return null;
    const [r] = await db
      .select({ at: ticketReads.lastReadAt })
      .from(ticketReads)
      .where(and(eq(ticketReads.ticketId, t.id), eq(ticketReads.userId, t.reporterUserId)));
    return r?.at.toISOString() ?? null;
  }
  if (!isReporter(t, v)) return null;
  const [r] = await db
    .select({ at: sql<Date | string | null>`max(${ticketReads.lastReadAt})` })
    .from(ticketReads)
    .innerJoin(users, eq(users.id, ticketReads.userId))
    .where(
      and(eq(ticketReads.ticketId, t.id), eq(users.isAdmin, true), ne(ticketReads.userId, v.id)),
    );
  return r?.at ? new Date(r.at).toISOString() : null;
}

// ---------------------------------------------------------------- 通知

export async function notify(
  db: Db,
  userIds: (string | null | undefined)[],
  kind: UserNotificationKind,
  title: string,
  href: string,
): Promise<void> {
  const uniq = [...new Set(userIds.filter((x): x is string => !!x))];
  if (uniq.length === 0) return;
  await db.insert(userNotifications).values(
    uniq.map((userId) => ({
      id: newId('userNotification'),
      userId,
      kind,
      title: title.slice(0, 300),
      href,
    })),
  );
}

async function adminIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
  return rows.map((r) => r.id);
}

export async function listNotifications(
  ctx: AppContext,
  userId: string,
  opts: { unreadOnly: boolean; limit: number },
): Promise<{ items: UserNotification[]; unread: number }> {
  const db = ctx.db.db;
  const where = opts.unreadOnly
    ? and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt))
    : eq(userNotifications.userId, userId);
  const rows = await db
    .select()
    .from(userNotifications)
    .where(where)
    .orderBy(desc(userNotifications.createdAt), desc(userNotifications.id))
    .limit(opts.limit);
  const [c] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt)));
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      href: r.href,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    unread: c?.n ?? 0,
  };
}

export async function markNotificationsRead(
  ctx: AppContext,
  userId: string,
  ids: string[] | null,
): Promise<void> {
  const base = and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt));
  await ctx.db.db
    .update(userNotifications)
    .set({ readAt: new Date() })
    .where(ids ? and(base, inArray(userNotifications.id, ids.length ? ids : ['__none__'])) : base);
}

/** 打开工单：记已读，并把指向这张工单的通知标为已读 */
export async function markTicketRead(ctx: AppContext, t: TicketRow, userId: string): Promise<void> {
  const db = ctx.db.db;
  const now = new Date();
  await db
    .insert(ticketReads)
    .values({ ticketId: t.id, userId, lastReadAt: now })
    .onConflictDoUpdate({
      target: [ticketReads.ticketId, ticketReads.userId],
      set: { lastReadAt: now },
    });
  await db
    .update(userNotifications)
    .set({ readAt: now })
    .where(
      and(
        eq(userNotifications.userId, userId),
        eq(userNotifications.href, ticketHref(t.no)),
        isNull(userNotifications.readAt),
      ),
    );
}

// ---------------------------------------------------------------- 工单

const escapeLike = (s: string) => s.replace(/[\\%_]/gu, (c) => `\\${c}`);

export async function listTickets(
  ctx: AppContext,
  v: Viewer,
  q: TicketListQuery,
): Promise<TicketSummary[]> {
  const conds: (SQL | undefined)[] = [];
  if (q.scope === 'mine') conds.push(eq(tickets.reporterUserId, v.id));
  else if (q.scope === 'waiting') {
    conds.push(inArray(tickets.status, OPEN_STATUSES));
    if (v.isAdmin) conds.push(eq(tickets.lastReplyBy, 'user'));
    else conds.push(eq(tickets.reporterUserId, v.id), eq(tickets.lastReplyBy, 'admin'));
  } else if (!v.isAdmin) {
    conds.push(or(eq(tickets.reporterUserId, v.id), eq(tickets.kind, 'idea')));
  }
  if (q.status) {
    const list = q.status
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is TicketStatus => s in TICKET_STATUS_LABEL);
    if (list.length) conds.push(inArray(tickets.status, list));
  }
  if (q.kind) conds.push(eq(tickets.kind, q.kind));
  if (q.roadmap) conds.push(eq(tickets.roadmap, q.roadmap));
  if (q.assignee && v.isAdmin) {
    if (q.assignee === 'none') conds.push(isNull(tickets.assigneeUserId));
    else conds.push(eq(tickets.assigneeUserId, q.assignee === 'me' ? v.id : q.assignee));
  }
  const text = q.q?.trim();
  if (text) {
    const no = parseTicketCode(text);
    const pat = `%${escapeLike(text)}%`;
    conds.push(
      no !== null
        ? or(eq(tickets.no, no), ilike(tickets.title, pat))
        : or(ilike(tickets.title, pat), ilike(tickets.body, pat)),
    );
  }
  const order =
    q.sort === 'votes'
      ? [desc(tickets.voteCount), desc(tickets.updatedAt)]
      : [desc(tickets.updatedAt), desc(tickets.no)];
  const rows = await ctx.db.db
    .select()
    .from(tickets)
    .where(and(...conds))
    .orderBy(...order)
    .limit(q.limit);
  return summaries(ctx, rows, v);
}

export interface NewTicket {
  kind: TicketKind;
  title: string;
  body: string;
  projectId: string | null;
  context: FeedbackContext | null;
  priority?: TicketPriority;
  source?: TicketSource;
}

/** 建工单（附件先存盘再写库，失败时清掉文件）；新工单通知所有管理员 */
export async function createTicket(
  ctx: AppContext,
  v: Viewer,
  input: NewTicket,
  uploads: PendingUpload[] = [],
): Promise<TicketRow> {
  const id = newId('ticket');
  const metas = await saveUploads(ctx, id, uploads);
  let row: TicketRow | undefined;
  try {
    [row] = await ctx.db.db
      .insert(tickets)
      .values({
        id,
        kind: input.kind,
        title: input.title.trim(),
        body: input.body,
        projectId: input.projectId,
        context: input.context,
        priority: v.isAdmin && input.priority ? input.priority : 'normal',
        source: input.source ?? 'feedback',
        reporterUserId: v.id,
        attachments: metas,
        lastReplyBy: 'user',
      })
      .returning();
  } catch (err) {
    await discardUploads(ctx, metas);
    throw err;
  }
  if (!row) throw new ApiError('internal', '创建工单失败');
  const admins = (await adminIds(ctx.db.db)).filter((x) => x !== v.id);
  await notify(
    ctx.db.db,
    admins,
    'ticket_new',
    `新反馈 ${ticketCode(row.no)}：${row.title}`,
    ticketHref(row.no),
  );
  return row;
}

async function systemMessage(db: Db, ticketId: string, body: string): Promise<void> {
  await db
    .insert(ticketMessages)
    .values({ id: newId('ticketMessage'), ticketId, isSystem: true, body });
}

export async function addMessage(
  ctx: AppContext,
  t: TicketRow,
  v: Viewer,
  body: string,
  uploads: PendingUpload[],
): Promise<TicketRow> {
  if (!isParty(t, v)) throw new ApiError('forbidden', '只有提交人和管理员能在这张工单里回复');
  const db = ctx.db.db;
  const staff = v.isAdmin;
  const metas = await saveUploads(ctx, t.id, uploads);
  const now = new Date();
  // 提交人在已完成 / 已关闭的工单里回复：重新打开
  const reopen = !staff && !OPEN_STATUSES.includes(t.status);
  try {
    await db.insert(ticketMessages).values({
      id: newId('ticketMessage'),
      ticketId: t.id,
      authorUserId: v.id,
      isStaff: staff,
      body,
      attachments: metas,
      createdAt: now,
    });
  } catch (err) {
    await discardUploads(ctx, metas);
    throw err;
  }
  if (reopen) await systemMessage(db, t.id, '提交人追加了回复，工单重新打开');
  const [row] = await db
    .update(tickets)
    .set({
      lastReplyBy: staff ? 'admin' : 'user',
      lastReplyAt: now,
      updatedAt: now,
      ...(reopen ? { status: 'open' as const, closedAt: null } : {}),
    })
    .where(eq(tickets.id, t.id))
    .returning();
  await markTicketRead(ctx, row!, v.id);
  const code = ticketCode(t.no);
  if (staff) {
    if (t.reporterUserId !== v.id) {
      await notify(
        db,
        [t.reporterUserId],
        'ticket_reply',
        `研协支持回复了 ${code}：${t.title}`,
        ticketHref(t.no),
      );
    }
  } else {
    const targets = t.assigneeUserId ? [t.assigneeUserId] : await adminIds(db);
    await notify(
      db,
      targets.filter((x) => x !== v.id),
      'ticket_user_reply',
      `${v.name} 回复了 ${code}：${t.title}`,
      ticketHref(t.no),
    );
  }
  return row!;
}

export async function updateTicket(
  ctx: AppContext,
  t: TicketRow,
  v: Viewer,
  input: UpdateTicketInput,
): Promise<TicketRow> {
  const db = ctx.db.db;
  if (!v.isAdmin) {
    if (!isReporter(t, v)) throw new ApiError('forbidden', '只有管理员能修改这张工单');
    const keys = Object.keys(input);
    if (keys.some((k) => k !== 'status') || input.status !== 'closed') {
      throw new ApiError('forbidden', '提交人只能关闭自己的工单');
    }
  }
  const patch: Partial<typeof tickets.$inferInsert> = {};
  const notes: string[] = [];
  const who = v.isAdmin ? '研协支持' : '提交人';
  if (input.status && input.status !== t.status) {
    patch.status = input.status;
    patch.closedAt = OPEN_STATUSES.includes(input.status) ? null : new Date();
    notes.push(
      `${who}把状态从「${TICKET_STATUS_LABEL[t.status]}」改为「${TICKET_STATUS_LABEL[input.status]}」`,
    );
  }
  if (input.priority && input.priority !== t.priority) {
    patch.priority = input.priority;
    notes.push(`优先级改为「${TICKET_PRIORITY_LABEL[input.priority]}」`);
  }
  if (input.roadmap && input.roadmap !== t.roadmap) patch.roadmap = input.roadmap;
  if (input.title && input.title !== t.title) patch.title = input.title;
  if (input.kind && input.kind !== t.kind) patch.kind = input.kind;
  let newAssignee: string | null | undefined;
  if (input.assigneeUserId !== undefined && input.assigneeUserId !== t.assigneeUserId) {
    if (input.assigneeUserId) {
      const [a] = await db
        .select({ id: users.id, name: users.name, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, input.assigneeUserId));
      if (!a || !a.isAdmin) throw new ApiError('validation_failed', '负责人必须是管理员');
      notes.push(`负责人改为 ${a.name}`);
    } else {
      notes.push('取消了负责人');
    }
    patch.assigneeUserId = input.assigneeUserId;
    newAssignee = input.assigneeUserId;
  }
  if (Object.keys(patch).length === 0) return t;
  patch.updatedAt = new Date();
  const [row] = await db.update(tickets).set(patch).where(eq(tickets.id, t.id)).returning();
  for (const n of notes) await systemMessage(db, t.id, n);
  const code = ticketCode(t.no);
  if (patch.status && t.reporterUserId && t.reporterUserId !== v.id) {
    await notify(
      db,
      [t.reporterUserId],
      'ticket_status',
      `${code} 状态更新为「${TICKET_STATUS_LABEL[patch.status]}」：${row!.title}`,
      ticketHref(t.no),
    );
  }
  if (newAssignee && newAssignee !== v.id) {
    await notify(
      db,
      [newAssignee],
      'ticket_assigned',
      `${code} 指派给了你：${row!.title}`,
      ticketHref(t.no),
    );
  }
  return row!;
}

export async function setVote(ctx: AppContext, t: TicketRow, v: Viewer, on: boolean) {
  if (t.kind !== 'idea') throw new ApiError('bad_request', '只有「功能建议」可以投票');
  const db = ctx.db.db;
  if (on)
    await db.insert(ticketVotes).values({ ticketId: t.id, userId: v.id }).onConflictDoNothing();
  else
    await db
      .delete(ticketVotes)
      .where(and(eq(ticketVotes.ticketId, t.id), eq(ticketVotes.userId, v.id)));
  const [row] = await db
    .update(tickets)
    .set({
      voteCount: sql`(select count(*) from ${ticketVotes} where ${ticketVotes.ticketId} = ${t.id})::int`,
    })
    .where(eq(tickets.id, t.id))
    .returning({ voteCount: tickets.voteCount });
  return { voteCount: row?.voteCount ?? 0, voted: on };
}

export const listViewable = summaries;

// ---------------------------------------------------------------- 更新日志

async function changelogDtos(ctx: AppContext, rows: ChangelogRow[]): Promise<ChangelogEntry[]> {
  const db = ctx.db.db;
  const tids = [...new Set(rows.flatMap((r) => r.ticketIds))];
  const trows = tids.length
    ? await db
        .select({ id: tickets.id, no: tickets.no, title: tickets.title, kind: tickets.kind })
        .from(tickets)
        .where(inArray(tickets.id, tids))
    : [];
  const tmap = new Map(trows.map((x) => [x.id, x]));
  const refs = await userRefs(
    db,
    rows.map((r) => r.authorUserId),
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    body: r.body,
    tags: r.tags,
    tickets: r.ticketIds
      .map((id) => tmap.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => ({ ...x, code: ticketCode(x.no) })),
    prUrl: r.prUrl,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    author: (r.authorUserId && refs.get(r.authorUserId)) || null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function listChangelog(
  ctx: AppContext,
  includeDrafts: boolean,
): Promise<ChangelogEntry[]> {
  const rows = await ctx.db.db
    .select()
    .from(changelogEntries)
    .where(includeDrafts ? undefined : sql`${changelogEntries.publishedAt} is not null`)
    .orderBy(desc(sql`coalesce(${changelogEntries.publishedAt}, ${changelogEntries.createdAt})`))
    .limit(200);
  return changelogDtos(ctx, rows);
}

async function ticketIdsForNos(ctx: AppContext, nos: number[]): Promise<string[]> {
  if (nos.length === 0) return [];
  const uniq = [...new Set(nos)];
  const rows = await ctx.db.db
    .select({ id: tickets.id, no: tickets.no })
    .from(tickets)
    .where(inArray(tickets.no, uniq));
  const found = new Map(rows.map((r) => [r.no, r.id]));
  const missing = uniq.filter((n) => !found.has(n));
  if (missing.length) {
    throw new ApiError('validation_failed', `找不到工单 ${missing.map(ticketCode).join('、')}`, {
      issues: [{ path: 'ticketNos', message: '工单不存在' }],
    });
  }
  return uniq.map((n) => found.get(n)!);
}

/** 发布：关联工单置为已完成（建议同时标为已上线），写系统消息并通知提交人 */
async function applyPublish(
  ctx: AppContext,
  entry: ChangelogRow,
  ticketIds: string[],
): Promise<void> {
  if (ticketIds.length === 0) return;
  const db = ctx.db.db;
  const rows = await db.select().from(tickets).where(inArray(tickets.id, ticketIds));
  const label = entry.version ? `${entry.version}「${entry.title}」` : `「${entry.title}」`;
  for (const t of rows) {
    const now = new Date();
    await db
      .update(tickets)
      .set({
        status: 'done',
        closedAt: t.closedAt ?? now,
        updatedAt: now,
        ...(t.kind === 'idea' ? { roadmap: 'shipped' as const } : {}),
      })
      .where(eq(tickets.id, t.id));
    await systemMessage(db, t.id, `已随更新 ${label} 上线，工单自动标为已完成`);
    await notify(
      db,
      [t.reporterUserId],
      'changelog',
      `你反馈的 ${ticketCode(t.no)} 已上线：${t.title}`,
      ticketHref(t.no),
    );
  }
}

export async function createChangelog(
  ctx: AppContext,
  v: Viewer,
  input: CreateChangelogInput,
): Promise<ChangelogEntry> {
  const ticketIds = await ticketIdsForNos(ctx, input.ticketNos);
  const [row] = await ctx.db.db
    .insert(changelogEntries)
    .values({
      id: newId('changelog'),
      version: input.version,
      title: input.title,
      body: input.body,
      tags: input.tags,
      ticketIds,
      prUrl: input.prUrl ?? null,
      publishedAt: input.publish ? new Date() : null,
      authorUserId: v.id,
    })
    .returning();
  if (input.publish) await applyPublish(ctx, row!, ticketIds);
  return (await changelogDtos(ctx, [row!]))[0]!;
}

export async function updateChangelog(
  ctx: AppContext,
  id: string,
  input: UpdateChangelogInput,
): Promise<ChangelogEntry> {
  const db = ctx.db.db;
  const [cur] = await db.select().from(changelogEntries).where(eq(changelogEntries.id, id));
  if (!cur) throw new ApiError('not_found', '更新日志不存在');
  const ticketIds = input.ticketNos ? await ticketIdsForNos(ctx, input.ticketNos) : cur.ticketIds;
  const publishing = input.publish === true && !cur.publishedAt;
  const [row] = await db
    .update(changelogEntries)
    .set({
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
      ticketIds,
      ...(publishing ? { publishedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(changelogEntries.id, id))
    .returning();
  if (publishing) await applyPublish(ctx, row!, ticketIds);
  else if (cur.publishedAt) {
    // 已发布的条目新关联的工单也要走一遍上线流程
    const added = ticketIds.filter((x) => !cur.ticketIds.includes(x));
    await applyPublish(ctx, row!, added);
  }
  return (await changelogDtos(ctx, [row!]))[0]!;
}

export async function deleteChangelog(ctx: AppContext, id: string): Promise<void> {
  const rows = await ctx.db.db
    .delete(changelogEntries)
    .where(eq(changelogEntries.id, id))
    .returning({ id: changelogEntries.id });
  if (rows.length === 0) throw new ApiError('not_found', '更新日志不存在');
}
