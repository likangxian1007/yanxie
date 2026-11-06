import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { type ActorRef, type AgentSession, type AgentStep, type Page } from '@srh/shared';
import type { AppContext } from '../../context';
import { agentSessions, agentSteps } from '../../db/schema';

export type SessionRow = typeof agentSessions.$inferSelect;
type StepRow = typeof agentSteps.$inferSelect;

export function toAgentSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    webUrl: row.threadId
      ? `/p/${encodeURIComponent(row.projectId)}/threads/${encodeURIComponent(row.threadId)}`
      : `/p/${encodeURIComponent(row.projectId)}?discussion=project`,
    projectId: row.projectId,
    threadId: row.threadId,
    role: row.role,
    status: row.status,
    model: row.model,
    activity: row.activity,
    workingForUserId: row.workingForUserId,
    tokenUsage: row.tokenUsage,
    effort: row.effort,
    profile: row.profile,
    goal: row.goal,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAgentStep(row: StepRow): AgentStep {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    index: row.index,
    kind: row.kind,
    name: row.name,
    content: row.content,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

export const SYSTEM_ACTOR: ActorRef = { kind: 'system', id: null, name: '系统' };

/** 更新会话字段并发 agent.updated */
export async function updateSession(
  ctx: AppContext,
  sessionId: string,
  set: Partial<SessionRow>,
  actor: ActorRef = SYSTEM_ACTOR,
): Promise<SessionRow | null> {
  const [row] = await ctx.db.db
    .update(agentSessions)
    .set({ ...set, lastActivityAt: new Date() })
    .where(eq(agentSessions.id, sessionId))
    .returning();
  if (!row) return null;
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.threadId,
    type: 'agent.updated',
    payload: toAgentSession(row),
    actor,
  });
  return row;
}

export async function getSession(ctx: AppContext, projectId: string, sessionId: string) {
  const [row] = await ctx.db.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)));
  return row ?? null;
}

export async function listSteps(
  ctx: AppContext,
  sessionId: string,
  q: {
    cursor?: string | undefined;
    limit: number;
    turnId?: string | undefined;
    order: 'asc' | 'desc';
  },
): Promise<Page<AgentStep>> {
  const conds = [eq(agentSteps.sessionId, sessionId)];
  if (q.turnId) conds.push(eq(agentSteps.turnId, q.turnId));
  if (q.cursor)
    conds.push(q.order === 'asc' ? gt(agentSteps.id, q.cursor) : lt(agentSteps.id, q.cursor));
  const rows = await ctx.db.db
    .select()
    .from(agentSteps)
    .where(and(...conds))
    .orderBy(q.order === 'asc' ? asc(agentSteps.id) : desc(agentSteps.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(toAgentStep),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
