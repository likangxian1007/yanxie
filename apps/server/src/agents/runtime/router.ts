import { and, eq, gt, sql } from 'drizzle-orm';
import type { AnyProjectEvent, WorkClaim } from '@srh/shared';
import type { AppContext } from '../../context';
import { agentSessions, agentWakeups, events, threads } from '../../db/schema';
import type { SessionRow } from '../tools/types';
import { enqueueWake } from './wake';

/**
 * 路由器：总线事件 → 唤醒哪个会话（ARCHITECTURE §7.2.1）。
 *
 * | 事件                                  | 唤醒                                                              |
 * | ------------------------------------- | ----------------------------------------------------------------- |
 * | 成员在时间线发言（agentVisible）       | 协调者 mention（principal）；转发卡片 → forward                    |
 * | 成员在项目线程发言                     | 线程 agent mention（principal）；协调者 thread-activity（只知情）  |
 * | 线程 agent 在项目线程回复              | 协调者 thread-activity（只知情，不单独触发 turn）                  |
 * | 成员在个人会话发言                     | 个人 agent mention                                                 |
 * | decision.updated（成员回答/撤回）      | 卡片所在线程 decision-answered                                     |
 * | review.updated / comment_created      | 事件 threadId 所在线程 review-updated                              |
 * | claim.conflict                        | 被重叠认领的持有会话 claim-conflict                                |
 * | claim.updated（released / expired）    | 24 小时内撞上这条认领、没认领成功的 agent claim-released           |
 * | card/todo 指派给 agent:…              | 对应会话 assignment                                                |
 * 线程 agent 自己写的消息不唤醒自己；旁聊（agentVisible=false）不唤醒任何人。
 */
const ROLE_LABEL: Record<string, string> = {
  owner: '负责人',
  member: '成员',
  advisor: '导师',
  guest: '访客',
};

export function createRouter(ctx: AppContext) {
  const sessionCache = new Map<string, SessionRow>();

  async function coordinatorOf(projectId: string) {
    const [row] = await ctx.db.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, projectId), eq(agentSessions.role, 'coordinator')));
    return row ?? null;
  }
  async function sessionOfThread(threadId: string) {
    const hit = sessionCache.get(threadId);
    if (hit) return hit;
    const [row] = await ctx.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.threadId, threadId));
    if (row) sessionCache.set(threadId, row);
    return row ?? null;
  }
  async function threadKind(threadId: string) {
    const [t] = await ctx.db.db
      .select({ kind: threads.kind, resolved: threads.resolved })
      .from(threads)
      .where(eq(threads.id, threadId));
    return t ?? null;
  }

  async function route(event: AnyProjectEvent): Promise<void> {
    switch (event.type) {
      case 'message.created': {
        const m = event.payload;
        if (m.kind === 'activity' || m.author.kind === 'system') return;
        if (!m.threadId) {
          if (m.author.kind !== 'user' || !m.agentVisible) return;
          const coord = await coordinatorOf(m.projectId);
          if (!coord) return;
          await enqueueWake(ctx, coord, m.kind === 'forward' ? 'forward' : 'mention', {
            type: 'message',
            messageId: m.id,
            trust: 'principal',
          });
          return;
        }
        const t = await threadKind(m.threadId);
        if (!t) return;
        const session = await sessionOfThread(m.threadId);
        if (m.author.kind === 'user') {
          if (!m.agentVisible) return;
          // 个人会话的第一条消息由创建流程负责（等 thread.created 之后才有会话）
          if (session) {
            await enqueueWake(ctx, session, 'mention', {
              type: 'message',
              messageId: m.id,
              trust: 'principal',
            });
          }
          if (t.kind === 'project') {
            const coord = await coordinatorOf(m.projectId);
            if (coord) {
              await enqueueWake(
                ctx,
                coord,
                'thread-activity',
                { type: 'message', messageId: m.id, trust: 'peer' },
                false,
              );
            }
          }
          return;
        }
        // agent 写的线程消息：只让协调者知情
        if (t.kind === 'project' && m.author.id !== null) {
          const coord = await coordinatorOf(m.projectId);
          if (coord && coord.id !== m.author.id) {
            await enqueueWake(
              ctx,
              coord,
              'thread-activity',
              { type: 'message', messageId: m.id, trust: 'relay' },
              false,
            );
          }
        }
        return;
      }

      case 'decision.updated': {
        const d = event.payload;
        if (!d.threadId || d.state === 'open' || d.chosenBy?.kind !== 'user') return;
        const session = await sessionOfThread(d.threadId);
        if (!session) return;
        await enqueueWake(ctx, session, 'decision-answered', {
          type: 'decision',
          decisionId: d.id,
          question: d.question,
          chosen: d.chosen,
          label: d.chosen !== null ? (d.options[d.chosen]?.label ?? null) : null,
          by: d.chosenBy.name,
        });
        return;
      }

      case 'review.updated':
      case 'review.comment_created': {
        if (event.actor.kind !== 'user') return;
        const threadId = event.threadId ?? (event.payload as { threadId?: string | null }).threadId;
        if (!threadId) return;
        const session = await sessionOfThread(threadId);
        if (!session) return;
        const p = event.payload as Record<string, unknown>;
        const isComment = event.type === 'review.comment_created';
        // 已关闭（含被新一轮取代）的审阅上的动作不再唤醒 agent
        if (!isComment && p.status === 'closed') return;
        await enqueueWake(ctx, session, 'review-updated', {
          type: 'review',
          reviewId: String(isComment ? p.reviewId : p.id),
          title: String(p.title ?? ''),
          status: String(p.status ?? ''),
          event: isComment ? 'comment' : 'verdict',
          detail: isComment
            ? `${event.actor.name} 评论：${String(p.body ?? '')}`
            : `${event.actor.name} 更新了审阅：${String(p.status ?? '')}`,
        });
        return;
      }

      case 'claim.conflict': {
        const { claim, conflictsWith } = event.payload;
        for (const other of conflictsWith) {
          if (other.holder.kind !== 'agent' || !other.holder.id) continue;
          const [s] = await ctx.db.db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, other.holder.id));
          if (!s) continue;
          await enqueueWake(ctx, s, 'claim-conflict', {
            type: 'claim-conflict',
            claimId: other.id,
            resource: `${claim.resourceKind} ${claim.resourceRef}`,
            byName: claim.holder.name,
            intent: claim.intent,
            threadId: claim.threadId,
          });
        }
        return;
      }

      case 'claim.updated': {
        // 认领放开 / 过期：唤醒之前撞上它而没认领成功的 agent（验收：草稿答应“放开后并入”却没人处理）
        const c = event.payload;
        if (c.status !== 'released' && c.status !== 'expired') return;
        const since = new Date(Date.now() - 24 * 3600 * 1000);
        const blocked = await ctx.db.db
          .select({ payload: events.payload })
          .from(events)
          .where(
            and(
              eq(events.projectId, event.projectId),
              eq(events.type, 'claim.conflict'),
              gt(events.createdAt, since),
              sql`${events.payload}->'conflictsWith' @> ${JSON.stringify([{ id: c.id }])}::jsonb`,
            ),
          );
        const woken = new Set<string>();
        for (const row of blocked) {
          const want = (row.payload as { claim: WorkClaim }).claim;
          if (want.holder.kind !== 'agent' || !want.holder.id || woken.has(want.holder.id))
            continue;
          if (want.holder.id === c.holder.id) continue;
          const [s] = await ctx.db.db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, want.holder.id));
          if (!s) continue;
          if (s.threadId && (await threadKind(s.threadId))?.resolved) continue;
          woken.add(s.id);
          await enqueueWake(ctx, s, 'claim-released', {
            type: 'claim-released',
            claimId: c.id,
            resource: `${c.resourceKind} ${c.resourceRef}`,
            byName: event.actor.name,
            waitingIntent: want.intent || null,
          });
        }
        return;
      }

      case 'card.created':
      case 'card.updated':
      case 'todo.created':
      case 'todo.updated': {
        if (event.actor.kind === 'agent') return;
        const p = event.payload as {
          id: string;
          title: string;
          assigneeIds?: string[];
          assigneeId?: string | null;
        };
        const refs = (p.assigneeIds ?? (p.assigneeId ? [p.assigneeId] : [])).filter((r) =>
          r.startsWith('agent:'),
        );
        for (const ref of refs) {
          const target = ref.slice('agent:'.length);
          const session =
            target === 'coordinator'
              ? await coordinatorOf(event.projectId)
              : await sessionOfThread(target);
          if (!session) continue;
          // 同一对象指派给同一会话只唤醒一次
          const [dup] = await ctx.db.db
            .select({ id: agentWakeups.id })
            .from(agentWakeups)
            .where(
              and(
                eq(agentWakeups.sessionId, session.id),
                eq(agentWakeups.reason, 'assignment'),
                sql`${agentWakeups.item}->>'objectId' = ${p.id}`,
              ),
            )
            .limit(1);
          if (dup) continue;
          await enqueueWake(ctx, session, 'assignment', {
            type: 'assignment',
            objectKind: event.type.startsWith('card') ? 'card' : 'todo',
            objectId: p.id,
            title: p.title,
            by: event.actor.name,
          });
        }
        return;
      }

      case 'member.joined': {
        // 终验 R3 D3：文献线程查成员时导师还没加入，之后一直以为「导师不在」，调研笔记没送审。
        // 有人加入时：告诉协调者；清单里写着在等人加入 / 等这个人的线程直接唤醒，让它重新核对成员。
        const m = event.payload;
        // 建项目时负责人本人加入、访客加入（只能看）：没人会等
        if (m.role === 'owner' || m.role === 'guest') return;
        const roleLabel = ROLE_LABEL[m.role] ?? m.role;
        const who = `${m.user.name}（${roleLabel}）`;
        const coord = await coordinatorOf(event.projectId);
        if (coord) {
          await enqueueWake(ctx, coord, 'member-joined', {
            type: 'system-note',
            text:
              `${who}刚加入了项目。如果有线程或计划在等这个人（比如等导师加入才能送审、等某人提供材料），` +
              '用 message_thread 告诉对应线程现在可以继续；没有就 no_reply_needed。',
          });
        }
        const open = await ctx.db.db
          .select({ id: threads.id, statusText: threads.statusText })
          .from(threads)
          .where(
            and(
              eq(threads.projectId, event.projectId),
              eq(threads.kind, 'project'),
              eq(threads.resolved, false),
            ),
          );
        for (const t of open) {
          if (!/加入|入组|进项目/u.test(t.statusText) && !t.statusText.includes(m.user.name))
            continue;
          const session = await sessionOfThread(t.id);
          if (!session) continue;
          await enqueueWake(ctx, session, 'member-joined', {
            type: 'system-note',
            text:
              `${who}刚加入了项目。你的进度清单里有在等人加入或等这个人的事项：先 list_members 重新核对成员，` +
              '能继续的（比如 request_review 发起审阅）现在就做，并更新清单；之前写的「无法发起」之类的结论要改掉。',
          });
        }
        return;
      }

      case 'thread.created': {
        // 个人会话：建好线程与会话后，第一条消息由 message.created 送达；这里清缓存即可
        sessionCache.delete(event.payload.id);
        return;
      }
      default:
        return;
    }
  }

  return {
    route,
    /** 测试 / 停机 */
    forget: (threadIds: string[]) => threadIds.forEach((id) => sessionCache.delete(id)),
  };
}
