import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError, type ActorRef, type ProjectRole, type User } from '@srh/shared';
import { projectMembers, projects } from '../../db/schema';
import { isAllowedOrigin } from '../../realtime/access';
import {
  assertTokenCanWrite,
  bearerAuthFor,
  bearerFromHeader,
  type ApiTokenRow,
} from '../integrations/service';
import {
  promoteConfiguredAdmin,
  toUser,
  tokenFromCookies,
  userFromToken,
  type UserRow,
} from './service';
import { tokenRequestMethod } from '../integrations/runtime';

/**
 * REST 鉴权与项目权限守卫。所有模块（含协作模块）都从这里拿当前用户和角色。
 *
 *   const { user, role, actor } = await requireProject(req, projectId, 'write');
 *
 * 能力与角色（ARCHITECTURE.md §9）：
 * - view   ：所有成员（含 guest）——看时间线、线程、文档、实验、汇报、agent 思路
 * - write  ：owner / advisor / member——发言驱动 agent、编辑文档看板待办实验、审阅、答决策卡、我的工作区
 * - manage ：owner / advisor——项目设置、成员与邀请、项目指令、编辑记忆（advisor 不能动 owner）
 * - delete ：owner——删除项目
 * 不是成员一律 404（不泄露项目是否存在）；是成员但能力不够 403。
 *
 * 身份来源两种，效果完全相同（API.md §2.21）：
 * - `Authorization: Bearer srh_pat_…`：API 令牌，按令牌主人的角色与项目成员身份计算权限；
 * - Cookie `srh_session`：网页登录。
 * 令牌限制由两条身份守卫、资源级守卫与实时连接共同执行。
 */
export type Capability = 'view' | 'write' | 'manage' | 'delete';

const CAPS: Record<ProjectRole, readonly Capability[]> = {
  owner: ['view', 'write', 'manage', 'delete'],
  advisor: ['view', 'write', 'manage'],
  member: ['view', 'write'],
  guest: ['view'],
};

export function can(role: ProjectRole, cap: Capability): boolean {
  return CAPS[role].includes(cap);
}

const CAP_LABEL: Record<Capability, string> = {
  view: '查看',
  write: '编辑',
  manage: '管理',
  delete: '删除',
};

/** 一次请求解析出来的身份：用户 +（如果是令牌）令牌本身 */
export interface RequestAuth {
  user: UserRow;
  token: ApiTokenRow | null;
}

const authCache = new WeakMap<FastifyRequest, RequestAuth | null>();

/**
 * 当前请求的身份：Bearers 令牌优先，其次 Cookie 会话。
 * 带了 Bearer 但无效 / 未启用时直接 401，不会悄悄退回 Cookie（避免“以为在用令牌”）。
 */
export async function currentAuth(req: FastifyRequest): Promise<RequestAuth | null> {
  if (authCache.has(req)) return authCache.get(req) ?? null;
  const bearer = await bearerAuthFor(req);
  let auth: RequestAuth | null;
  if (bearer) {
    auth = { user: bearer.user, token: bearer.token };
  } else {
    const row = await userFromToken(req.server.ctx.db.db, tokenFromCookies(req.cookies));
    auth = row
      ? {
          user: await promoteConfiguredAdmin(
            req.server.ctx.db.db,
            req.server.ctx.config.ADMIN_EMAILS,
            row,
          ),
          token: null,
        }
      : null;
  }
  authCache.set(req, auth);
  return auth;
}

export async function currentUserRow(req: FastifyRequest): Promise<UserRow | null> {
  return (await currentAuth(req))?.user ?? null;
}

/** 本次请求用的令牌；Cookie 登录时为 null */
export async function apiTokenFor(req: FastifyRequest): Promise<ApiTokenRow | null> {
  return (await currentAuth(req))?.token ?? null;
}

/** 令牌限定项目时，只能碰这几张项目；空数组 = 不限制 */
export function tokenAllowsProject(token: ApiTokenRow | null, projectId: string): boolean {
  return !token || token.projectIds.length === 0 || token.projectIds.includes(projectId);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 防护（与 /ws、/collab 的 Origin 规则一致）：写请求（非 GET/HEAD/OPTIONS）
 * - 带 Origin：必须是 PUBLIC_URL 的源，或与请求 Host 同源，否则 403；
 * - 不带 Origin 但 Sec-Fetch-Site 为 cross-site：403；
 * - 两者都没有（服务端调用、命令行、测试 inject）：放行，交给 Cookie 鉴权。
 * requireUser 会自动调用；不经过 requireUser 的写接口（登录、注册、登出）需自行调用。
 */
export function assertAllowedOrigin(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const forbidden = () => new ApiError('forbidden', '请求来源不被允许');
  if (req.headers.origin !== undefined) {
    if (!isAllowedOrigin(req, req.server.ctx.config.PUBLIC_URL)) throw forbidden();
    return;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw forbidden();
}

/** 未登录抛 401；写请求先做来源校验（assertAllowedOrigin） */
export async function requireUser(req: FastifyRequest): Promise<User> {
  assertAllowedOrigin(req);
  const auth = await currentAuth(req);
  if (!auth) throw new ApiError('unauthorized', '请先登录');
  // 只读令牌不能改东西（读接口也走这里，所以判断方法而不是接口）
  assertTokenCanWrite(auth.token, tokenRequestMethod(req));
  return toUser(auth.user);
}

/**
 * 只允许网页登录会话的接口（目前是令牌管理本身）：
 * 令牌不能创建、查看、撤销令牌，否则一张泄露的令牌可以给自己续命。
 */
export async function requireInteractiveUser(req: FastifyRequest): Promise<User> {
  assertAllowedOrigin(req);
  if (bearerFromHeader(req.headers.authorization)) {
    throw new ApiError('forbidden', '管理 API 令牌要用网页登录，不能用令牌本身');
  }
  const auth = await currentAuth(req);
  if (!auth) throw new ApiError('unauthorized', '请先登录');
  return toUser(auth.user);
}

export function userActor(user: Pick<User, 'id' | 'name'>): ActorRef {
  return { kind: 'user', id: user.id, name: user.name };
}

export interface ProjectAccess {
  user: User;
  role: ProjectRole;
  actor: ActorRef;
  project: typeof projects.$inferSelect;
}

/** 查成员身份；项目不存在、已归档或不是成员都返回 null */
export async function membership(
  req: FastifyRequest,
  projectId: string,
  userId: string,
): Promise<{ role: ProjectRole; project: typeof projects.$inferSelect } | null> {
  const [row] = await req.server.ctx.db.db
    .select({ role: projectMembers.role, project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projects.archivedAt),
      ),
    );
  return row ?? null;
}

export async function requireProject(
  req: FastifyRequest,
  projectId: string,
  cap: Capability = 'view',
): Promise<ProjectAccess> {
  const user = await requireUser(req);
  // 令牌限项目：范围外的项目与“不是成员”一样返回 404，不泄露项目是否存在
  if (!tokenAllowsProject(await apiTokenFor(req), projectId)) {
    throw new ApiError('not_found', '项目不存在或你不是成员');
  }
  const m = await membership(req, projectId, user.id);
  if (!m) throw new ApiError('not_found', '项目不存在或你不是成员');
  if (!can(m.role, cap)) {
    throw new ApiError('forbidden', `你的角色没有${CAP_LABEL[cap]}权限`, {
      role: m.role,
      need: cap,
    });
  }
  return { user, role: m.role, actor: userActor(user), project: m.project };
}
