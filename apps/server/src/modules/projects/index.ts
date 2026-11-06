import { and, count, eq } from 'drizzle-orm';
import {
  ApiError,
  EventsQuery,
  InviteCreateInput,
  MemberUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '@srh/shared';
import { invites, projectMembers, projects } from '../../db/schema';
import { parse } from '../../lib/http';
import { apiTokenFor, requireProject, requireUser } from '../auth/guard';
import type { ModuleDef } from '../types';
import { filterEventsFor } from '../../realtime/access';
import { runProjectArchiveHooks } from './archive-hooks';
import {
  acceptInvite,
  createInvite,
  createProject,
  getMember,
  listMembers,
  listProjectsForUser,
  toInvite,
  toProject,
} from './service';

/**
 * 项目、成员、邀请，以及事件补拉（API.md §2.2、§2.6 的 P/events）。
 */
type P = { projectId: string };

export const projectsModule: ModuleDef = {
  name: 'projects',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get('/projects', async (req) => {
      const user = await requireUser(req);
      const token = await apiTokenFor(req);
      return listProjectsForUser(ctx, user.id, token?.projectIds ?? []);
    });

    app.post('/projects', async (req, reply) => {
      const user = await requireUser(req);
      const input = parse(ProjectCreateInput, req.body);
      const row = await createProject(ctx, { kind: 'user', id: user.id, name: user.name }, input);
      return reply.status(201).send(toProject(row));
    });

    app.get<{ Params: P }>('/projects/:projectId', async (req) => {
      const { project } = await requireProject(req, req.params.projectId, 'view');
      return toProject(project);
    });

    app.patch<{ Params: P }>('/projects/:projectId', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'manage');
      const input = parse(ProjectUpdateInput, req.body);
      delete input.preferredResearchMethods;
      const [row] = await ctx.db.db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projects.id, req.params.projectId))
        .returning();
      const project = toProject(row!);
      await ctx.bus.publish({
        projectId: project.id,
        type: 'project.updated',
        payload: project,
        actor,
      });
      return project;
    });

    // 删除 = 归档（软删除）：成员立即看不到，数据保留以便恢复
    app.delete<{ Params: P }>('/projects/:projectId', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'delete');
      const [row] = await ctx.db.db
        .update(projects)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(projects.id, req.params.projectId))
        .returning();
      await ctx.bus.publish({
        projectId: row!.id,
        type: 'project.updated',
        payload: toProject(row!),
        actor,
      });
      // 回收这个项目占用的内核 / 云电脑容器（后台执行，不拖慢删除）
      void runProjectArchiveHooks(ctx, row!.id);
      return reply.status(204).send();
    });

    app.get<{ Params: P }>('/projects/:projectId/members', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listMembers(ctx, req.params.projectId);
    });

    app.patch<{ Params: P & { userId: string } }>(
      '/projects/:projectId/members/:userId',
      async (req) => {
        const { projectId, userId } = req.params;
        const { role: myRole, actor } = await requireProject(req, projectId, 'manage');
        const input = parse(MemberUpdateInput, req.body);
        const target = await getMember(ctx, projectId, userId);
        if (!target) throw new ApiError('not_found', '该成员不在项目里');
        // advisor 不能动 owner，也不能把人升为 owner
        if (myRole !== 'owner' && (target.role === 'owner' || input.role === 'owner')) {
          throw new ApiError('forbidden', '只有项目所有者可以调整所有者');
        }
        if (target.role === 'owner' && input.role !== 'owner') await assertNotLastOwner(projectId);
        await ctx.db.db
          .update(projectMembers)
          .set({ role: input.role })
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
        const member = (await getMember(ctx, projectId, userId))!;
        await ctx.bus.publish({ projectId, type: 'member.updated', payload: member, actor });
        return member;
      },
    );

    app.delete<{ Params: P & { userId: string } }>(
      '/projects/:projectId/members/:userId',
      async (req, reply) => {
        const { projectId, userId } = req.params;
        const access = await requireProject(req, projectId, 'view');
        const self = access.user.id === userId;
        // 自己可以退出；移除别人需要 manage
        if (!self && access.role !== 'owner' && access.role !== 'advisor') {
          throw new ApiError('forbidden', '你的角色没有管理权限');
        }
        const target = await getMember(ctx, projectId, userId);
        if (!target) throw new ApiError('not_found', '该成员不在项目里');
        if (!self && target.role === 'owner' && access.role !== 'owner') {
          throw new ApiError('forbidden', '只有项目所有者可以移除所有者');
        }
        if (target.role === 'owner') await assertNotLastOwner(projectId);
        await ctx.db.db
          .delete(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
        await ctx.bus.publish({
          projectId,
          type: 'member.removed',
          payload: { userId },
          actor: access.actor,
        });
        return reply.status(204).send();
      },
    );

    app.get<{ Params: P }>('/projects/:projectId/invites', async (req) => {
      await requireProject(req, req.params.projectId, 'manage');
      const rows = await ctx.db.db
        .select()
        .from(invites)
        .where(eq(invites.projectId, req.params.projectId))
        .orderBy(invites.createdAt);
      return rows.map(toInvite);
    });

    app.post<{ Params: P }>('/projects/:projectId/invites', async (req, reply) => {
      const { user } = await requireProject(req, req.params.projectId, 'manage');
      const input = parse(InviteCreateInput, req.body);
      const invite = await createInvite(ctx, req.params.projectId, user.id, input);
      return reply.status(201).send(invite);
    });

    // 撤销邀请：直接删掉这条邀请，之后用这个链接会得到 404「邀请链接无效」
    app.delete<{ Params: P & { inviteId: string } }>(
      '/projects/:projectId/invites/:inviteId',
      async (req, reply) => {
        const { projectId, inviteId } = req.params;
        await requireProject(req, projectId, 'manage');
        const [row] = await ctx.db.db
          .delete(invites)
          .where(and(eq(invites.id, inviteId), eq(invites.projectId, projectId)))
          .returning({ id: invites.id });
        if (!row) throw new ApiError('not_found', '邀请不存在');
        return reply.status(204).send();
      },
    );

    app.post<{ Params: { token: string } }>('/invites/:token/accept', async (req) => {
      const user = await requireUser(req);
      return toProject(await acceptInvite(ctx, req.params.token, user));
    });

    // WS 不可用时的补拉；可见性过滤与 /ws 相同
    app.get<{ Params: P }>('/projects/:projectId/events', async (req, reply) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const q = parse(EventsQuery, req.query);
      const events = await ctx.bus.listSince(req.params.projectId, q.afterSeq, q.limit);
      // 原始页可能全是本人无权读取的事件；扫描游标仍必须前进，不能把空页误当流结束。
      reply.header('X-Next-Event-Seq', String(events.at(-1)?.seq ?? q.afterSeq));
      const rt = { id: user.id, name: user.name, avatarColor: user.avatarColor };
      return filterEventsFor(ctx.access, rt, req.params.projectId, events);
    });

    async function assertNotLastOwner(projectId: string) {
      const [row] = await ctx.db.db
        .select({ n: count() })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'owner')));
      if (Number(row?.n ?? 0) <= 1) {
        throw new ApiError('conflict', '项目至少要保留一位所有者');
      }
    }
  },
};
