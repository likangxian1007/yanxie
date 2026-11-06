import { and, eq } from 'drizzle-orm';
import { ApiError, type ActorRef } from '@srh/shared';
import type { Db } from '../../db/client';
import { agentSessions, threads } from '../../db/schema';

/**
 * 协作对象（卡片、实验、审阅……）上关联字段的校验：被关联的线程 / 实验必须在本项目里，
 * 个人线程只有它的主人能关联。
 */

type Exec = Pick<Db, 'select'>;

function invalid(path: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path, message }] });
}

/**
 * 个人线程能否被 actor 关联：人 = 必须是主人；
 * agent = 就住在这个线程里，或者它代表的成员（workingForUserId）是主人。
 */
async function canLinkPersonal(
  exec: Exec,
  actor: ActorRef,
  thread: { id: string; ownerUserId: string | null },
): Promise<boolean> {
  if (!thread.ownerUserId || !actor.id) return false;
  if (actor.kind === 'user') return actor.id === thread.ownerUserId;
  if (actor.kind !== 'agent') return false;
  const [session] = await exec
    .select({ threadId: agentSessions.threadId, workingFor: agentSessions.workingForUserId })
    .from(agentSessions)
    .where(eq(agentSessions.id, actor.id));
  if (!session) return false;
  return session.threadId === thread.id || session.workingFor === thread.ownerUserId;
}

/**
 * threadId 必须是本项目的线程（否则 422）；个人线程只有主人能关联（否则 403）。
 * threadId 为空 / null 时不检查。
 */
export async function assertLinkableThread(
  exec: Exec,
  actor: ActorRef,
  projectId: string,
  threadId: string | null | undefined,
  field = 'threadId',
): Promise<void> {
  if (!threadId) return;
  const [thread] = await exec
    .select({ id: threads.id, kind: threads.kind, ownerUserId: threads.ownerUserId })
    .from(threads)
    .where(and(eq(threads.projectId, projectId), eq(threads.id, threadId)));
  if (!thread) invalid(field, '关联的线程在本项目里不存在，请检查线程 id');
  if (thread.kind === 'personal' && !(await canLinkPersonal(exec, actor, thread))) {
    throw new ApiError('forbidden', '这是别人的个人线程，只有它的主人可以关联');
  }
}

/** experimentId 必须是本项目的实验记录，否则 422。为空 / null 时不检查。 */
export async function assertExperimentInProject(
  _exec: Exec,
  _projectId: string,
  experimentId: string | null | undefined,
  field = 'experimentId',
): Promise<void> {
  if (!experimentId) return;
  invalid(field, '实验功能已移除');
}
