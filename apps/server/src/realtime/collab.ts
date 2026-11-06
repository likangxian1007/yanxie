import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { Hocuspocus, type Document } from '@hocuspocus/server';
import {
  COLLAB_PATH,
  WS_CLOSE,
  type AccessLevel,
  type ActorRef,
  type ProjectRole,
} from '@srh/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context';
import { agentSessions, projects, users } from '../db/schema';
import { isDevAnonymous } from '../modules/collab-common/guard';
import { watchApiTokenSocket } from '../modules/integrations/service';
import { isAllowedOrigin } from './access';

/**
 * /collab/:documentId：协同文档的 Yjs 通道（Hocuspocus 协议）。
 *
 * - 握手时用 ctx.access 识别用户（Cookie），再查文档所属项目的成员角色：
 *   未登录 4401，非成员 / 文档不存在 4404，访客（guest）只读。个人空间文档按分享权限
 *   （storage.access）：无权 4404，可阅读 / 可评论只读，可编辑可写；分享设置一变就断开重连。
 * - onLoadDocument 从 documents.ydoc_state 读；onStoreDocument（防抖 2s，最长 10s）写回、
 *   更新 content_text，并发 document.updated（由 documents 模块注入的 storage.persist 完成）。
 * - agent 与 REST 的结构化编辑走 withLiveDocument：在服务端 Y.Doc 上开事务，
 *   在线编辑者实时看到，与人的编辑自然合并。
 */
export interface CollabConnectionContext {
  docId: string;
  projectId: string;
  actor: ActorRef;
  role: ProjectRole;
  /** 访客或文档已归档：只读连接 */
  readOnly?: boolean;
}

export interface CollabStorage {
  /** 读取文档所属项目与持久化状态；不存在返回 null */
  load(docId: string): Promise<{
    projectId: string;
    state: Uint8Array | null;
    archived?: boolean;
    kind?: string;
    /** 子文档继承的资源权限，例如笔记所属论文。 */
    resourceId?: string;
  } | null>;
  /** 载入后、发给客户端前整理结构（例如表格旧结构的惰性迁移）；可选 */
  prepare?(doc: Y.Doc, kind: string | undefined): void;
  /** 用户在项目里的角色；不是成员返回 null */
  role(projectId: string, userId: string): Promise<ProjectRole | null>;
  /**
   * 资源级权限（个人 / 团队空间与分享，见 modules/sharing）：给了就以它为准——
   * none → 4404；view / comment → 只读；edit / manage → 可写。不给就按 role（notebook 等）。
   */
  access?(docId: string, userId: string): Promise<AccessLevel>;
  validateUpdate?(doc: Y.Doc, update: Uint8Array): void;
  changed?(doc: Y.Doc, actor: ActorRef): void;
  /** 持久化（写库 + 发事件） */
  persist(docId: string, doc: Y.Doc, actor: ActorRef): Promise<void>;
}

interface CollabHub {
  hocuspocus: Hocuspocus<CollabConnectionContext>;
  /** 每篇文档最后一次落库内容的哈希，没变就不重复写库 */
  lastHash: Map<string, string>;
}

const hubs = new WeakMap<AppContext, CollabHub>();
const storages = new WeakMap<AppContext, Map<string, CollabStorage>>();

/**
 * 各模块在 register() 里注入自己的 Y.Doc 读写实现，按 id 前缀分派：
 * documents 模块注册 'doc'（默认），notebooks 模块注册 'nb'。
 */
export function setCollabStorage(ctx: AppContext, storage: CollabStorage, prefix = 'doc') {
  let byPrefix = storages.get(ctx);
  if (!byPrefix) {
    byPrefix = new Map();
    storages.set(ctx, byPrefix);
  }
  byPrefix.set(prefix, storage);
}

function storageOf(ctx: AppContext, docId: string): CollabStorage {
  const byPrefix = storages.get(ctx);
  const prefix = docId.includes('_') ? docId.slice(0, docId.indexOf('_')) : 'doc';
  const s = byPrefix?.get(prefix) ?? byPrefix?.get('doc');
  if (!s) throw new Error('协同文档存储没有注册（documents 模块未加载）');
  return s;
}

function hashState(doc: Y.Doc): string {
  return createHash('sha1').update(Y.encodeStateAsUpdate(doc)).digest('base64');
}

const SYSTEM: ActorRef = { kind: 'system', id: null, name: '研协' };

/**
 * 在服务端的在线文档上执行一次修改（没人打开时临时从库里加载）。
 * fn 在一个 Yjs 事务里运行，返回后立即持久化并发 document.updated。
 */
export async function withLiveDocument<T>(
  ctx: AppContext,
  docId: string,
  actor: ActorRef,
  fn: (doc: Y.Doc) => T,
): Promise<T> {
  const hub = hubs.get(ctx);
  if (!hub) throw new Error('协同服务没有初始化');
  const conn = await hub.hocuspocus.openDirectConnection(docId, {
    docId,
    projectId: '',
    actor,
    role: 'member',
  });
  let result: T | undefined;
  let error: unknown;
  try {
    const document = conn.document;
    const agentName =
      document && actor.kind === 'agent' ? await agentDisplayName(ctx, actor) : null;
    // agent 写入前先出现在 awareness（头像），写完再把光标放到它最后写入的位置
    if (document && agentName) showAgentPresence(document, actor, agentName, null);
    const before = document ? Y.getState(document.store, document.clientID) : 0;
    await conn.transact((doc) => {
      try {
        result = fn(doc);
      } catch (err) {
        error = err;
      }
    });
    if (error) throw error;
    if (document && agentName) {
      showAgentPresence(document, actor, agentName, lastInsertCursor(document, before));
    }
    if (document) {
      const persistedHash = hashState(document);
      await storageOf(ctx, docId).persist(docId, document, actor);
      // 保存过程中仍可能收到新编辑；只标记本次开始保存的状态，下一次继续写入。
      hub.lastHash.set(docId, persistedHash);
    }
  } finally {
    await conn.disconnect();
  }
  return result as T;
}

export interface LiveDocumentHandle {
  doc: Y.Doc;
  /** 在 Yjs 事务里修改（在线客户端实时看到）；不落库 */
  transact(fn: (doc: Y.Doc) => void): Promise<void>;
  /** 落库（有变化才写） */
  persist(): Promise<void>;
  /** 落库并释放连接 */
  close(): Promise<void>;
}

/**
 * 长时间持有的服务端连接（notebook 执行时流式写输出用）。
 * 与 withLiveDocument 不同：每次 transact 不落库，由调用方在合适的时候 persist / close。
 */
export async function openLiveDocument(
  ctx: AppContext,
  docId: string,
  actor: ActorRef,
): Promise<LiveDocumentHandle> {
  const hub = hubs.get(ctx);
  if (!hub) throw new Error('协同服务没有初始化');
  const conn = await hub.hocuspocus.openDirectConnection(docId, {
    docId,
    projectId: '',
    actor,
    role: 'member',
  });
  const doc = conn.document;
  if (!doc) {
    await conn.disconnect();
    throw new Error('document not found');
  }
  let closed = false;
  const persist = async () => {
    const hash = hashState(doc);
    if (hub.lastHash.get(docId) === hash) return;
    await storageOf(ctx, docId).persist(docId, doc, actor);
    hub.lastHash.set(docId, hash);
  };
  return {
    doc,
    async transact(fn) {
      if (closed) throw new Error('live document closed');
      await conn.transact(fn);
    },
    persist,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await persist();
      } finally {
        await conn.disconnect();
      }
    },
  };
}

/** 已在内存里的在线文档（有人正在编辑）；没有返回 null */
export function liveDocument(ctx: AppContext, docId: string): Y.Doc | null {
  return hubs.get(ctx)?.hocuspocus.documents.get(docId) ?? null;
}

/** 文档被删除 / 归档 / 恢复时：断开所有在线连接（客户端重连时按新状态重新鉴权） */
export function closeDocumentConnections(ctx: AppContext, docId: string) {
  hubs.get(ctx)?.hocuspocus.closeConnections(docId);
}

/** 某篇文档当前的在线连接（谁、是否只读）；排障与测试用 */
export function documentConnections(
  ctx: AppContext,
  docId: string,
): { userId: string | null; readOnly: boolean }[] {
  const document = hubs.get(ctx)?.hocuspocus.documents.get(docId);
  if (!document) return [];
  return document.getConnections().map((connection) => {
    const c = connection.context as CollabConnectionContext | undefined;
    return { userId: c?.actor.id ?? null, readOnly: connection.readOnly };
  });
}

/**
 * 成员被移出或角色变化时：断开该用户在这个项目里的所有协同连接。
 * 读写权限是握手时定的，重连会按新角色重新鉴权（被移出 → 4404，降为访客 → 只读）。
 */
export function closeUserConnections(ctx: AppContext, projectId: string, userId: string) {
  const hub = hubs.get(ctx);
  if (!hub) return;
  hub.hocuspocus.documents.forEach((document) => {
    for (const connection of document.getConnections()) {
      const c = connection.context as CollabConnectionContext | undefined;
      if (c?.projectId === projectId && c.actor.kind === 'user' && c.actor.id === userId) {
        // 与 hocuspocus.closeConnections 用同一个关闭事件（@hocuspocus/common 的 ResetConnection）
        connection.close({ code: 4205, reason: 'Reset Connection' });
      }
    }
  });
}

/** 项目归档后，所有文档和 Notebook 的在线连接都必须停止。 */
function closeProjectConnections(ctx: AppContext, projectId: string) {
  const hub = hubs.get(ctx);
  if (!hub) return;
  hub.hocuspocus.documents.forEach((document) => {
    for (const connection of document.getConnections()) {
      const c = connection.context as CollabConnectionContext | undefined;
      if (c?.projectId === projectId) connection.close({ code: 4205, reason: 'Reset Connection' });
    }
  });
}

const agentTimers = new WeakMap<Document, ReturnType<typeof setTimeout>>();

/** agent 写入后在 awareness 里停留多久（API.md §3.2） */
export const AGENT_PRESENCE_MS = 6000;

/** awareness 里的光标（y-prosemirror / y-codemirror 通用：两端都是 Y.RelativePosition 的 JSON） */
export interface AwarenessCursor {
  anchor: unknown;
  head: unknown;
}

/**
 * agent 的显示名：「张三的 agent」（会话代表的成员），协调者没有代表的人时用 actor.name。
 * 查不到就退回 actor.name，不影响写入。
 */
async function agentDisplayName(ctx: AppContext, actor: ActorRef): Promise<string> {
  if (!actor.id) return actor.name;
  try {
    const [row] = await ctx.db.db
      .select({ owner: users.name })
      .from(agentSessions)
      .innerJoin(users, eq(users.id, agentSessions.workingForUserId))
      .where(eq(agentSessions.id, actor.id));
    return row?.owner ? `${row.owner}的 agent` : actor.name;
  } catch {
    return actor.name;
  }
}

/**
 * 本次事务里服务端写入的最后一个字符之后的位置（RelativePosition JSON），作为 agent 的光标。
 * 只认这次新插入、没被删掉、可计数的内容；找不到返回 null（只显示头像）。
 */
export function lastInsertCursor(doc: Y.Doc, beforeClock: number): AwarenessCursor | null {
  const structs = doc.store.clients.get(doc.clientID);
  if (!structs) return null;
  // 优先文字（光标落在最后写的那个字后面），其次块级元素
  let fallback: Y.Item | null = null;
  let target: Y.Item | null = null;
  for (let i = structs.length - 1; i >= 0; i -= 1) {
    const s = structs[i]!;
    if (s.id.clock + s.length <= beforeClock) break;
    // Map 里的条目（parentSub 非空）不是正文位置
    if (!(s instanceof Y.Item) || s.deleted || !s.countable || s.parentSub !== null) continue;
    if (!(s.parent instanceof Y.AbstractType)) continue;
    if (s.content instanceof Y.ContentString) {
      target = s;
      break;
    }
    fallback ??= s;
  }
  const item = target ?? fallback;
  if (!item) return null;
  const pos = Y.relativePositionToJSON(
    Y.createRelativePositionFromJSON({
      item: { client: item.id.client, clock: item.id.clock + item.length - 1 },
      assoc: -1,
    }),
  );
  return { anchor: pos, head: pos };
}

/**
 * agent 改文档时在 awareness 里短暂出现：在线的人看到它的头像（「张三的 agent」）和光标，
 * 最后一次写入后再停留 AGENT_PRESENCE_MS。
 *
 * 注意：Hocuspocus 的 Document 构造时把本地 awareness 置为 null，
 * setLocalStateField 在 null 上不生效，所以这里必须整体 setLocalState。
 */
function showAgentPresence(
  document: Document,
  actor: ActorRef,
  name: string,
  cursor: AwarenessCursor | null,
) {
  const awareness = document.awareness;
  const prevState = awareness.getLocalState() as { cursor?: AwarenessCursor } | null;
  awareness.setLocalState({
    user: {
      id: actor.id ? `agent:${actor.id}` : 'agent',
      name,
      // 十六进制（第三方光标绑定只认 #rrggbb），与 STYLE 的 --agent 同值；前端按 kind 渲染成 agent 渐变
      color: '#7c5cfa',
      colorIndex: 0,
      kind: 'agent',
    },
    cursor: cursor ?? prevState?.cursor ?? null,
  });
  const prev = agentTimers.get(document);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => awareness.setLocalState(null), AGENT_PRESENCE_MS);
  timer.unref?.();
  agentTimers.set(document, timer);
}

function toU8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array(0);
}

function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { headers });
}

export function registerCollab(app: FastifyInstance, ctx: AppContext) {
  const lastHash = new Map<string, string>();
  // 鉴权中的连接还没进入 Hocuspocus 的文档表，也要响应权限变化。
  const authenticating = new Map<
    WebSocket,
    { projectId: string; docId: string; resourceId: string; userId: string }
  >();
  const hocuspocus = new Hocuspocus<CollabConnectionContext>({
    name: 'srh-collab',
    quiet: true,
    debounce: 2000,
    maxDebounce: 10_000,
    async onConnect({ documentName, context, connectionConfig }) {
      // 一条连接只能打开握手时校验过的那篇文档
      if (documentName !== context.docId) throw new Error('document mismatch');
      if (context.readOnly) connectionConfig.readOnly = true;
    },
    async beforeHandleMessage({ documentName, context, connection }) {
      const storage = storageOf(ctx, documentName);
      if (!storage.access || !context.actor.id) return;
      const access = await storage.access(documentName, context.actor.id);
      if (access === 'none') {
        connection.close({ code: 4404, reason: 'not found' });
        throw new Error('document access revoked');
      }
      connection.readOnly = !!context.readOnly || (access !== 'edit' && access !== 'manage');
    },
    async beforeSync({ documentName, document, type, payload, connection }) {
      if (type !== 0 && !connection.readOnly)
        storageOf(ctx, documentName).validateUpdate?.(document, payload);
    },
    async onChange({ documentName, document, context }) {
      if (context?.actor) storageOf(ctx, documentName).changed?.(document, context.actor);
    },
    async onLoadDocument({ documentName, document }) {
      const row = await storageOf(ctx, documentName).load(documentName);
      if (!row) throw new Error('document not found');
      if (row.state) Y.applyUpdate(document, row.state);
      storageOf(ctx, documentName).prepare?.(document, row.kind);
      lastHash.set(documentName, hashState(document));
      return document;
    },
    async onStoreDocument({ documentName, document, lastContext }) {
      const hash = hashState(document);
      if (lastHash.get(documentName) === hash) return;
      const actor = (lastContext as CollabConnectionContext | undefined)?.actor ?? SYSTEM;
      await storageOf(ctx, documentName).persist(documentName, document, actor);
      lastHash.set(documentName, hash);
    },
    async afterUnloadDocument({ documentName }) {
      lastHash.delete(documentName);
    },
  });
  hubs.set(ctx, { hocuspocus, lastHash });

  // 成员被移出 / 角色变化：断开他在这个项目的协同连接，重连时按新角色鉴权
  const offEvent = ctx.bus.onEvent((event) => {
    for (const [socket, pending] of authenticating) {
      if (pending.projectId !== event.projectId) continue;
      const invalidated =
        (event.type === 'project.updated' && !!event.payload.archivedAt) ||
        (event.type === 'member.removed' && event.payload.userId === pending.userId) ||
        (event.type === 'member.updated' && event.payload.user.id === pending.userId) ||
        (event.type === 'share.updated' && event.payload.resourceId === pending.resourceId) ||
        (event.type === 'paper.deleted' && event.payload.id === pending.resourceId) ||
        (event.type === 'paper.updated' &&
          event.payload.id === pending.resourceId &&
          !!event.payload.archivedAt) ||
        (event.type === 'document.deleted' && event.payload.id === pending.docId) ||
        (event.type === 'document.updated' &&
          event.payload.id === pending.docId &&
          !!event.payload.archivedAt);
      if (invalidated) socket.close(4205, 'Reset Connection');
    }
    if (event.type === 'member.removed') {
      closeUserConnections(ctx, event.projectId, event.payload.userId);
    } else if (event.type === 'member.updated') {
      closeUserConnections(ctx, event.projectId, event.payload.user.id);
    } else if (event.type === 'project.updated' && event.payload.archivedAt) {
      closeProjectConnections(ctx, event.projectId);
    }
  });

  app.addHook('onClose', async () => {
    offEvent();
    hocuspocus.closeConnections();
    hocuspocus.flushPendingStores();
    for (let i = 0; i < 100 && hocuspocus.getDocumentsCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  app.get<{ Params: { documentId: string } }>(
    `${COLLAB_PATH}/:documentId`,
    { websocket: true },
    (socket: WebSocket, req) => {
      // 鉴权完成前到达的消息先排队
      const queue: Uint8Array[] = [];
      let conn: ReturnType<typeof hocuspocus.handleConnection> | null = null;
      let closed = false;
      socket.on('message', (data) => {
        if (socket.readyState !== socket.OPEN) return;
        const u8 = toU8(data);
        if (conn) conn.handleMessage(u8);
        else queue.push(u8);
      });
      socket.on('close', (code, reason) => {
        closed = true;
        authenticating.delete(socket);
        conn?.handleClose({ code, reason: reason.toString() });
      });
      socket.on('pong', () => conn?.touch());
      socket.on('error', () => undefined);

      void (async () => {
        const docId = req.params.documentId;
        if (!isAllowedOrigin(req, ctx.config.PUBLIC_URL)) {
          socket.close(WS_CLOSE.forbidden, 'origin not allowed');
          return;
        }
        const user = await ctx.access.userFromRequest(req);
        // REALTIME_DEV_ANON 的匿名身份只给 /ws 用；协同文档必须真实登录
        if (!user || isDevAnonymous(user.id)) {
          socket.close(WS_CLOSE.unauthorized, 'unauthorized');
          return;
        }
        await watchApiTokenSocket(req, socket);
        if (socket.readyState !== socket.OPEN) return;
        const storage = storageOf(ctx, docId);
        const row = await storage.load(docId);
        if (closed || socket.readyState !== socket.OPEN) return;
        if (row)
          authenticating.set(socket, {
            projectId: row.projectId,
            docId,
            resourceId: row.resourceId ?? docId,
            userId: user.id,
          });
        const role = row ? await storage.role(row.projectId, user.id) : null;
        // 有资源级权限时按它判断（个人文档的所有者、被邀请的人、链接访问者，含课题外账号）
        const access = row && storage.access ? await storage.access(docId, user.id) : null;
        // 资源分享可允许课题外用户访问，但不能让已归档项目继续开放。
        const [activeProject] = row
          ? await ctx.db.db
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, row.projectId), isNull(projects.archivedAt)))
          : [];
        // 令牌限项目（API.md §2.21）：范围外的文档与「不存在」一样处理
        const limited = user.token?.projectIds ?? [];
        const tokenOutOfScope = limited.length > 0 && !!row && !limited.includes(row.projectId);
        if (
          !row ||
          (row.projectId && !activeProject) ||
          tokenOutOfScope ||
          (access ? access === 'none' : !role)
        ) {
          socket.close(4404, 'not found');
          return;
        }
        if (closed || socket.readyState !== socket.OPEN) return;
        const canWrite = access ? access === 'edit' || access === 'manage' : role !== 'guest';
        // 只读令牌（API.md §2.21）：握手成功但只能看，和访客一样不落任何改动
        const tokenReadOnly = user.token ? !user.token.scopes.includes('write') : false;
        conn = hocuspocus.handleConnection(socket, toWebRequest(req), {
          docId,
          projectId: row.projectId,
          // 课题外的链接访问者没有角色：按可写与否折算（只影响只读判断）
          role: role ?? (canWrite ? 'member' : 'guest'),
          readOnly: !canWrite || !!row.archived || tokenReadOnly,
          actor: { kind: 'user', id: user.id, name: user.name },
        });
        for (const msg of queue.splice(0)) conn.handleMessage(msg);
        // Hocuspocus 可能仍在异步打开文档；保留登记直到连接关闭，覆盖这段时间。
      })().catch((err: unknown) => {
        app.log.error({ err }, 'collab handshake failed');
        if (!closed) socket.close(1011, 'internal error');
      });
    },
  );
}
