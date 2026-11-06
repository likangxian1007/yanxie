import { and, desc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { ApiError, INBOX_PRIORITY, InboxQuery, InboxUpdateInput } from '@srh/shared';
import { inboxItems, projectMembers, projects } from '../../db/schema';
import { parse } from '../../lib/http';
import { apiTokenFor, requireProject, requireUser, userActor } from '../auth/guard';
import type { ModuleDef } from '../types';
import { assertTokenProject } from '../integrations/service';
import { trackOperationProject } from '../integrations/runtime';
import { toInboxItem } from './service';

/**
 * 待我处理收件箱（API.md §2.6）。
 * 归属：后端与 agent 引擎线程。条目由各模块经 service 的 createInboxItem 生成。
 *
 *   GET   /inbox          只看自己的条目，按优先级（INBOX_PRIORITY）再按时间倒序
 *   PATCH /inbox/:itemId  标记已读 / 完成
 */
export const inboxModule: ModuleDef = {
  name: 'inbox',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get('/inbox', async (req) => {
      const user = await requireUser(req);
      const q = parse(InboxQuery, req.query);
      if (q.projectId) await requireProject(req, q.projectId, 'view');
      const conds: SQL[] = [eq(inboxItems.userId, user.id), isNull(projects.archivedAt)];
      if (q.projectId) conds.push(eq(inboxItems.projectId, q.projectId));
      // 令牌限项目（API.md §2.21）：不带 projectId 时也只看限定范围内的条目
      const token = await apiTokenFor(req);
      if (!q.projectId && token && token.projectIds.length > 0) {
        conds.push(inArray(inboxItems.projectId, token.projectIds));
      }
      conds.push(q.done ? isNotNull(inboxItems.doneAt) : isNull(inboxItems.doneAt));
      // 只返回仍是成员的项目里的条目
      const rows = await ctx.db.db
        .select({ item: inboxItems })
        .from(inboxItems)
        .innerJoin(
          projectMembers,
          and(
            eq(projectMembers.projectId, inboxItems.projectId),
            eq(projectMembers.userId, inboxItems.userId),
          ),
        )
        .innerJoin(projects, eq(projects.id, inboxItems.projectId))
        .where(and(...conds))
        .orderBy(desc(inboxItems.createdAt));
      return rows
        .map((r) => r.item)
        .sort(
          (a, b) =>
            INBOX_PRIORITY[a.kind] - INBOX_PRIORITY[b.kind] ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : -1),
        )
        .map(toInboxItem);
    });

    app.patch<{ Params: { itemId: string } }>('/inbox/:itemId', async (req) => {
      const user = await requireUser(req);
      const input = parse(InboxUpdateInput, req.body);
      const [row] = await ctx.db.db
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.id, req.params.itemId), eq(inboxItems.userId, user.id)));
      if (!row) throw new ApiError('not_found', '收件箱条目不存在');
      assertTokenProject(await apiTokenFor(req), row.projectId);
      await requireProject(req, row.projectId, 'view');
      trackOperationProject(req, row.projectId);
      const now = new Date();
      const patch: { readAt?: Date | null; doneAt?: Date | null } = {};
      if (input.read !== undefined) patch.readAt = input.read ? (row.readAt ?? now) : null;
      if (input.done !== undefined) patch.doneAt = input.done ? (row.doneAt ?? now) : null;
      if (Object.keys(patch).length === 0) return toInboxItem(row);
      const { item, ev } = await ctx.db.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(inboxItems)
          .set(patch)
          .where(eq(inboxItems.id, row.id))
          .returning();
        const item = toInboxItem(updated!);
        const ev = await ctx.bus.record(tx, {
          projectId: item.projectId,
          type: 'inbox.updated',
          payload: item,
          actor: userActor(user),
        });
        return { item, ev };
      });
      ctx.bus.emit(ev);
      return item;
    });
  },
};
