import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiError,
  COORDINATOR_ASSIGNEE,
  assigneeThreadId,
  isAgentAssignee,
  type ActorRef,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { projectMembers, threads } from '../../db/schema';
import { createInboxItem } from '../collab-common/inbox';

/**
 * 指派对象（看板卡片 assigneeIds、待办 assigneeId）的校验与通知，boards 与 todos 共用。
 * 取值：成员 id，或 `agent:coordinator` / `agent:<threadId>`。
 */

function invalid(field: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path: field, message }] });
}

/** 去重并校验：成员必须在项目里，agent 线程必须属于本项目。返回规范化后的列表。 */
export async function validateAssignees(
  exec: Db,
  projectId: string,
  ids: readonly string[],
  field = 'assigneeIds',
): Promise<string[]> {
  const unique = [...new Set(ids.map((v) => v.trim()).filter(Boolean))];
  const memberIds = unique.filter((v) => !isAgentAssignee(v));
  const threadIds: string[] = [];
  for (const v of unique) {
    if (!isAgentAssignee(v) || v === COORDINATOR_ASSIGNEE) continue;
    const threadId = assigneeThreadId(v);
    if (!threadId)
      invalid(field, `指派对象 ${v} 格式不对，应为成员 id、agent:coordinator 或 agent:<线程 id>`);
    threadIds.push(threadId);
  }

  if (memberIds.length) {
    const rows = await exec
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, memberIds)),
      );
    const found = new Set(rows.map((r) => r.userId));
    const missing = memberIds.filter((id) => !found.has(id));
    if (missing.length) invalid(field, '只能指派给项目成员或 agent，请检查指派对象');
  }
  if (threadIds.length) {
    const rows = await exec
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), inArray(threads.id, threadIds)));
    const found = new Set(rows.map((r) => r.id));
    if (threadIds.some((id) => !found.has(id))) {
      invalid(field, '指派的线程不存在，或不属于这个项目');
    }
  }
  return unique;
}

/** after 里有、before 里没有的指派对象 */
export function addedAssignees(before: readonly string[], after: readonly string[]): string[] {
  const prev = new Set(before);
  return after.filter((v) => !prev.has(v));
}

/**
 * 事件的 threadId：对象自身绑定的线程优先；否则本次新增的 `agent:<threadId>` 指派
 * （让路由器唤醒该线程的 agent）；协调者或成员指派为 null。
 */
export function eventThreadId(own: string | null, added: readonly string[]): string | null {
  if (own) return own;
  for (const v of added) {
    const threadId = assigneeThreadId(v);
    if (threadId) return threadId;
  }
  return null;
}

/** 给新增的成员指派（不含操作者本人）写“待我处理”。在事务提交后调用。 */
export async function notifyAssigned(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  added: readonly string[],
  item: { title: string; href: string; sourceId: string },
): Promise<void> {
  for (const userId of added) {
    if (isAgentAssignee(userId)) continue;
    if (actor.kind === 'user' && actor.id === userId) continue;
    await createInboxItem(
      ctx,
      {
        projectId,
        userId,
        kind: 'assignment',
        title: `「${item.title}」指派给了你`,
        href: item.href,
        sourceId: item.sourceId,
      },
      actor,
    );
  }
}
