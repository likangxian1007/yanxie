import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import { type papers, projects } from '../../db/schema';
import { apiTokenFor, requireUser, requireProject } from '../auth/guard';
import { memberRole } from '../collab-common/guard';
import { accessOf } from '../sharing/access';
import { requireResource } from '../sharing/service';

/** Account-wide records are outside every project-limited API token. */
export async function requirePersonalLibraryUser(req: FastifyRequest) {
  const user = await requireUser(req);
  const token = await apiTokenFor(req);
  if (token?.projectIds.length) throw new ApiError('not_found', '此令牌不能访问账号个人文献库');
  return user;
}

/** Existing team-library collaboration includes guests; private resources retain sharing permissions. */
export async function requirePaperRecord(
  req: FastifyRequest,
  projectId: string,
  paperId: string,
  edit: boolean,
) {
  const access = await requireResource(req, projectId, 'paper', paperId, 'view');
  if (access.res.space === 'team') {
    await requireProject(req, projectId, 'view');
  } else if (edit && access.access !== 'edit' && access.access !== 'manage') {
    throw new ApiError('forbidden', '此个人文献的分享权限不允许编辑');
  }
  return access;
}

export async function paperRecordAccess(
  ctx: AppContext,
  paper: typeof papers.$inferSelect,
  userId: string,
): Promise<'none' | 'view' | 'edit'> {
  if (!paper.projectId)
    return paper.ownerUserId !== userId ? 'none' : paper.archivedAt ? 'view' : 'edit';
  const [project] = await ctx.db.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, paper.projectId), isNull(projects.archivedAt)));
  if (!project) return 'none';
  const role = await memberRole(ctx, paper.projectId, userId);
  if (paper.space === 'team') return !role ? 'none' : paper.archivedAt ? 'view' : 'edit';
  const access = await accessOf(
    ctx,
    {
      kind: 'paper',
      id: paper.id,
      projectId: paper.projectId,
      space: paper.space,
      ownerUserId: paper.ownerUserId,
    },
    { userId, role },
  );
  return access === 'none'
    ? 'none'
    : paper.archivedAt || (access !== 'edit' && access !== 'manage')
      ? 'view'
      : 'edit';
}
