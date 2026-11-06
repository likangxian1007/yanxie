import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  accessAtLeast,
  ApiError,
  ShareGrantInput,
  type AccessLevel,
  type ActorRef,
  type ProjectRole,
  type ShareGrant,
  type ShareLevel,
  type ShareLinkUpdateInput,
  type ShareResolveResult,
  type ShareResourceKind,
  type ShareSettings,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  documents,
  papers,
  projectMembers,
  projects,
  shareGrants,
  shareLinks,
  shareVisits,
  users,
} from '../../db/schema';
import { setPersonalAudience } from '../../realtime/audience';
import { closeDocumentConnections } from '../../realtime/collab';
import { memberRole, requireUser, type GuardUser } from '../collab-common/guard';
import { assertTokenProject } from '../integrations/service';
import { trackOperationResource } from '../integrations/runtime';
import { createInboxItem } from '../collab-common/inbox';
import { accessOf, type SharedResource, type Viewer } from './access';

/**
 * 分享设置的读写、链接解析、事件受众维护（API.md §2.19）。
 * 文档、论文两类资源共用；资源本身的读写仍在各自模块，这里只管「谁能访问」。
 */
export interface LoadedResource extends SharedResource {
  title: string;
  archived: boolean;
  createdBy: ActorRef;
}

const NAME: Record<ShareResourceKind, string> = { document: '文档', paper: '论文' };

export async function loadResource(
  ctx: AppContext,
  kind: ShareResourceKind,
  id: string,
): Promise<LoadedResource | null> {
  const table = kind === 'document' ? documents : papers;
  const [row] = await ctx.db.db
    .select({
      id: table.id,
      projectId: table.projectId,
      space: table.space,
      ownerUserId: table.ownerUserId,
      title: table.title,
      archivedAt: table.archivedAt,
      createdBy: table.createdBy,
    })
    .from(table)
    .where(eq(table.id, id));
  if (!row || !row.projectId) return null;
  return {
    kind,
    id: row.id,
    projectId: row.projectId,
    space: row.space,
    ownerUserId: row.ownerUserId,
    title: row.title,
    archived: !!row.archivedAt,
    createdBy: row.createdBy,
  };
}

export interface ResourceAccess {
  user: GuardUser;
  /** 在项目里的角色；通过「知道链接的人」进来的外部账号为 null */
  role: ProjectRole | null;
  actor: ActorRef;
  viewer: Viewer;
  access: AccessLevel;
  res: LoadedResource;
}

function deniedMessage(
  kind: ShareResourceKind,
  need: AccessLevel,
  res: LoadedResource,
  role: ProjectRole | null,
) {
  if (need === 'manage') return '只有所有者可以管理分享或移动它';
  if (res.space === 'team' && role === 'guest') {
    return '访客只能查看，不能修改。可以请项目负责人调整你的角色。';
  }
  if (need === 'comment') return `你只有阅读权限，不能评论这篇${NAME[kind]}`;
  return `你只有${need === 'edit' ? '阅读或评论' : ''}权限，不能编辑。可以请所有者把你的权限改成「可编辑」。`;
}

/**
 * 资源级权限检查（替代 requireProject）：不存在、无权访问都返回 404（不暴露个人资源是否存在），
 * 有访问权但级别不够返回 403。
 */
export async function requireResource(
  req: FastifyRequest,
  projectId: string,
  kind: ShareResourceKind,
  id: string,
  need: AccessLevel,
): Promise<ResourceAccess> {
  const user = await requireUser(req);
  assertTokenProject(user.token, projectId);
  const ctx = req.server.ctx;
  const [activeProject] = await ctx.db.db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!activeProject || activeProject.archivedAt) throw new ApiError('not_found', '项目不存在');
  const role = await memberRole(ctx, projectId, user.id);
  const res = await loadResource(ctx, kind, id);
  const viewer: Viewer = { userId: user.id, role };
  const access = res && res.projectId === projectId ? await accessOf(ctx, res, viewer) : 'none';
  if (!res || access === 'none') {
    if (!role) throw new ApiError('not_found', '项目不存在，或你不是它的成员');
    throw new ApiError('not_found', `${NAME[kind]}不存在，或你没有访问权限`);
  }
  if (!accessAtLeast(access, need)) {
    throw new ApiError('forbidden', deniedMessage(kind, need, res, role));
  }
  trackOperationResource(req, projectId, kind, id, need);
  return {
    user,
    role,
    actor: { kind: 'user', id: user.id, name: user.name },
    viewer,
    access,
    res,
  };
}

// ---------------------------------------------------------------- 受众（事件过滤）

/** 重新计算某个个人资源的受众：被邀请的人 + 当前链接下打开过、链接仍开放的人 */
export async function refreshAudience(ctx: AppContext, res: SharedResource) {
  if (res.space !== 'personal') return;
  const grants = await ctx.db.db
    .select({ userId: shareGrants.userId })
    .from(shareGrants)
    .where(and(eq(shareGrants.resourceKind, res.kind), eq(shareGrants.resourceId, res.id)));
  const visits = await ctx.db.db
    .select({ userId: shareVisits.userId })
    .from(shareVisits)
    .innerJoin(
      shareLinks,
      and(
        eq(shareLinks.resourceKind, shareVisits.resourceKind),
        eq(shareLinks.resourceId, shareVisits.resourceId),
        eq(shareLinks.token, shareVisits.token),
      ),
    )
    .where(
      and(
        eq(shareVisits.resourceKind, res.kind),
        eq(shareVisits.resourceId, res.id),
        sql`${shareLinks.scope} <> 'invited'`,
      ),
    );
  setPersonalAudience(
    res.id,
    res.ownerUserId,
    [...grants, ...visits].map((r) => r.userId),
  );
}

/** 订阅项目时整批加载：所有个人文档、论文的受众 */
export async function loadProjectAudiences(ctx: AppContext, projectId: string) {
  const docs = await ctx.db.db
    .select({ id: documents.id, ownerUserId: documents.ownerUserId })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.space, 'personal')));
  const pps = await ctx.db.db
    .select({ id: papers.id, ownerUserId: papers.ownerUserId })
    .from(papers)
    .where(and(eq(papers.projectId, projectId), eq(papers.space, 'personal')));
  const all = new Map<string, { owner: string | null; users: Set<string> }>();
  for (const r of [...docs, ...pps]) all.set(r.id, { owner: r.ownerUserId, users: new Set() });
  if (all.size > 0) {
    const grants = await ctx.db.db
      .select({ id: shareGrants.resourceId, userId: shareGrants.userId })
      .from(shareGrants)
      .where(eq(shareGrants.projectId, projectId));
    const visits = await ctx.db.db
      .select({ id: shareVisits.resourceId, userId: shareVisits.userId })
      .from(shareVisits)
      .innerJoin(
        shareLinks,
        and(
          eq(shareLinks.resourceKind, shareVisits.resourceKind),
          eq(shareLinks.resourceId, shareVisits.resourceId),
          eq(shareLinks.token, shareVisits.token),
        ),
      )
      .where(and(eq(shareLinks.projectId, projectId), sql`${shareLinks.scope} <> 'invited'`));
    for (const r of [...grants, ...visits]) all.get(r.id)?.users.add(r.userId);
  }
  for (const [id, a] of all) setPersonalAudience(id, a.owner, a.users);
}

/** 分享变化后：更新受众、断开在线协同连接（重连按新权限鉴权）、通知客户端刷新 */
async function afterChange(
  ctx: AppContext,
  res: SharedResource,
  actor: ActorRef,
  reason: 'link' | 'grants' | 'space',
) {
  await refreshAudience(ctx, res);
  if (res.kind === 'document') closeDocumentConnections(ctx, res.id);
  await ctx.bus.publish({
    projectId: res.projectId,
    threadId: null,
    type: 'share.updated',
    payload: { resourceKind: res.kind, resourceId: res.id, reason },
    actor,
  });
}

export async function notifySpaceChanged(ctx: AppContext, res: SharedResource, actor: ActorRef) {
  await afterChange(ctx, res, actor, 'space');
}

/** 资源移入团队空间或被删除：分享关系全部作废 */
export async function clearSharing(ctx: AppContext, kind: ShareResourceKind, ids: string[]) {
  if (ids.length === 0) return;
  await ctx.db.db
    .delete(shareLinks)
    .where(and(eq(shareLinks.resourceKind, kind), inArray(shareLinks.resourceId, ids)));
  await ctx.db.db
    .delete(shareGrants)
    .where(and(eq(shareGrants.resourceKind, kind), inArray(shareGrants.resourceId, ids)));
  await ctx.db.db
    .delete(shareVisits)
    .where(and(eq(shareVisits.resourceKind, kind), inArray(shareVisits.resourceId, ids)));
}

// ---------------------------------------------------------------- 读设置

const newToken = () => randomBytes(18).toString('base64url');

async function linkRow(ctx: AppContext, res: SharedResource) {
  const [row] = await ctx.db.db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.resourceKind, res.kind), eq(shareLinks.resourceId, res.id)));
  return row ?? null;
}

async function grantList(ctx: AppContext, res: SharedResource): Promise<ShareGrant[]> {
  const rows = await ctx.db.db
    .select({
      userId: shareGrants.userId,
      level: shareGrants.level,
      createdAt: shareGrants.createdAt,
      name: users.name,
      email: users.email,
      avatarColor: users.avatarColor,
      member: projectMembers.userId,
    })
    .from(shareGrants)
    .innerJoin(users, eq(users.id, shareGrants.userId))
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, shareGrants.projectId),
        eq(projectMembers.userId, shareGrants.userId),
      ),
    )
    .where(and(eq(shareGrants.resourceKind, res.kind), eq(shareGrants.resourceId, res.id)))
    .orderBy(shareGrants.createdAt);
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    avatarColor: r.avatarColor,
    level: r.level,
    external: !r.member,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getShareSettings(
  ctx: AppContext,
  res: LoadedResource,
  access: AccessLevel,
): Promise<ShareSettings> {
  const link = res.space === 'personal' ? await linkRow(ctx, res) : null;
  let ownerName: string | null = null;
  if (res.ownerUserId) {
    const [u] = await ctx.db.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, res.ownerUserId));
    ownerName = u?.name ?? null;
  }
  const manage = access === 'manage';
  return {
    resourceKind: res.kind,
    resourceId: res.id,
    projectId: res.projectId,
    space: res.space,
    ownerUserId: res.ownerUserId,
    ownerName,
    access,
    link: {
      scope: link?.scope ?? 'invited',
      level: link?.level ?? 'view',
      token: manage ? (link?.token ?? null) : null,
    },
    grants: res.space === 'personal' ? await grantList(ctx, res) : [],
  };
}

function assertPersonal(res: LoadedResource) {
  if (res.space !== 'personal') {
    throw new ApiError(
      'conflict',
      '团队空间的内容对课题成员都可见，不需要单独分享；移到个人空间后才能设置分享',
    );
  }
}

// ---------------------------------------------------------------- 写设置

export async function updateLink(
  ctx: AppContext,
  user: GuardUser,
  res: LoadedResource,
  input: ShareLinkUpdateInput,
): Promise<ShareSettings> {
  assertPersonal(res);
  const current = await linkRow(ctx, res);
  const now = new Date();
  if (current) {
    await ctx.db.db
      .update(shareLinks)
      .set({
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.level ? { level: input.level } : {}),
        updatedBy: user.id,
        updatedAt: now,
      })
      .where(and(eq(shareLinks.resourceKind, res.kind), eq(shareLinks.resourceId, res.id)));
  } else {
    await ctx.db.db.insert(shareLinks).values({
      resourceKind: res.kind,
      resourceId: res.id,
      projectId: res.projectId,
      scope: input.scope ?? 'invited',
      level: input.level ?? 'view',
      token: newToken(),
      updatedBy: user.id,
    });
  }
  await afterChange(ctx, res, actorOf(user), 'link');
  return getShareSettings(ctx, res, 'manage');
}

/** 重置链接：换新 token，旧链接和通过旧链接获得的访问权立即失效 */
export async function resetLink(
  ctx: AppContext,
  user: GuardUser,
  res: LoadedResource,
): Promise<ShareSettings> {
  assertPersonal(res);
  const current = await linkRow(ctx, res);
  if (!current) return updateLink(ctx, user, res, {});
  await ctx.db.db
    .update(shareLinks)
    .set({ token: newToken(), updatedBy: user.id, updatedAt: new Date() })
    .where(and(eq(shareLinks.resourceKind, res.kind), eq(shareLinks.resourceId, res.id)));
  await ctx.db.db
    .delete(shareVisits)
    .where(and(eq(shareVisits.resourceKind, res.kind), eq(shareVisits.resourceId, res.id)));
  await afterChange(ctx, res, actorOf(user), 'link');
  return getShareSettings(ctx, res, 'manage');
}

const actorOf = (user: GuardUser): ActorRef => ({ kind: 'user', id: user.id, name: user.name });

const LEVEL_TEXT: Record<ShareLevel, string> = {
  view: '可阅读',
  comment: '可评论',
  edit: '可编辑',
};

export async function addGrants(
  ctx: AppContext,
  user: GuardUser,
  res: LoadedResource,
  input: ShareGrantInput,
): Promise<ShareSettings> {
  assertPersonal(res);
  const data = ShareGrantInput.parse(input);
  // 成员 id 只接受本课题成员；课题外的人用研协账号邮箱邀请
  const memberRows = data.userIds.length
    ? await ctx.db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, res.projectId),
            inArray(projectMembers.userId, data.userIds),
          ),
        )
    : [];
  const found = new Set(memberRows.map((r) => r.userId));
  const missing = data.userIds.filter((id) => !found.has(id));
  if (missing.length) throw new ApiError('validation_failed', '只能按成员邀请本课题的成员');
  const emails = [...new Set(data.emails.map((e) => e.toLowerCase()))];
  if (emails.length) {
    const rows = await ctx.db.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, emails));
    const byEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
    const unknown = emails.filter((e) => !byEmail.has(e));
    if (unknown.length) {
      throw new ApiError('validation_failed', `没有找到这个邮箱的研协账号：${unknown.join('、')}`);
    }
    for (const id of byEmail.values()) found.add(id);
  }
  found.delete(res.ownerUserId ?? '');
  if (found.size === 0) throw new ApiError('validation_failed', '不需要邀请自己');
  const ids = [...found];
  for (const userId of ids) {
    await ctx.db.db
      .insert(shareGrants)
      .values({
        resourceKind: res.kind,
        resourceId: res.id,
        projectId: res.projectId,
        userId,
        level: data.level,
        grantedBy: user.id,
      })
      .onConflictDoUpdate({
        target: [shareGrants.resourceKind, shareGrants.resourceId, shareGrants.userId],
        set: { level: data.level },
      });
  }
  await afterChange(ctx, res, actorOf(user), 'grants');
  // 课题成员收到一条提醒（课题外的人没有这个课题的收件箱，由所有者把链接发给他）
  const members = await ctx.db.db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, res.projectId), inArray(projectMembers.userId, ids)));
  for (const m of members) {
    await createInboxItem(ctx, {
      projectId: res.projectId,
      userId: m.userId,
      kind: 'mention',
      title: `${user.name} 把${NAME[res.kind]}《${res.title}》分享给了你（${LEVEL_TEXT[data.level]}）`,
      href: resourceHref(res),
      sourceId: `share:${res.id}:${m.userId}`,
    }).catch(() => undefined);
  }
  return getShareSettings(ctx, res, 'manage');
}

export const resourceHref = (res: Pick<SharedResource, 'kind' | 'id' | 'projectId'>) =>
  res.kind === 'document'
    ? `/p/${res.projectId}/docs/${res.id}`
    : `/p/${res.projectId}/library/${res.id}`;

export async function updateGrant(
  ctx: AppContext,
  user: GuardUser,
  res: LoadedResource,
  userId: string,
  level: ShareLevel,
): Promise<ShareSettings> {
  assertPersonal(res);
  const updated = await ctx.db.db
    .update(shareGrants)
    .set({ level })
    .where(
      and(
        eq(shareGrants.resourceKind, res.kind),
        eq(shareGrants.resourceId, res.id),
        eq(shareGrants.userId, userId),
      ),
    )
    .returning();
  if (updated.length === 0) throw new ApiError('not_found', '这个人不在分享名单里');
  await afterChange(ctx, res, actorOf(user), 'grants');
  return getShareSettings(ctx, res, 'manage');
}

export async function removeGrant(
  ctx: AppContext,
  user: GuardUser,
  res: LoadedResource,
  userId: string,
): Promise<ShareSettings> {
  assertPersonal(res);
  await ctx.db.db
    .delete(shareGrants)
    .where(
      and(
        eq(shareGrants.resourceKind, res.kind),
        eq(shareGrants.resourceId, res.id),
        eq(shareGrants.userId, userId),
      ),
    );
  await afterChange(ctx, res, actorOf(user), 'grants');
  return getShareSettings(ctx, res, 'manage');
}

// ---------------------------------------------------------------- 打开链接

/**
 * 打开分享链接：链接范围允许时记下访问（之后凭这条记录访问，直到链接关闭或重置），
 * 返回资源位置和当前用户的权限。链接不存在 / 已重置 → 404；链接已关闭且没被邀请 → 403。
 */
export async function resolveShareToken(
  ctx: AppContext,
  token: string,
  user: GuardUser,
): Promise<ShareResolveResult> {
  const [link] = await ctx.db.db.select().from(shareLinks).where(eq(shareLinks.token, token));
  const res = link ? await loadResource(ctx, link.resourceKind, link.resourceId) : null;
  if (!link || !res || res.space !== 'personal') {
    throw new ApiError('not_found', '链接已失效：可能已被重置，或内容已被删除');
  }
  assertTokenProject(user.token, res.projectId);
  const [activeProject] = await ctx.db.db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, res.projectId));
  if (!activeProject || activeProject.archivedAt) throw new ApiError('not_found', '项目不存在');
  const role = await memberRole(ctx, res.projectId, user.id);
  const viewer: Viewer = { userId: user.id, role };
  const open = link.scope === 'anyone' || (link.scope === 'project' && role !== null);
  if (open && res.ownerUserId !== user.id) {
    await ctx.db.db
      .insert(shareVisits)
      .values({ resourceKind: res.kind, resourceId: res.id, userId: user.id, token })
      .onConflictDoUpdate({
        target: [shareVisits.resourceKind, shareVisits.resourceId, shareVisits.userId],
        set: { token, visitedAt: new Date() },
      });
    await refreshAudience(ctx, res);
  }
  const access = await accessOf(ctx, res, viewer);
  if (access === 'none') {
    throw new ApiError(
      'forbidden',
      link.scope === 'project'
        ? '这个链接只对课题成员开放。可以请所有者直接邀请你。'
        : '这个链接已关闭，只有被邀请的人能访问。可以请所有者邀请你。',
    );
  }
  const [project] = await ctx.db.db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, res.projectId));
  const settings = await getShareSettings(ctx, res, access);
  return {
    projectId: res.projectId,
    projectName: project?.name ?? '',
    resourceKind: res.kind,
    resourceId: res.id,
    title: res.title,
    ownerName: settings.ownerName,
    access,
    member: role !== null,
  };
}
