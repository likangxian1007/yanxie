import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type {
  ActorRef,
  AnyProjectEvent,
  EphemeralPayload,
  EphemeralType,
  EventPayload,
  EventType,
  ProjectEvent,
} from '@srh/shared';
import type { Db } from '../db/client';
import { events, projects } from '../db/schema';

/**
 * 事件总线：所有写操作的唯一出口。
 *
 *   // 普通写操作（单条语句或不在事务里）
 *   await bus.publish({ projectId, threadId, type: 'message.created', payload: msg, actor });
 *
 *   // 事务里：先 record，提交后再 emit，避免回滚后推出幽灵事件
 *   const ev = await db.transaction(async (tx) => {
 *     ...写业务表...
 *     return bus.record(tx, { ... });
 *   });
 *   bus.emit(ev);
 *
 * 订阅者：/ws 推送（realtime/ws.ts）、agent 唤醒调度（agents/runtime）。
 * 单进程内存广播；将来多实例部署时在这里换成 Postgres LISTEN/NOTIFY，调用方不变。
 */
export interface PublishInput<T extends EventType> {
  projectId: string;
  threadId?: string | null;
  type: T;
  payload: EventPayload<T>;
  actor: ActorRef;
}

export interface EphemeralEvent<T extends EphemeralType = EphemeralType> {
  projectId: string;
  type: T;
  payload: EphemeralPayload<T>;
}

type EventListener = (event: AnyProjectEvent) => void;
type EphemeralListener = (event: EphemeralEvent) => void;

/** 能执行 insert/update 的对象：db 本身或事务 tx */
type Executor = Pick<Db, 'insert' | 'update'>;

export class EventBus {
  private readonly listeners = new Set<EventListener>();
  private readonly ephemeralListeners = new Set<EphemeralListener>();

  constructor(private readonly db: Db) {}

  /**
   * 写入事件表并返回带 seq 的事件（不广播）。必须在事务里调用（publish 会自己开事务）：
   * 先给 projects.event_seq +1 拿到本项目的下一个 seq，这一行锁一直持有到事务提交，
   * 所以同一项目的事件按提交顺序连续编号，客户端和 agent 按 seq 消费不会漏。
   */
  async record<T extends EventType>(
    exec: Executor,
    input: PublishInput<T>,
  ): Promise<ProjectEvent<T>> {
    const [counter] = await exec
      .update(projects)
      .set({ eventSeq: sql`${projects.eventSeq} + 1` })
      .where(eq(projects.id, input.projectId))
      .returning({ seq: projects.eventSeq });
    if (!counter) throw new Error(`项目不存在：${input.projectId}`);
    const [row] = await exec
      .insert(events)
      .values({
        projectId: input.projectId,
        seq: counter.seq,
        threadId: input.threadId ?? null,
        type: input.type,
        payload: input.payload as unknown,
        actor: input.actor,
      })
      .returning();
    if (!row) throw new Error('事件写入失败');
    return {
      seq: row.seq,
      projectId: row.projectId,
      threadId: row.threadId,
      type: input.type,
      payload: input.payload,
      actor: row.actor,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 广播一条已落库的事件。监听器抛错不影响其他监听器。 */
  emit(event: ProjectEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event as AnyProjectEvent);
      } catch (err) {
        console.error('[bus] listener error', err);
      }
    }
  }

  /** record + emit。 */
  async publish<T extends EventType>(input: PublishInput<T>): Promise<ProjectEvent<T>> {
    const event = await this.db.transaction((tx) => this.record(tx, input));
    this.emit(event as ProjectEvent);
    return event;
  }

  /** 瞬时事件（不落库），如 agent 流式输出。 */
  ephemeral<T extends EphemeralType>(
    projectId: string,
    type: T,
    payload: EphemeralPayload<T>,
  ): void {
    const event = { projectId, type, payload } as EphemeralEvent;
    for (const listener of this.ephemeralListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[bus] ephemeral listener error', err);
      }
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEphemeral(listener: EphemeralListener): () => void {
    this.ephemeralListeners.add(listener);
    return () => this.ephemeralListeners.delete(listener);
  }

  /** 读取某项目 seq > afterSeq 的事件（断线补发、agent 唤醒）。 */
  async listSince(projectId: string, afterSeq: number, limit = 500): Promise<AnyProjectEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .limit(limit);
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          projectId: row.projectId,
          threadId: row.threadId,
          type: row.type,
          payload: row.payload,
          actor: row.actor,
          createdAt: row.createdAt.toISOString(),
        }) as AnyProjectEvent,
    );
  }

  /** 项目当前最大 seq（没有事件时为 0）。 */
  async latestSeq(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ seq: projects.eventSeq })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row?.seq ?? 0;
  }
}
