import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { AnyProjectEvent } from '@srh/shared';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { projectMembers, projects, threads } from '../db/schema';
import { tokenFromCookies, userFromToken } from '../modules/auth/service';
import { bearerAuthFor } from '../modules/integrations/service';
import { canSeeResourceEvent, loadAudiences, trackResourceEvent } from './audience';
import type { EphemeralEvent, EventBus } from './bus';

/**
 * 实时通道（/ws、/collab）的身份与权限钩子。
 * 归属：后端线程。实现登录后，只需改本文件的 resolveAccessPolicy 返回真正的策略，
 * 不需要动 app.ts / ws.ts。
 */
export interface RealtimeUser {
  id: string;
  name: string;
  avatarColor: number;
  /**
   * 用 API 令牌连接时带上：限定的项目（空 = 全部）与权限（read / write）。
   * Cookie 登录的用户没有这个字段。
   */
  token?: { projectIds: string[]; scopes: string[] };
}

export interface AccessPolicy {
  /** 从 WS 握手请求（Cookie）解析当前用户；未登录返回 null */
  userFromRequest(req: FastifyRequest): Promise<RealtimeUser | null>;
  /** 该用户能否订阅这个项目 */
  canAccessProject(user: RealtimeUser | null, projectId: string): Promise<boolean>;
  /**
   * 推送前逐条过滤（同步，热路径）：个人线程事件只给主人、inbox.* 只给对应用户等。
   * 返回 false 则不推给该连接。
   */
  canSeeEvent(user: RealtimeUser, event: AnyProjectEvent): boolean;
  /** 瞬时事件过滤（如个人会话的 agent.delta 只推给主人）；不实现则全部放行 */
  canSeeEphemeral?(user: RealtimeUser, event: EphemeralEvent): boolean;
}

/** resolveAccessPolicy 可用的依赖：查会话/成员表、监听事件维护缓存 */
export interface AccessDeps {
  db: Db;
  bus: EventBus;
}

/** 开发策略：匿名访客，所有项目可订阅、所有事件可见。只能通过 REALTIME_DEV_ANON 显式开启。 */
export const devAccessPolicy: AccessPolicy = {
  async userFromRequest() {
    return { id: 'usr_anonymous', name: '访客', avatarColor: 7 };
  },
  async canAccessProject() {
    return true;
  },
  canSeeEvent() {
    return true;
  },
};

/** 默认兜底：在真正的鉴权实现之前，一律拒绝（fail closed）。 */
export const denyAllPolicy: AccessPolicy = {
  async userFromRequest() {
    return null;
  },
  async canAccessProject() {
    return false;
  },
  canSeeEvent() {
    return false;
  },
};

/**
 * 选择实时通道的权限策略：默认用真实的会话 Cookie + 成员身份策略。
 * 非生产且 REALTIME_DEV_ANON=true 时，未登录的连接以匿名访客放行（仅本地调试前端用）。
 */
export function resolveAccessPolicy(config: AppConfig, deps: AccessDeps): AccessPolicy {
  return createMemberAccessPolicy(deps, {
    devAnon: config.NODE_ENV !== 'production' && config.REALTIME_DEV_ANON,
  });
}

const ANON_ID = 'usr_anonymous';

/**
 * 匿名放行只适用于 /ws 的 WebSocket 握手（验收：之前对所有调用 userFromRequest 的地方生效，
 * 协作模块的 REST 与 /collab 把匿名当 owner 读写）。REST 与 /collab 一律要登录。
 */
function isWsUpgrade(req: FastifyRequest): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  return (
    (path === '/ws' || path.endsWith('/ws')) &&
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
  );
}

/**
 * 真实策略：
 * - 身份：Cookie srh_session → auth_sessions（只存 SHA-256）→ users
 * - 订阅：必须是项目成员且项目未归档
 * - 逐条过滤（同步）：个人线程（kind=personal）的一切事件只给主人；inbox.* 只给条目的 userId；
 *   被移出项目的成员此后收不到该项目任何事件。
 * 个人线程主人的缓存：订阅时按项目整批加载，之后靠 thread.created / thread.updated 事件增量维护。
 */
export function createMemberAccessPolicy(
  { db, bus }: AccessDeps,
  opts: { devAnon?: boolean } = {},
): AccessPolicy {
  /** threadId → 主人 userId（只记 personal 线程） */
  const personalOwner = new Map<string, string>();
  const loadedProjects = new Set<string>();
  /** `${projectId}:${userId}` 已被移出 */
  const removed = new Set<string>();

  const remember = (t: { id: string; kind: string; ownerUserId: string | null }) => {
    if (t.kind === 'personal' && t.ownerUserId) personalOwner.set(t.id, t.ownerUserId);
  };

  bus.onEvent((event) => {
    trackResourceEvent(event);
    if (event.type === 'thread.created' || event.type === 'thread.updated') remember(event.payload);
    if (event.type === 'member.removed') removed.add(`${event.projectId}:${event.payload.userId}`);
    if (event.type === 'member.joined') {
      removed.delete(`${event.projectId}:${event.payload.user.id}`);
    }
  });

  async function loadProject(projectId: string) {
    if (loadedProjects.has(projectId)) return;
    const rows = await db
      .select({ id: threads.id, kind: threads.kind, ownerUserId: threads.ownerUserId })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.kind, 'personal')));
    rows.forEach(remember);
    // 个人空间的文档 / 论文：事件只推给所有者和分享到的人
    await loadAudiences(projectId);
    loadedProjects.add(projectId);
  }

  const threadVisible = (user: RealtimeUser, threadId: string | null | undefined) => {
    if (!threadId) return true;
    const owner = personalOwner.get(threadId);
    return owner === undefined || owner === user.id;
  };

  return {
    async userFromRequest(req) {
      // API 令牌优先（API.md §2.21）：无效 / 未启用按未登录处理，由上层关掉连接
      try {
        const bearer = await bearerAuthFor(req);
        if (bearer) {
          return {
            id: bearer.user.id,
            name: bearer.user.name,
            avatarColor: bearer.user.avatarColor,
            token: { projectIds: bearer.token.projectIds, scopes: bearer.token.scopes },
          };
        }
      } catch {
        return null;
      }
      const row = await userFromToken(db, tokenFromCookies(req.cookies));
      if (row) return { id: row.id, name: row.name, avatarColor: row.avatarColor };
      if (opts.devAnon && isWsUpgrade(req)) return { id: ANON_ID, name: '访客', avatarColor: 7 };
      return null;
    },
    async canAccessProject(user, projectId) {
      if (!user) return false;
      // 令牌限项目：范围外的项目一律当“没有权限”（/ws 订阅、/collab 握手都走这里）
      const limited = user.token?.projectIds ?? [];
      if (limited.length > 0 && !limited.includes(projectId)) return false;
      if (user.id === ANON_ID) {
        // 本地调试：匿名访客可订阅任何项目，但和非主人一样看不到个人线程与收件箱（下面 canSeeEvent 过滤）
        if (!opts.devAnon) return false;
        await loadProject(projectId);
        return true;
      }
      const [row] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, user.id),
            isNull(projects.archivedAt),
          ),
        );
      if (!row) return false;
      removed.delete(`${projectId}:${user.id}`);
      await loadProject(projectId);
      return true;
    },
    canSeeEvent(user, event) {
      if (removed.has(`${event.projectId}:${user.id}`)) return false;
      if (event.type === 'inbox.created' || event.type === 'inbox.updated') {
        return event.payload.userId === user.id;
      }
      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        const t = event.payload;
        return t.kind !== 'personal' || t.ownerUserId === user.id;
      }
      // 个人空间的文档、论文及其评论、版本、提案：只推给所有者与分享到的人
      if (!canSeeResourceEvent(user.id, event)) return false;
      // 个人待办只推给主人（todo.deleted 只带 id，无法过滤，可接受）
      if (event.type === 'todo.created' || event.type === 'todo.updated') {
        const owner = event.payload.ownerUserId;
        if (owner && owner !== user.id) return false;
      }
      return threadVisible(user, event.threadId);
    },
    canSeeEphemeral(user, event) {
      if (removed.has(`${event.projectId}:${user.id}`)) return false;
      const payload = event.payload as { threadId?: string | null };
      return threadVisible(user, payload.threadId);
    },
  };
}

/** REST 补拉（GET P/events）复用同一过滤：先确保缓存已加载 */
export async function filterEventsFor(
  policy: AccessPolicy,
  user: RealtimeUser,
  projectId: string,
  events: AnyProjectEvent[],
): Promise<AnyProjectEvent[]> {
  if (!(await policy.canAccessProject(user, projectId))) return [];
  return events.filter((e) => policy.canSeeEvent(user, e));
}

/**
 * 跨站 WebSocket 劫持防护：浏览器发来的 Origin 必须是 PUBLIC_URL 或与请求 Host 同源。
 * 没有 Origin 头（非浏览器客户端）放行，交给 Cookie 鉴权。
 */
export function isAllowedOrigin(req: FastifyRequest, publicUrl: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  try {
    if (originUrl.origin === new URL(publicUrl).origin) return true;
  } catch {
    // PUBLIC_URL 配置错误时只比较 Host
  }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return typeof host === 'string' && originUrl.host === host.split(',')[0]?.trim();
}
