import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError, type ActorRef, type ProjectRole } from '@srh/shared';
import type { AppContext } from '../../context';
import { projectMembers, projects } from '../../db/schema';
import { assertAllowedOrigin } from '../auth/guard';
import { assertTokenCanWrite } from '../integrations/service';
import { tokenRequestMethod } from '../integrations/runtime';

/**
 * 协作模块的项目权限检查。
 *
 * 签名与 modules/auth/guard.ts 的 requireProject 一致。身份走 ctx.access.userFromRequest：
 * 生产环境就是 Cookie 会话策略（与 auth/guard 相同），测试里可以注入假身份，
 * 同一个函数也给 /collab 握手用（那里没有 FastifyRequest 上的 cookie 解析缓存）。
 */
export type Capability = 'view' | 'write' | 'manage' | 'delete';

export interface GuardUser {
  id: string;
  name: string;
  avatarColor: number;
  /** 用 API 令牌认证时带上：限定项目（空 = 全部）与权限；Cookie 登录时没有 */
  token?: { projectIds: string[]; scopes: string[] };
}

export interface ProjectAccess {
  user: GuardUser;
  role: ProjectRole;
  actor: ActorRef;
}

const ALLOWED: Record<Capability, ProjectRole[]> = {
  view: ['owner', 'advisor', 'member', 'guest'],
  write: ['owner', 'advisor', 'member'],
  manage: ['owner', 'advisor'],
  delete: ['owner'],
};

export function roleCan(role: ProjectRole, cap: Capability): boolean {
  return ALLOWED[cap].includes(role);
}

/**
 * 本地调试的匿名身份（realtime/access.ts 在 REALTIME_DEV_ANON=true 时给没有 Cookie 的连接用）。
 * 它只用于 /ws 订阅和 /collab 只读查看，协作模块的 REST 一律当作未登录。
 */
export const DEV_ANONYMOUS_USER_ID = 'usr_anonymous';

export function isDevAnonymous(userId: string | null | undefined): boolean {
  return userId === DEV_ANONYMOUS_USER_ID;
}

export async function requireUser(req: FastifyRequest): Promise<GuardUser> {
  // 写请求的来源校验（CSRF），规则与 auth/guard 的 requireUser 相同
  assertAllowedOrigin(req);
  const user = await req.server.ctx.access.userFromRequest(req);
  // REALTIME_DEV_ANON 只放开实时通道（API.md §6），REST 不受影响：匿名照样 401
  if (!user || isDevAnonymous(user.id)) throw new ApiError('unauthorized', '请先登录');
  // 只读令牌不能改东西（API.md §2.21）：这条链覆盖看板、待办、文档、审阅、版本等模块
  assertTokenCanWrite(user.token, tokenRequestMethod(req));
  return user;
}

/** 按用户 id 查角色；不是成员返回 null。 */
export async function memberRole(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  // 与 modules/auth/guard.ts 的 membership 一致：已归档的项目视为不可访问
  const [row] = await ctx.db.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projects.archivedAt),
      ),
    );
  // 本地开发的匿名身份（REALTIME_DEV_ANON）不是任何项目的成员：
  // 协作模块的 REST 和 /collab 都按未登录处理（不再像以前那样当成负责人放行）
  return row?.role ?? null;
}

export async function requireProject(
  req: FastifyRequest,
  projectId: string,
  cap: Capability,
): Promise<ProjectAccess> {
  const user = await requireUser(req);
  // 令牌限项目（API.md §2.21）：范围外的项目与“不是成员”一样 404
  const limited = user.token?.projectIds ?? [];
  if (limited.length > 0 && !limited.includes(projectId)) {
    throw new ApiError('not_found', '项目不存在，或你不是它的成员');
  }
  const role = await memberRole(req.server.ctx, projectId, user.id);
  if (!role) throw new ApiError('not_found', '项目不存在，或你不是它的成员');
  if (!roleCan(role, cap)) {
    throw new ApiError(
      'forbidden',
      cap === 'write'
        ? '访客只能查看，不能修改。可以请项目负责人调整你的角色。'
        : '你没有权限进行这个操作',
    );
  }
  return { user, role, actor: { kind: 'user', id: user.id, name: user.name } };
}
