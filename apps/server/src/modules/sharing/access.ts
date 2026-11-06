import { and, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  maxAccess,
  type AccessLevel,
  type ProjectRole,
  type ResourceSpace,
  type ShareLevel,
  type ShareResourceKind,
  type SpaceFilter,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { shareGrants, shareLinks, shareVisits } from '../../db/schema';

/**
 * 个人 / 团队空间的权限判定（文档与论文共用）。
 *
 * 观看者（Viewer）：
 * - 人：userId + 在这个项目里的角色（不是成员为 null，例如通过「知道链接的人」进来的外部账号）
 * - agent：个人会话 = 代表主人（主人的 userId + 角色）；协调者与团队线程 = TEAM_VIEWER，
 *   只看团队空间（userId 为 null，个人空间一律不可见）
 *
 * 判定：
 * - 团队空间：项目成员按角色（访客只读，其余可编辑）；非成员无权。
 * - 个人空间：所有者（仍是项目成员）= manage；被邀请的人 = 邀请时的级别；
 *   通过链接打开过、且 token 仍有效、链接范围仍允许的人 = 链接级别；取最高。
 *   项目负责人 / 导师也看不到别人的个人空间（和飞书一致）。
 */
export interface Viewer {
  userId: string | null;
  role: ProjectRole | null;
}

/** 协调者、团队线程：只看团队空间 */
export const TEAM_VIEWER: Viewer = { userId: null, role: 'member' };

export interface SharedResource {
  kind: ShareResourceKind;
  id: string;
  projectId: string;
  space: ResourceSpace;
  ownerUserId: string | null;
}

export function teamAccess(role: ProjectRole | null): AccessLevel {
  if (!role) return 'none';
  return role === 'guest' ? 'view' : 'edit';
}

/** 链接范围是否允许这个观看者通过链接访问 */
function linkAllows(scope: string, viewer: Viewer): boolean {
  if (scope === 'anyone') return true;
  if (scope === 'project') return viewer.role !== null;
  return false;
}

export async function accessOf(
  ctx: AppContext,
  res: SharedResource,
  viewer: Viewer,
): Promise<AccessLevel> {
  if (res.space === 'team') return teamAccess(viewer.role);
  if (!viewer.userId) return 'none';
  if (res.ownerUserId === viewer.userId) return viewer.role ? 'manage' : 'none';
  const [grant] = await ctx.db.db
    .select({ level: shareGrants.level })
    .from(shareGrants)
    .where(
      and(
        eq(shareGrants.resourceKind, res.kind),
        eq(shareGrants.resourceId, res.id),
        eq(shareGrants.userId, viewer.userId),
      ),
    );
  const [link] = await ctx.db.db
    .select({ scope: shareLinks.scope, level: shareLinks.level })
    .from(shareLinks)
    .innerJoin(
      shareVisits,
      and(
        eq(shareVisits.resourceKind, shareLinks.resourceKind),
        eq(shareVisits.resourceId, shareLinks.resourceId),
        eq(shareVisits.token, shareLinks.token),
      ),
    )
    .where(
      and(
        eq(shareLinks.resourceKind, res.kind),
        eq(shareLinks.resourceId, res.id),
        eq(shareVisits.userId, viewer.userId),
      ),
    );
  const viaLink: ShareLevel | null = link && linkAllows(link.scope, viewer) ? link.level : null;
  return maxAccess(grant?.level, viaLink);
}

/** 一批个人资源的访问级别（列表标注用）；团队资源直接按角色算 */
export async function accessMap(
  ctx: AppContext,
  kind: ShareResourceKind,
  rows: { id: string; space: ResourceSpace; ownerUserId: string | null }[],
  viewer: Viewer,
): Promise<Map<string, AccessLevel>> {
  const out = new Map<string, AccessLevel>();
  const others: string[] = [];
  for (const r of rows) {
    if (r.space === 'team') out.set(r.id, teamAccess(viewer.role));
    else if (!viewer.userId) out.set(r.id, 'none');
    else if (r.ownerUserId === viewer.userId) out.set(r.id, viewer.role ? 'manage' : 'none');
    else others.push(r.id);
  }
  if (others.length === 0 || !viewer.userId) return out;
  const grants = await ctx.db.db
    .select({ id: shareGrants.resourceId, level: shareGrants.level })
    .from(shareGrants)
    .where(
      and(
        eq(shareGrants.resourceKind, kind),
        inArray(shareGrants.resourceId, others),
        eq(shareGrants.userId, viewer.userId),
      ),
    );
  const links = await ctx.db.db
    .select({ id: shareLinks.resourceId, scope: shareLinks.scope, level: shareLinks.level })
    .from(shareLinks)
    .innerJoin(
      shareVisits,
      and(
        eq(shareVisits.resourceKind, shareLinks.resourceKind),
        eq(shareVisits.resourceId, shareLinks.resourceId),
        eq(shareVisits.token, shareLinks.token),
      ),
    )
    .where(
      and(
        eq(shareLinks.resourceKind, kind),
        inArray(shareLinks.resourceId, others),
        eq(shareVisits.userId, viewer.userId),
      ),
    );
  for (const id of others) out.set(id, 'none');
  for (const g of grants) out.set(g.id, maxAccess(out.get(g.id), g.level));
  for (const l of links) {
    if (linkAllows(l.scope, viewer)) out.set(l.id, maxAccess(out.get(l.id), l.level));
  }
  return out;
}

/**
 * 列表查询的可见性条件（SQL）。cols 是资源表的 id / space / owner_user_id 列。
 * filter：team 团队空间、personal 我的空间、shared 别人分享给我的、all 全部可见。
 */
export function visibleWhere(
  kind: ShareResourceKind,
  cols: { id: AnyColumn; space: AnyColumn; ownerUserId: AnyColumn },
  viewer: Viewer,
  filter: SpaceFilter = 'all',
): SQL {
  const team = viewer.role ? sql`${cols.space} = 'team'` : sql`false`;
  if (!viewer.userId) return filter === 'team' || filter === 'all' ? team : sql`false`;
  const uid = viewer.userId;
  const mine = viewer.role
    ? sql`(${cols.space} = 'personal' and ${cols.ownerUserId} = ${uid})`
    : sql`false`;
  const isMember = viewer.role ? sql`true` : sql`false`;
  const shared = sql`(${cols.space} = 'personal' and ${cols.ownerUserId} is distinct from ${uid} and (
    exists (select 1 from ${shareGrants} g where g.resource_kind = ${kind} and g.resource_id = ${cols.id} and g.user_id = ${uid})
    or exists (select 1 from ${shareLinks} l join ${shareVisits} v
      on v.resource_kind = l.resource_kind and v.resource_id = l.resource_id and v.token = l.token
      where l.resource_kind = ${kind} and l.resource_id = ${cols.id} and v.user_id = ${uid}
        and (l.scope = 'anyone' or (l.scope = 'project' and ${isMember})))
  ))`;
  switch (filter) {
    case 'team':
      return team;
    case 'personal':
      return mine;
    case 'shared':
      return shared;
    default:
      return sql`(${team} or ${mine} or ${shared})`;
  }
}

/** 一批个人资源里哪些已经分享出去了（邀请了人或开了链接）——所有者列表上的标记 */
export async function sharedIds(
  ctx: AppContext,
  kind: ShareResourceKind,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const g = await ctx.db.db
    .selectDistinct({ id: shareGrants.resourceId })
    .from(shareGrants)
    .where(and(eq(shareGrants.resourceKind, kind), inArray(shareGrants.resourceId, ids)));
  const l = await ctx.db.db
    .select({ id: shareLinks.resourceId })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.resourceKind, kind),
        inArray(shareLinks.resourceId, ids),
        sql`${shareLinks.scope} <> 'invited'`,
      ),
    );
  return new Set([...g, ...l].map((r) => r.id));
}
