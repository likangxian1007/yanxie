import { and, desc, eq, gt, lt, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  newId,
  type ActorRef,
  type ClaimCreateInput,
  type ClaimListQuery,
  type ClaimMode,
  type ClaimResourceKind,
  type ProjectEvent,
  type WorkClaim,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { workClaims } from '../../db/schema';
import { SYSTEM_ACTOR } from '../projects/service';
import { createInboxItem } from '../inbox/service';

/**
 * 认领与冲突预警（ARCHITECTURE.md §5.3）。
 *
 * resourceRef 约定：
 * - document：`doc_xxx`；doc_section：`doc_xxx#<标题原文>`（文档认领覆盖其所有章节）
 * - file：项目共享文件夹内的路径或 glob（`*` 不跨目录、`**` 跨目录、`?` 单字符）
 * - experiment / card：对象 id；topic：自由文本（去空白后不区分大小写比较）
 *
 * 冲突：两个有效（active 且未到期）认领重叠，且任一方为 exclusive；shared + shared 可共存。
 * 同一持有者（holder.id 相同）或同一线程（threadId 相同且非空）的认领之间永不冲突。
 */

export type ClaimRow = typeof workClaims.$inferSelect;
export type ClaimCreate = z.infer<typeof ClaimCreateInput>;
export type ClaimQuery = z.infer<typeof ClaimListQuery>;

export interface ClaimResource {
  resourceKind: ClaimResourceKind;
  resourceRef: string;
}
export interface ClaimResourceWithMode extends ClaimResource {
  mode: ClaimMode;
}
export interface ClaimConflict {
  resource: ClaimResourceWithMode;
  conflictsWith: WorkClaim[];
}

const DEFAULT_TTL_SEC = 1800;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

export function toClaim(row: ClaimRow): WorkClaim {
  return {
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId ?? null,
    holder: row.holder,
    onBehalfOfUserId: row.onBehalfOfUserId ?? null,
    resourceKind: row.resourceKind,
    resourceRef: row.resourceRef,
    mode: row.mode,
    intent: row.intent,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------- 资源重叠判定（纯函数）

/** 文件路径规范化：反斜杠转 /，去掉开头的 ./ 与 /，末尾 / 视为整个目录（dir/ → dir/**） */
export function normalizeClaimPath(p: string): string {
  let s = p.trim().replace(/\\/gu, '/');
  for (;;) {
    if (s.startsWith('./')) s = s.slice(2);
    else if (s.startsWith('/')) s = s.slice(1);
    else break;
  }
  s = s.replace(/\/{2,}/gu, '/');
  if (s.endsWith('/')) s += '**';
  return s;
}

const hasWildcard = (s: string) => /[*?]/u.test(s);

/** glob → 正则：`**` 任意（含 /），`*` 任意（不含 /），`?` 单个非 / 字符；`**\/` 可匹配零层目录 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'u');
}

function literalPrefix(glob: string): string {
  const i = glob.search(/[*?]/u);
  return i < 0 ? glob : glob.slice(0, i);
}

/**
 * 两个路径 / glob 是否可能指向同一文件。
 * 都不含通配符：相等；一方含通配：用它匹配另一方；双方都含通配：字面前缀互为前缀即视为相交（保守）。
 */
export function globsIntersect(a: string, b: string): boolean {
  const x = normalizeClaimPath(a);
  const y = normalizeClaimPath(b);
  const wx = hasWildcard(x);
  const wy = hasWildcard(y);
  if (!wx && !wy) return x === y;
  if (wx && !wy) return globToRegExp(x).test(y);
  if (!wx && wy) return globToRegExp(y).test(x);
  const px = literalPrefix(x);
  const py = literalPrefix(y);
  return px.startsWith(py) || py.startsWith(px);
}

function splitSection(ref: string): { doc: string; heading: string } {
  const i = ref.indexOf('#');
  if (i < 0) return { doc: ref.trim(), heading: '' };
  return { doc: ref.slice(0, i).trim(), heading: ref.slice(i + 1).trim() };
}

function sameRef(kind: ClaimResourceKind, a: string, b: string): boolean {
  switch (kind) {
    case 'file':
      return globsIntersect(a, b);
    case 'topic':
      return a.trim().toLowerCase() === b.trim().toLowerCase();
    case 'doc_section': {
      const x = splitSection(a);
      const y = splitSection(b);
      return x.doc === y.doc && x.heading === y.heading;
    }
    default:
      return a.trim() === b.trim();
  }
}

/** 两个资源是否重叠：同类同 ref（file 为 glob 相交）；文档 ⊃ 其章节 */
export function overlap(a: ClaimResource, b: ClaimResource): boolean {
  if (a.resourceKind === b.resourceKind)
    return sameRef(a.resourceKind, a.resourceRef, b.resourceRef);
  if (a.resourceKind === 'document' && b.resourceKind === 'doc_section') {
    return splitSection(b.resourceRef).doc === a.resourceRef.trim();
  }
  if (a.resourceKind === 'doc_section' && b.resourceKind === 'document') {
    return splitSection(a.resourceRef).doc === b.resourceRef.trim();
  }
  return false;
}

/** 认领 claim 是否覆盖资源 r（写入守卫用）：相等、文档覆盖章节、glob 匹配路径 */
export function covers(claim: ClaimResource, r: ClaimResource): boolean {
  if (claim.resourceKind === 'document' && r.resourceKind === 'doc_section') {
    return splitSection(r.resourceRef).doc === claim.resourceRef.trim();
  }
  if (claim.resourceKind !== r.resourceKind) return false;
  if (claim.resourceKind === 'file') {
    const c = normalizeClaimPath(claim.resourceRef);
    const p = normalizeClaimPath(r.resourceRef);
    if (c === p) return true;
    if (!hasWildcard(c)) return false;
    if (!hasWildcard(p)) return globToRegExp(c).test(p);
    // 资源本身是 glob：只有认领是“目录/**”且资源的字面前缀落在该目录下才算覆盖
    return (
      c.endsWith('/**') &&
      !hasWildcard(c.slice(0, -3)) &&
      literalPrefix(p).startsWith(c.slice(0, -2))
    );
  }
  return sameRef(claim.resourceKind, claim.resourceRef, r.resourceRef);
}

interface Party {
  holderId: string | null;
  threadId: string | null;
  mode: ClaimMode;
}

function partiesConflict(a: Party, b: Party): boolean {
  if (a.mode === 'shared' && b.mode === 'shared') return false;
  if (a.holderId && b.holderId && a.holderId === b.holderId) return false;
  if (a.threadId && b.threadId && a.threadId === b.threadId) return false;
  return true;
}

// ---------------------------------------------------------------- 数据库操作

async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId}))`);
}

/** 事务内：把已到期仍为 active 的认领置为 expired，返回待广播的事件 */
async function expireInTx(ctx: AppContext, tx: Tx, projectId: string): Promise<ProjectEvent[]> {
  const rows = await tx
    .update(workClaims)
    .set({ status: 'expired' })
    .where(
      and(
        eq(workClaims.projectId, projectId),
        eq(workClaims.status, 'active'),
        lt(workClaims.expiresAt, new Date()),
      ),
    )
    .returning();
  const evs: ProjectEvent[] = [];
  for (const row of rows) {
    evs.push((await recordClaim(ctx, tx, 'claim.updated', row, SYSTEM_ACTOR)) as ProjectEvent);
  }
  return evs;
}

function recordClaim(
  ctx: AppContext,
  tx: Tx,
  type: 'claim.created' | 'claim.updated',
  row: ClaimRow,
  actor: ActorRef,
) {
  return ctx.bus.record(tx, {
    projectId: row.projectId,
    threadId: row.threadId,
    type,
    payload: toClaim(row),
    actor,
  });
}

function emitAll(ctx: AppContext, evs: ProjectEvent[]) {
  for (const ev of evs) ctx.bus.emit(ev);
}

async function activeClaims(exec: Exec, projectId: string): Promise<ClaimRow[]> {
  return exec
    .select()
    .from(workClaims)
    .where(
      and(
        eq(workClaims.projectId, projectId),
        eq(workClaims.status, 'active'),
        gt(workClaims.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(workClaims.createdAt));
}

function conflictsAmong(
  rows: ClaimRow[],
  resource: ClaimResourceWithMode,
  self: { holderId: string | null; threadId: string | null },
): ClaimRow[] {
  return rows.filter(
    (c) =>
      overlap(c, resource) &&
      partiesConflict(
        { holderId: c.holder.id, threadId: c.threadId, mode: c.mode },
        { ...self, mode: resource.mode },
      ),
  );
}

/** 把本项目已到期的有效认领标为 expired（每条发布 claim.updated） */
export async function expireStaleClaims(ctx: AppContext, projectId: string): Promise<void> {
  const evs = await ctx.db.db.transaction((tx) => expireInTx(ctx, tx, projectId));
  emitAll(ctx, evs);
}

/** 列出认领；给出 resourceKind + resourceRef 时返回与该资源**重叠**的认领（不只是相等） */
export async function listClaims(
  ctx: AppContext,
  projectId: string,
  q: ClaimQuery,
): Promise<WorkClaim[]> {
  await expireStaleClaims(ctx, projectId);
  const conds: SQL[] = [eq(workClaims.projectId, projectId)];
  if (q.status) conds.push(eq(workClaims.status, q.status));
  if (q.threadId) conds.push(eq(workClaims.threadId, q.threadId));
  let rows = await ctx.db.db
    .select()
    .from(workClaims)
    .where(and(...conds))
    .orderBy(desc(workClaims.createdAt));
  if (q.resourceKind && q.resourceRef) {
    const r: ClaimResource = { resourceKind: q.resourceKind, resourceRef: q.resourceRef };
    rows = rows.filter((c) => overlap(c, r));
  } else if (q.resourceKind) {
    rows = rows.filter((c) => c.resourceKind === q.resourceKind);
  }
  return rows.map(toClaim);
}

export async function getClaimRow(
  ctx: AppContext,
  projectId: string,
  claimId: string,
): Promise<ClaimRow | null> {
  const [row] = await ctx.db.db
    .select()
    .from(workClaims)
    .where(and(eq(workClaims.id, claimId), eq(workClaims.projectId, projectId)));
  return row ?? null;
}

/** 派活前检查（协调者 check_conflicts）：只返回有冲突的资源；不创建认领 */
export async function findConflicts(
  ctx: AppContext,
  projectId: string,
  resources: ClaimResourceWithMode[],
  opts: { holderId?: string; threadId?: string | null } = {},
): Promise<ClaimConflict[]> {
  await expireStaleClaims(ctx, projectId);
  const rows = await activeClaims(ctx.db.db, projectId);
  const self = { holderId: opts.holderId ?? null, threadId: opts.threadId ?? null };
  const out: ClaimConflict[] = [];
  for (const resource of resources) {
    const hits = conflictsAmong(rows, resource, self);
    if (hits.length > 0) out.push({ resource, conflictsWith: hits.map(toClaim) });
  }
  return out;
}

/**
 * 认领（原子）：同一事务内加项目级 advisory 锁 → 过期清理 → 冲突判定 → 写入。
 * - 同一持有者对同一资源已有有效认领：续期并更新 intent / mode（幂等），发布 claim.updated
 * - 有冲突：不写入；发布 claim.conflict，给双方发起人生成 inbox(conflict)，抛 409 claim_conflict
 */
export async function createClaim(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: ClaimCreate & { onBehalfOfUserId?: string | null },
): Promise<WorkClaim> {
  if (input.resourceKind === 'experiment')
    throw new ApiError('validation_failed', '实验功能已移除');
  const threadId = input.threadId ?? null;
  const onBehalfOfUserId = input.onBehalfOfUserId ?? null;
  const ttlSec = input.ttlSec ?? DEFAULT_TTL_SEC;
  const resource: ClaimResourceWithMode = {
    resourceKind: input.resourceKind,
    resourceRef:
      input.resourceKind === 'file'
        ? normalizeClaimPath(input.resourceRef)
        : input.resourceRef.trim(),
    mode: input.mode ?? 'exclusive',
  };

  type Outcome =
    | { kind: 'ok'; claim: WorkClaim; evs: ProjectEvent[] }
    | { kind: 'conflict'; conflictsWith: ClaimRow[]; evs: ProjectEvent[] };

  const outcome = await ctx.db.db.transaction(async (tx): Promise<Outcome> => {
    await lockProject(tx, projectId);
    const evs = await expireInTx(ctx, tx, projectId);
    const rows = await activeClaims(tx, projectId);
    const hits = conflictsAmong(rows, resource, { holderId: actor.id, threadId });
    if (hits.length > 0) return { kind: 'conflict', conflictsWith: hits, evs };

    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const mine = rows.find(
      (c) =>
        actor.id !== null &&
        c.holder.id === actor.id &&
        c.resourceKind === resource.resourceKind &&
        c.resourceRef === resource.resourceRef,
    );
    if (mine) {
      const [row] = await tx
        .update(workClaims)
        .set({
          expiresAt: expiresAt > mine.expiresAt ? expiresAt : mine.expiresAt,
          intent: input.intent,
          mode: resource.mode,
          threadId: mine.threadId ?? threadId,
          onBehalfOfUserId: mine.onBehalfOfUserId ?? onBehalfOfUserId,
        })
        .where(eq(workClaims.id, mine.id))
        .returning();
      evs.push((await recordClaim(ctx, tx, 'claim.updated', row!, actor)) as ProjectEvent);
      return { kind: 'ok', claim: toClaim(row!), evs };
    }

    const [row] = await tx
      .insert(workClaims)
      .values({
        id: newId('claim'),
        projectId,
        threadId,
        holder: actor,
        onBehalfOfUserId,
        resourceKind: resource.resourceKind,
        resourceRef: resource.resourceRef,
        mode: resource.mode,
        intent: input.intent,
        status: 'active',
        expiresAt,
      })
      .returning();
    evs.push((await recordClaim(ctx, tx, 'claim.created', row!, actor)) as ProjectEvent);
    return { kind: 'ok', claim: toClaim(row!), evs };
  });

  emitAll(ctx, outcome.evs);
  if (outcome.kind === 'ok') return outcome.claim;

  // ---- 冲突：预警事件 + 双方发起人的收件箱，然后拒绝
  const now = new Date();
  const wouldBe: WorkClaim = {
    id: newId('claim'),
    projectId,
    threadId,
    holder: actor,
    onBehalfOfUserId,
    resourceKind: resource.resourceKind,
    resourceRef: resource.resourceRef,
    mode: resource.mode,
    intent: input.intent,
    status: 'active',
    expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
    createdAt: now.toISOString(),
  };
  const conflictsWith = outcome.conflictsWith.map(toClaim);
  await ctx.bus.publish({
    projectId,
    threadId,
    type: 'claim.conflict',
    payload: { claim: wouldBe, conflictsWith },
    actor,
  });
  const label = input.intent.trim() || resource.resourceRef;
  const notified = new Set<string>();
  for (const c of conflictsWith) {
    for (const userId of [c.onBehalfOfUserId, onBehalfOfUserId]) {
      if (!userId || notified.has(`${userId}:${c.id}`)) continue;
      notified.add(`${userId}:${c.id}`);
      try {
        await createInboxItem(ctx, {
          projectId,
          userId,
          kind: 'conflict',
          title: `「${label}」与 ${c.holder.name} 的认领重叠`,
          href: c.threadId ? `/p/${projectId}/threads/${c.threadId}` : `/p/${projectId}`,
          sourceId: c.id,
        });
      } catch (err) {
        console.error('[claims] 冲突收件箱写入失败', err);
      }
    }
  }
  throw new ApiError('claim_conflict', '该资源已被他人认领', { claims: conflictsWith });
}

/** 续期：只对有效认领；已过期 / 已释放 → 409 */
export async function renewClaim(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  claimId: string,
  ttlSec?: number,
): Promise<WorkClaim> {
  await expireStaleClaims(ctx, projectId);
  const current = await getClaimRow(ctx, projectId, claimId);
  if (!current) throw new ApiError('not_found', '认领不存在');
  if (current.status === 'expired') throw new ApiError('conflict', '认领已过期，请重新认领');
  if (current.status !== 'active') throw new ApiError('conflict', '认领已释放，请重新认领');
  const expiresAt = new Date(Date.now() + (ttlSec ?? DEFAULT_TTL_SEC) * 1000);
  const { claim, ev } = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(workClaims)
      .set({ expiresAt })
      .where(and(eq(workClaims.id, claimId), eq(workClaims.status, 'active')))
      .returning();
    if (!row) throw new ApiError('conflict', '认领已失效，请重新认领');
    return { claim: toClaim(row), ev: await recordClaim(ctx, tx, 'claim.updated', row, actor) };
  });
  ctx.bus.emit(ev as ProjectEvent);
  return claim;
}

/** 释放认领；已释放 / 已过期的认领重复释放为空操作 */
export async function releaseClaim(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  claimId: string,
): Promise<void> {
  const evs = await ctx.db.db.transaction(async (tx) => {
    const rows = await tx
      .update(workClaims)
      .set({ status: 'released' })
      .where(
        and(
          eq(workClaims.id, claimId),
          eq(workClaims.projectId, projectId),
          eq(workClaims.status, 'active'),
        ),
      )
      .returning();
    const out: ProjectEvent[] = [];
    for (const row of rows)
      out.push((await recordClaim(ctx, tx, 'claim.updated', row, actor)) as ProjectEvent);
    return out;
  });
  emitAll(ctx, evs);
}

/** 线程结束 / resolved：释放该线程的全部有效认领，返回释放条数 */
export async function releaseThreadClaims(
  ctx: AppContext,
  projectId: string,
  threadId: string,
  actor: ActorRef,
): Promise<number> {
  const evs = await ctx.db.db.transaction(async (tx) => {
    const rows = await tx
      .update(workClaims)
      .set({ status: 'released' })
      .where(
        and(
          eq(workClaims.projectId, projectId),
          eq(workClaims.threadId, threadId),
          eq(workClaims.status, 'active'),
        ),
      )
      .returning();
    const out: ProjectEvent[] = [];
    for (const row of rows)
      out.push((await recordClaim(ctx, tx, 'claim.updated', row, actor)) as ProjectEvent);
    return out;
  });
  emitAll(ctx, evs);
  return evs.length;
}

/** 心跳：agent 每个 turn 把线程的有效认领延到 max(当前, now+ttl)；变化超过 60 秒才发事件 */
export async function renewThreadClaims(
  ctx: AppContext,
  projectId: string,
  threadId: string,
  ttlSec = DEFAULT_TTL_SEC,
): Promise<void> {
  const target = new Date(Date.now() + ttlSec * 1000);
  const evs = await ctx.db.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(workClaims)
      .where(
        and(
          eq(workClaims.projectId, projectId),
          eq(workClaims.threadId, threadId),
          eq(workClaims.status, 'active'),
          gt(workClaims.expiresAt, new Date()),
        ),
      );
    const out: ProjectEvent[] = [];
    for (const c of rows) {
      if (target.getTime() - c.expiresAt.getTime() <= 60_000) continue;
      const [row] = await tx
        .update(workClaims)
        .set({ expiresAt: target })
        .where(and(eq(workClaims.id, c.id), eq(workClaims.status, 'active')))
        .returning();
      if (row)
        out.push((await recordClaim(ctx, tx, 'claim.updated', row, c.holder)) as ProjectEvent);
    }
    return out;
  });
  emitAll(ctx, evs);
}

/**
 * 写入守卫：找该持有者（或该线程）覆盖此资源的有效认领；没有返回 null。
 * 覆盖 = 相等、文档认领覆盖其章节、文件 glob 匹配路径。独占认领优先返回。
 */
export async function findCoveringClaim(
  ctx: AppContext,
  projectId: string,
  resource: ClaimResource,
  holder: { holderId: string; threadId: string | null },
): Promise<WorkClaim | null> {
  const rows = await activeClaims(ctx.db.db, projectId);
  const mine = rows.filter(
    (c) =>
      (c.holder.id !== null && c.holder.id === holder.holderId) ||
      (holder.threadId !== null && c.threadId === holder.threadId),
  );
  const hits = mine.filter((c) => covers(c, resource));
  const best = hits.find((c) => c.mode === 'exclusive') ?? hits[0];
  return best ? toClaim(best) : null;
}
