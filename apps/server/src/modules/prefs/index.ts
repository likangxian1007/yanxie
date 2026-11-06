import { and, eq, isNull, sql } from 'drizzle-orm';
import { PinsUpdateInput, type MyPins } from '@srh/shared';
import { projectMembers, projects, userPins } from '../../db/schema';
import { parse } from '../../lib/http';
import { apiTokenFor, tokenAllowsProject, requireProject, requireUser } from '../auth/guard';
import type { ModuleDef } from '../types';

/**
 * 跟账号走的个人偏好（API.md §2.1）：目前只有置顶。
 * 只属于本人，别人看不到，所以不发项目事件；换设备时前端重新拉取即可。
 */
type P = { projectId: string };

/** 去重并保留顺序（越靠前越新） */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export const prefsModule: ModuleDef = {
  name: 'prefs',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    // 我在各个项目里的置顶；只返回我还是成员、没归档的项目
    app.get('/auth/me/pins', async (req): Promise<MyPins> => {
      const user = await requireUser(req);
      const rows = await ctx.db.db
        .select({ projectId: userPins.projectId, ids: userPins.ids })
        .from(userPins)
        .innerJoin(
          projectMembers,
          and(
            eq(projectMembers.projectId, userPins.projectId),
            eq(projectMembers.userId, userPins.userId),
          ),
        )
        .innerJoin(projects, eq(projects.id, userPins.projectId))
        .where(and(eq(userPins.userId, user.id), isNull(projects.archivedAt)));
      const out: MyPins = {};
      const token = await apiTokenFor(req);
      for (const r of rows)
        if (r.ids.length && tokenAllowsProject(token, r.projectId)) out[r.projectId] = r.ids;
      return out;
    });

    // 整组替换某项目的置顶（访客也能置顶：这是个人界面偏好，不改项目内容）
    app.put<{ Params: P }>('/auth/me/pins/:projectId', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const ids = dedupe(parse(PinsUpdateInput, req.body).ids);
      await ctx.db.db
        .insert(userPins)
        .values({ userId: user.id, projectId: req.params.projectId, ids })
        .onConflictDoUpdate({
          target: [userPins.userId, userPins.projectId],
          set: { ids, updatedAt: sql`now()` },
        });
      return { projectId: req.params.projectId, ids };
    });
  },
};
