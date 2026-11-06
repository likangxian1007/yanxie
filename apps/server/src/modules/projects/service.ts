import { defaultModelId } from '../../agents/llm/registry';
import { randomBytes } from 'node:crypto';
import { and, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiError,
  newId,
  type ActorRef,
  type Invite,
  type Project,
  type ProjectMember,
  type ProjectRole,
  type ProjectWithRole,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  agentSessions,
  events,
  inboxItems,
  invites,
  memoryFiles,
  projectMembers,
  projects,
  users,
} from '../../db/schema';
import { collab } from '../../agents/tools/collab-port';

export type ProjectRow = typeof projects.$inferSelect;
type InviteRow = typeof invites.$inferSelect;

export const AGENT_NAME = '研协';
export const SYSTEM_ACTOR: ActorRef = { kind: 'system', id: null, name: '系统' };
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export const INITIAL_MEMORY_INDEX = `# 项目记忆索引

<!-- 每个记忆文件一行：- [标题](path) — 什么时候该读它。由研协维护，成员也可以直接编辑。 -->
`;

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    instructions: row.instructions,
    visibility: row.visibility,
    researchDomains: row.researchDomains,
    preferredResearchMethods: [],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    projectId: row.projectId,
    email: row.email,
    role: row.role,
    token: row.token,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMembers(ctx: AppContext, projectId: string): Promise<ProjectMember[]> {
  const rows = await ctx.db.db
    .select({ m: projectMembers, u: users })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(projectMembers.joinedAt);
  return rows.map(({ m, u }) => ({
    projectId: m.projectId,
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      avatarColor: u.avatarColor,
      avatarUrl: u.avatarUrl,
    },
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  }));
}

export async function getMember(ctx: AppContext, projectId: string, userId: string) {
  return (await listMembers(ctx, projectId)).find((m) => m.user.id === userId) ?? null;
}

/**
 * 用户所在的项目（含角色与未处理收件箱数）。
 * `onlyProjectIds`：API 令牌限定了项目时只返回这几张（API.md §2.21）；空数组 = 不限。
 */
export async function listProjectsForUser(
  ctx: AppContext,
  userId: string,
  onlyProjectIds: string[] = [],
): Promise<ProjectWithRole[]> {
  const rows = await ctx.db.db
    .select({ p: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.userId, userId),
        isNull(projects.archivedAt),
        ...(onlyProjectIds.length > 0 ? [inArray(projectMembers.projectId, onlyProjectIds)] : []),
      ),
    )
    .orderBy(projects.createdAt);
  if (rows.length === 0) return [];
  const unread = await ctx.db.db
    .select({ projectId: inboxItems.projectId, n: count() })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.userId, userId),
        isNull(inboxItems.doneAt),
        inArray(
          inboxItems.projectId,
          rows.map((r) => r.p.id),
        ),
      ),
    )
    .groupBy(inboxItems.projectId);
  const unreadBy = new Map(unread.map((u) => [u.projectId, Number(u.n)]));
  return rows.map(({ p, role }) => ({
    ...toProject(p),
    role,
    unread: unreadBy.get(p.id) ?? 0,
    // 前端订阅 /ws 时用它当补发下界：项目页数据都在 /auth/me 返回之后才拉
    eventSeq: p.eventSeq,
  }));
}

/**
 * 新建项目：项目 + 创建者成为 owner + 协调者会话 + MEMORY.md 索引（同一事务），
 * 之后（协作模块已注册时）建默认看板。
 */
export async function createProject(
  ctx: AppContext,
  actor: ActorRef & { id: string },
  input: {
    name: string;
    description: string;
    icon: string;
    color: number;
    visibility: Project['visibility'];
  },
): Promise<ProjectRow> {
  const id = newId('project');
  const row = await ctx.db.db.transaction(async (tx) => {
    const fields = { ...input } as typeof input & { preferredResearchMethods?: unknown };
    delete fields.preferredResearchMethods;
    const [p] = await tx
      .insert(projects)
      .values({ id, createdBy: actor.id, ...fields })
      .returning();
    await tx.insert(projectMembers).values({ projectId: id, userId: actor.id, role: 'owner' });
    await tx.insert(agentSessions).values({
      id: newId('agentSession'),
      projectId: id,
      role: 'coordinator',
      model: defaultModelId(ctx.config),
    });
    await tx.insert(memoryFiles).values({
      id: newId('memory'),
      projectId: id,
      path: 'MEMORY.md',
      description: '项目记忆索引，每次唤醒全文注入',
      type: null,
      content: INITIAL_MEMORY_INDEX,
      updatedBy: actor,
    });
    return p;
  });
  if (!row) throw new ApiError('internal', '创建项目失败');
  const boards = collab('boards');
  if (boards) {
    try {
      await boards.ensureDefaultBoard(ctx, actor, id);
    } catch (err) {
      console.error('[projects] 默认看板创建失败', err);
    }
  }
  return row;
}

export async function addMember(
  ctx: AppContext,
  projectId: string,
  userId: string,
  role: ProjectRole,
  actor: ActorRef,
): Promise<ProjectMember> {
  const existing = await getMember(ctx, projectId, userId);
  if (existing) return existing;
  await ctx.db.db.insert(projectMembers).values({ projectId, userId, role });
  const member = await getMember(ctx, projectId, userId);
  if (!member) throw new ApiError('internal', '加入项目失败');
  await ctx.bus.publish({ projectId, type: 'member.joined', payload: member, actor });
  return member;
}

export async function createInvite(
  ctx: AppContext,
  projectId: string,
  createdBy: string,
  input: { email?: string | undefined; role: Exclude<ProjectRole, 'owner'> },
): Promise<Invite> {
  const [row] = await ctx.db.db
    .insert(invites)
    .values({
      id: newId('invite'),
      projectId,
      email: input.email?.trim().toLowerCase() ?? null,
      role: input.role,
      token: randomBytes(18).toString('base64url'),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdBy,
    })
    .returning();
  if (!row) throw new ApiError('internal', '创建邀请失败');
  return toInvite(row);
}

/** 接受邀请：校验有效期与邮箱，加入项目（已是成员则直接返回项目）。 */
/** 校验邀请（不加入）。注册时在创建账号之前调用，避免邀请无效却留下一个没有 Cookie 的账号。 */
export async function checkInvite(ctx: AppContext, token: string, email: string) {
  const [inv] = await ctx.db.db.select().from(invites).where(eq(invites.token, token));
  if (!inv) throw new ApiError('not_found', '邀请链接无效');
  if (inv.expiresAt.getTime() < Date.now()) throw new ApiError('conflict', '邀请链接已过期');
  if (inv.email && inv.email !== email.toLowerCase()) {
    throw new ApiError('forbidden', '这个邀请是发给另一个邮箱的');
  }
  const [project] = await ctx.db.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, inv.projectId), isNull(projects.archivedAt)));
  if (!project) throw new ApiError('not_found', '项目不存在');
  return { inv, project };
}

/** 用户在 since 之后是否被移出过（或自己退出过）这个项目：查事件日志里的 member.removed */
export async function removedSince(
  ctx: AppContext,
  projectId: string,
  userId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await ctx.db.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.type, 'member.removed'),
        sql`${events.payload}->>'userId' = ${userId}`,
        gte(events.createdAt, since),
      ),
    )
    .limit(1);
  return !!row;
}

export async function acceptInvite(
  ctx: AppContext,
  token: string,
  user: { id: string; name: string; email: string },
): Promise<ProjectRow> {
  const { inv, project } = await checkInvite(ctx, token, user.email);
  // 已是成员视为重复点击（addMember 原样返回）；不是成员时才做下面的检查
  if (!(await getMember(ctx, inv.projectId, user.id))) {
    // 定向邀请已被用过（如本人已被移出），不能再用
    if (inv.email && inv.acceptedAt) {
      throw new ApiError('conflict', '这个邀请链接已经用过了');
    }
    // 邀请创建之后被移出过项目：旧链接不能让人自己回来，需要管理员发新邀请
    if (await removedSince(ctx, inv.projectId, user.id, inv.createdAt)) {
      throw new ApiError('forbidden', '你已被移出这个项目，请向管理员要新的邀请链接');
    }
  }
  await addMember(ctx, inv.projectId, user.id, inv.role, {
    kind: 'user',
    id: user.id,
    name: user.name,
  });
  // 定向邀请只能用一次；通用链接（没写邮箱）在有效期内可多人使用
  if (inv.email && !inv.acceptedAt) {
    await ctx.db.db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
  }
  return project;
}

export async function getProjectRow(ctx: AppContext, projectId: string) {
  const [row] = await ctx.db.db.select().from(projects).where(eq(projects.id, projectId));
  return row ?? null;
}
