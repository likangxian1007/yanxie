import { and, asc, eq, lte } from 'drizzle-orm';
import { Cron } from 'croner';
import type { z } from 'zod';
import {
  ApiError,
  newId,
  type ActorRef,
  type Routine,
  type RoutineCreateInput,
  type RoutineUpdateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { routines, threads } from '../../db/schema';
import { runtimeHooks } from '../../agents/runtime/hooks';
import { SYSTEM_ACTOR } from '../projects/service';

/**
 * 定时任务。schedule 三种写法：
 * - 5 段 cron（分 时 日 月 周），按 Asia/Shanghai 时区解释，例如 `0 9 * * 1` = 每周一 9:00
 * - `every:<毫秒>`，最短 60000（1 分钟），从上次运行（或创建时）起算
 * - `at:<ISO 时间>`，只跑一次；时间已过则不再运行
 */
export type RoutineRow = typeof routines.$inferSelect;
export type RoutineCreate = z.infer<typeof RoutineCreateInput>;
export type RoutineUpdate = z.infer<typeof RoutineUpdateInput>;

export const ROUTINE_TIME_ZONE = 'Asia/Shanghai';
const MIN_EVERY_MS = 60_000;

function invalid(message: string): never {
  throw new ApiError('validation_failed', `定时规则无效：${message}`, {
    issues: [{ path: 'schedule', message }],
  });
}

type Parsed =
  { kind: 'every'; ms: number } | { kind: 'at'; at: Date } | { kind: 'cron'; cron: Cron };

function parseSchedule(schedule: string): Parsed {
  const s = schedule.trim();
  if (s.startsWith('every:')) {
    const raw = s.slice('every:'.length).trim();
    if (!/^\d+$/u.test(raw)) invalid('every: 后面要写毫秒数，如 every:3600000');
    const ms = Number(raw);
    if (!Number.isSafeInteger(ms) || ms < MIN_EVERY_MS) invalid('间隔至少 60000 毫秒（1 分钟）');
    return { kind: 'every', ms };
  }
  if (s.startsWith('at:')) {
    const raw = s.slice('at:'.length).trim();
    const at = new Date(raw);
    if (!raw || Number.isNaN(at.getTime()))
      invalid('at: 后面要写 ISO 时间，如 at:2026-01-01T09:00:00+08:00');
    return { kind: 'at', at };
  }
  const parts = s.split(/\s+/u);
  if (parts.length !== 5)
    invalid('cron 须为 5 段（分 时 日 月 周），或写 every:<毫秒> / at:<ISO 时间>');
  try {
    return {
      kind: 'cron',
      cron: new Cron(parts.join(' '), { timezone: ROUTINE_TIME_ZONE, mode: '5-part' }),
    };
  } catch (err) {
    invalid(err instanceof Error ? err.message : 'cron 无法解析');
  }
}

/** 校验 schedule，不合法抛 422 validation_failed */
export function validateSchedule(schedule: string): void {
  const p = parseSchedule(schedule);
  if (p.kind === 'cron' && !p.cron.nextRun(new Date())) invalid('cron 永远不会触发');
}

/** 从 from 之后的下一次运行时间；不会再运行（at 已过）返回 null */
export function nextRunAt(schedule: string, from: Date): Date | null {
  const p = parseSchedule(schedule);
  switch (p.kind) {
    case 'every':
      return new Date(from.getTime() + p.ms);
    case 'at':
      return p.at.getTime() > from.getTime() ? p.at : null;
    case 'cron':
      return p.cron.nextRun(from) ?? null;
  }
}

export function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    schedule: row.schedule,
    prompt: row.prompt,
    targetThreadId: row.targetThreadId ?? null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function notifyChanged(projectId: string) {
  try {
    runtimeHooks.routinesChanged?.(projectId);
  } catch (err) {
    console.error('[routines] routinesChanged 钩子出错', err);
  }
}

async function assertThreadInProject(ctx: AppContext, projectId: string, threadId: string | null) {
  if (!threadId) return;
  const [t] = await ctx.db.db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.projectId, projectId)));
  if (!t) throw new ApiError('not_found', '目标线程不存在');
}

export async function listRoutines(ctx: AppContext, projectId: string): Promise<Routine[]> {
  const rows = await ctx.db.db
    .select()
    .from(routines)
    .where(eq(routines.projectId, projectId))
    .orderBy(asc(routines.createdAt));
  return rows.map(toRoutine);
}

export async function getRoutineRow(
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<RoutineRow | null> {
  const [row] = await ctx.db.db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.projectId, projectId)));
  return row ?? null;
}

export async function createRoutine(
  ctx: AppContext,
  actor: ActorRef & { id: string },
  projectId: string,
  input: RoutineCreate,
): Promise<Routine> {
  validateSchedule(input.schedule);
  await assertThreadInProject(ctx, projectId, input.targetThreadId ?? null);
  const enabled = input.enabled ?? true;
  const { routine, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(routines)
      .values({
        id: newId('routine'),
        projectId,
        title: input.title,
        schedule: input.schedule.trim(),
        prompt: input.prompt,
        targetThreadId: input.targetThreadId ?? null,
        enabled,
        nextRunAt: enabled ? nextRunAt(input.schedule, new Date()) : null,
        createdBy: actor.id,
      })
      .returning();
    const routine = toRoutine(row!);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'routine.created',
      payload: routine,
      actor,
    });
    return { routine, ev };
  });
  ctx.bus.emit(ev);
  notifyChanged(projectId);
  return routine;
}

/** 修改定时任务；schedule 或 enabled 变化时重算 nextRunAt */
export async function updateRoutine(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  input: RoutineUpdate,
): Promise<Routine> {
  const current = await getRoutineRow(ctx, projectId, id);
  if (!current) throw new ApiError('not_found', '定时任务不存在');
  if (input.schedule !== undefined) validateSchedule(input.schedule);
  if (input.targetThreadId !== undefined) {
    await assertThreadInProject(ctx, projectId, input.targetThreadId);
  }
  const patch: Partial<typeof routines.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.targetThreadId !== undefined) patch.targetThreadId = input.targetThreadId;
  if (input.schedule !== undefined) patch.schedule = input.schedule.trim();
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const scheduleChanged =
    input.schedule !== undefined && input.schedule.trim() !== current.schedule;
  const enabledChanged = input.enabled !== undefined && input.enabled !== current.enabled;
  if (scheduleChanged || enabledChanged) {
    const enabled = input.enabled ?? current.enabled;
    patch.nextRunAt = enabled ? nextRunAt(input.schedule ?? current.schedule, new Date()) : null;
  }
  const { routine, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx.update(routines).set(patch).where(eq(routines.id, id)).returning();
    const routine = toRoutine(row!);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'routine.updated',
      payload: routine,
      actor,
    });
    return { routine, ev };
  });
  ctx.bus.emit(ev);
  notifyChanged(projectId);
  return routine;
}

export async function deleteRoutine(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
): Promise<void> {
  const ev = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(routines)
      .where(and(eq(routines.id, id), eq(routines.projectId, projectId)))
      .returning({ id: routines.id });
    if (!row) throw new ApiError('not_found', '定时任务不存在');
    return ctx.bus.record(tx, { projectId, type: 'routine.deleted', payload: { id }, actor });
  });
  ctx.bus.emit(ev);
  notifyChanged(projectId);
}

/** 所有项目里已启用且到点的定时任务（调度器轮询用） */
export async function listDueRoutines(ctx: AppContext, now: Date): Promise<RoutineRow[]> {
  return ctx.db.db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)))
    .orderBy(asc(routines.nextRunAt));
}

/** 记一次运行：lastRunAt = ranAt，nextRunAt 从 ranAt 起重算（at: 已过 → null） */
export async function markRoutineRan(ctx: AppContext, id: string, ranAt: Date): Promise<Routine> {
  const [current] = await ctx.db.db.select().from(routines).where(eq(routines.id, id));
  if (!current) throw new ApiError('not_found', '定时任务不存在');
  let next: Date | null = null;
  if (current.enabled) {
    try {
      next = nextRunAt(current.schedule, ranAt);
    } catch {
      next = null; // 历史数据里的非法规则：停掉，不再触发
    }
  }
  const { routine, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(routines)
      .set({ lastRunAt: ranAt, nextRunAt: next })
      .where(eq(routines.id, id))
      .returning();
    const routine = toRoutine(row!);
    const ev = await ctx.bus.record(tx, {
      projectId: routine.projectId,
      type: 'routine.updated',
      payload: routine,
      actor: SYSTEM_ACTOR,
    });
    return { routine, ev };
  });
  ctx.bus.emit(ev);
  return routine;
}
