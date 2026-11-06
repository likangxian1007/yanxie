import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  AdminUpdateUserInput,
  ApiError,
  OpsEventListQuery,
  ticketCode,
  type AdminOverview,
  type AdminProjectRow,
  type AdminUserRow,
  type AgentWindowStats,
  type OpsEvent,
} from '@srh/shared';
import { defaultModelId } from '../../agents/llm/registry';
import type { AppContext } from '../../context';
import {
  agentSessions,
  agentSteps,
  authSessions,
  opsEvents,
  projectMembers,
  projects,
  threads,
  tickets,
  users,
} from '../../db/schema';
import { parse } from '../../lib/http';
import { configuredAdminEmails } from '../auth/service';
import { requireAdminUser } from '../feedback';
import { createTicket, ticketDetail } from '../feedback/service';
import type { ModuleDef } from '../types';

/**
 * 运维后台（feat/feedback-center），全部要求 users.is_admin = true，否则 403。
 *
 *   GET    /admin/overview                 服务器 / 磁盘 / 数据库 / 模型 / agent 统计 / 计数
 *   GET    /admin/users                    用户列表
 *   PATCH  /admin/users/:id {isAdmin}      授予 / 撤销管理员（不能撤自己，不能撤 ADMIN_EMAILS 里的）
 *   GET    /admin/projects                 课题列表（成员数、线程数、最近活动、token 用量）
 *   GET    /admin/ops-events               运维事件（level/source/q/open/limit）
 *   POST   /admin/ops-events/:id/ticket    转成工单（source=ops）
 *   DELETE /admin/ops-events/:id           删除
 */
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string | Date).toISOString() : null);

async function rows<T>(ctx: AppContext, q: SQL): Promise<T[]> {
  const res = await ctx.db.db.execute(q);
  return (res as unknown as { rows: T[] }).rows;
}

async function agentWindow(ctx: AppContext, since: Date): Promise<AgentWindowStats> {
  const [steps] = await ctx.db.db
    .select({
      turns: sql<number>`count(distinct ${agentSteps.turnId})`.mapWith(Number),
      failures:
        sql<number>`count(distinct ${agentSteps.turnId}) filter (where ${agentSteps.kind} = 'note' and ${agentSteps.name} = 'error')`.mapWith(
          Number,
        ),
    })
    .from(agentSteps)
    .where(sql`${agentSteps.createdAt} >= ${since.toISOString()}`);
  const [tok] = await ctx.db.db
    .select({
      tokens:
        sql<number>`coalesce(sum(coalesce((${agentSessions.tokenUsage}->>'input')::bigint, 0) + coalesce((${agentSessions.tokenUsage}->>'output')::bigint, 0)), 0)`.mapWith(
          Number,
        ),
    })
    .from(agentSessions)
    .where(sql`${agentSessions.lastActivityAt} >= ${since.toISOString()}`);
  return { turns: steps?.turns ?? 0, failures: steps?.failures ?? 0, tokens: tok?.tokens ?? 0 };
}

async function count(ctx: AppContext, q: SQL): Promise<number> {
  const [r] = await rows<{ n: unknown }>(ctx, q);
  return num(r?.n);
}

async function overview(ctx: AppContext): Promise<AdminOverview> {
  const now = Date.now();
  const day = new Date(now - 24 * 3600_000);
  const week = new Date(now - 7 * 24 * 3600_000);
  const storage = resolve(ctx.config.STORAGE_DIR);
  const disk: AdminOverview['disk'] = await statfs(storage)
    .then((s) => ({ path: storage, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }))
    .catch(() => null);
  let dbOk = true;
  let latencyMs: number | null = null;
  try {
    latencyMs = Math.round((await ctx.db.ping()) * 100) / 100;
  } catch {
    dbOk = false;
  }
  const sizeBytes: number | null = await count(
    ctx,
    sql`select pg_database_size(current_database()) as n`,
  ).catch(() => null);
  const mem = process.memoryUsage();
  const [last24h, last7d] = await Promise.all([agentWindow(ctx, day), agentWindow(ctx, week)]);
  const [usersN, active, projectsN, open, doing, ops] = await Promise.all([
    count(ctx, sql`select count(*) as n from ${users}`),
    count(
      ctx,
      sql`select count(distinct ${authSessions.userId}) as n from ${authSessions} where ${authSessions.createdAt} >= ${week.toISOString()}`,
    ),
    count(ctx, sql`select count(*) as n from ${projects} where ${projects.archivedAt} is null`),
    count(ctx, sql`select count(*) as n from ${tickets} where ${tickets.status} = 'open'`),
    count(ctx, sql`select count(*) as n from ${tickets} where ${tickets.status} = 'doing'`),
    count(
      ctx,
      sql`select count(*) as n from ${opsEvents} where ${opsEvents.lastAt} >= ${day.toISOString()}`,
    ),
  ]);
  return {
    server: {
      version: ctx.version,
      uptimeSec: Math.round((now - ctx.startedAt) / 1000),
      nodeVersion: process.version,
      platform: `${process.platform} ${os.release()}`,
      cpus: os.cpus().length,
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    },
    disk,
    db: { driver: ctx.db.driver, ok: dbOk, latencyMs, sizeBytes },
    llm: { configured: ctx.config.llmConfigured, defaultModel: defaultModelId(ctx.config) },
    agents: { last24h, last7d },
    counts: {
      users: usersN,
      activeUsers7d: active,
      projects: projectsN,
      ticketsOpen: open,
      ticketsDoing: doing,
      opsEvents24h: ops,
    },
    time: new Date(now).toISOString(),
  };
}

async function listUsers(ctx: AppContext): Promise<AdminUserRow[]> {
  const forced = configuredAdminEmails(ctx.config.ADMIN_EMAILS);
  const list = await rows<{
    id: string;
    email: string;
    name: string;
    avatar_color: number;
    avatar_url: string | null;
    is_admin: boolean;
    created_at: string | Date;
    project_count: unknown;
    ticket_count: unknown;
    last_login_at: string | Date | null;
  }>(
    ctx,
    sql`select u.id, u.email, u.name, u.avatar_color, u.avatar_url, u.is_admin, u.created_at,
      (select count(*) from ${projectMembers} pm where pm.user_id = u.id) as project_count,
      (select count(*) from ${tickets} t where t.reporter_user_id = u.id) as ticket_count,
      (select max(s.created_at) from ${authSessions} s where s.user_id = u.id) as last_login_at
      from ${users} u order by u.created_at desc limit 1000`,
  );
  return list.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    avatarColor: num(u.avatar_color),
    avatarUrl: u.avatar_url,
    isAdmin: u.is_admin,
    adminByConfig: forced.has(u.email.trim().toLowerCase()),
    projectCount: num(u.project_count),
    ticketCount: num(u.ticket_count),
    lastLoginAt: iso(u.last_login_at),
    createdAt: iso(u.created_at)!,
  }));
}

async function listProjects(ctx: AppContext): Promise<AdminProjectRow[]> {
  const list = await rows<{
    id: string;
    name: string;
    icon: string;
    archived_at: string | Date | null;
    created_at: string | Date;
    member_count: unknown;
    thread_count: unknown;
    last_activity_at: string | Date | null;
    tin: unknown;
    tout: unknown;
    tcached: unknown;
  }>(
    ctx,
    sql`select p.id, p.name, p.icon, p.archived_at, p.created_at,
      (select count(*) from ${projectMembers} pm where pm.project_id = p.id) as member_count,
      (select count(*) from ${threads} th where th.project_id = p.id) as thread_count,
      (select max(th.last_activity_at) from ${threads} th where th.project_id = p.id) as last_activity_at,
      (select coalesce(sum((a.token_usage->>'input')::bigint), 0) from ${agentSessions} a where a.project_id = p.id) as tin,
      (select coalesce(sum((a.token_usage->>'output')::bigint), 0) from ${agentSessions} a where a.project_id = p.id) as tout,
      (select coalesce(sum((a.token_usage->>'cached')::bigint), 0) from ${agentSessions} a where a.project_id = p.id) as tcached
      from ${projects} p order by p.created_at desc limit 1000`,
  );
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    archived: p.archived_at !== null,
    memberCount: num(p.member_count),
    threadCount: num(p.thread_count),
    lastActivityAt: iso(p.last_activity_at),
    tokens: { input: num(p.tin), output: num(p.tout), cached: num(p.tcached) },
    createdAt: iso(p.created_at)!,
  }));
}

const escapeLike = (s: string) => s.replace(/[\\%_]/gu, (c) => `\\${c}`);

async function listOps(ctx: AppContext, q: OpsEventListQuery): Promise<OpsEvent[]> {
  const conds: (SQL | undefined)[] = [];
  if (q.level) conds.push(eq(opsEvents.level, q.level));
  if (q.source) conds.push(eq(opsEvents.source, q.source));
  if (q.open === '1' || q.open === 'true') conds.push(isNull(opsEvents.ticketId));
  if (q.q?.trim()) conds.push(or(ilike(opsEvents.message, `%${escapeLike(q.q.trim())}%`)));
  const list = await ctx.db.db
    .select({ e: opsEvents, no: tickets.no })
    .from(opsEvents)
    .leftJoin(tickets, eq(tickets.id, opsEvents.ticketId))
    .where(and(...conds))
    .orderBy(desc(opsEvents.lastAt))
    .limit(q.limit);
  return list.map(({ e, no }) => ({
    id: e.id,
    level: e.level,
    source: e.source,
    message: e.message,
    detail: e.detail,
    fingerprint: e.fingerprint,
    count: e.count,
    firstAt: e.firstAt.toISOString(),
    lastAt: e.lastAt.toISOString(),
    ticketId: e.ticketId,
    ticketNo: no ?? null,
  }));
}

export const adminModule: ModuleDef = {
  name: 'admin',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get('/admin/overview', async (req) => {
      await requireAdminUser(req);
      return overview(ctx);
    });

    app.get('/admin/users', async (req) => {
      await requireAdminUser(req);
      return listUsers(ctx);
    });

    app.patch<{ Params: { id: string } }>('/admin/users/:id', async (req) => {
      const v = await requireAdminUser(req);
      const input = parse(AdminUpdateUserInput, req.body);
      const [target] = await ctx.db.db.select().from(users).where(eq(users.id, req.params.id));
      if (!target) throw new ApiError('not_found', '用户不存在');
      if (!input.isAdmin) {
        if (target.id === v.id) throw new ApiError('conflict', '不能撤销自己的管理员权限');
        if (configuredAdminEmails(ctx.config.ADMIN_EMAILS).has(target.email.trim().toLowerCase())) {
          throw new ApiError(
            'conflict',
            '这个账号由服务器配置 ADMIN_EMAILS 指定为管理员，不能在界面上撤销',
          );
        }
      }
      await ctx.db.db.update(users).set({ isAdmin: input.isAdmin }).where(eq(users.id, target.id));
      return (await listUsers(ctx)).find((u) => u.id === target.id);
    });

    app.get('/admin/projects', async (req) => {
      await requireAdminUser(req);
      return listProjects(ctx);
    });

    app.get('/admin/ops-events', async (req) => {
      await requireAdminUser(req);
      return listOps(ctx, parse(OpsEventListQuery, req.query));
    });

    app.post<{ Params: { id: string } }>('/admin/ops-events/:id/ticket', async (req, reply) => {
      const v = await requireAdminUser(req);
      const [e] = await ctx.db.db.select().from(opsEvents).where(eq(opsEvents.id, req.params.id));
      if (!e) throw new ApiError('not_found', '运维事件不存在');
      if (e.ticketId) {
        const [t] = await ctx.db.db.select().from(tickets).where(eq(tickets.id, e.ticketId));
        if (t)
          throw new ApiError('conflict', `已经转成工单 ${ticketCode(t.no)}`, { ticketNo: t.no });
      }
      const stack = typeof e.detail.stack === 'string' ? e.detail.stack : '';
      const body = [
        `来源：${e.source} · 级别：${e.level} · 累计 ${e.count} 次`,
        `首次：${e.firstAt.toISOString()} · 最近：${e.lastAt.toISOString()}`,
        '',
        '```',
        e.message,
        stack,
        '```',
      ].join('\n');
      const row = await createTicket(ctx, v, {
        kind: 'bug',
        title: `[运维] ${e.message}`.slice(0, 120),
        body: body.slice(0, 10_000),
        projectId: null,
        context: null,
        priority: e.level === 'error' ? 'high' : 'normal',
        source: 'ops',
      });
      await ctx.db.db.update(opsEvents).set({ ticketId: row.id }).where(eq(opsEvents.id, e.id));
      reply.code(201);
      return ticketDetail(ctx, row, v);
    });

    app.delete<{ Params: { id: string } }>('/admin/ops-events/:id', async (req, reply) => {
      await requireAdminUser(req);
      const del = await ctx.db.db
        .delete(opsEvents)
        .where(inArray(opsEvents.id, [req.params.id]))
        .returning({ id: opsEvents.id });
      if (del.length === 0) throw new ApiError('not_found', '运维事件不存在');
      return reply.code(204).send();
    });
  },
};
