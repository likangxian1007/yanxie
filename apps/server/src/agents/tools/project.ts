import { and, desc, eq, gt, ilike, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { agentViewer } from './viewer';
import { ApiError, ClaimMode, ClaimResourceKind, MemoryType, type WorkClaim } from '@srh/shared';
import { memoryFiles, messages, projectMembers, threads, users } from '../../db/schema';
import {
  createClaim,
  findConflicts,
  listClaims,
  releaseClaim,
  renewClaim,
} from '../../modules/claims/service';
import { listMemory, readMemory, writeMemory } from '../../modules/memory/service';
import { getThreadRow, listThreads, toThreads } from '../../modules/threads/service';
import { toMessages, type MessageRow } from '../../modules/timeline/service';
import { collab } from './collab-port';
import { ALL_ROLES, defineTool, ToolError, WORKER_ROLES, type ToolContext } from './types';

/**
 * 读项目状态（服务器是唯一真相源，每次读的都是实时状态）+ 记忆 + 认领。
 */
const BODY_CHARS = 4000;

function brief(m: Awaited<ReturnType<typeof toMessages>>[number]) {
  return {
    id: m.id,
    author: m.author.name,
    author_kind: m.author.kind,
    author_id: m.author.id,
    kind: m.kind,
    body: m.body.length > BODY_CHARS ? `${m.body.slice(0, BODY_CHARS)}…（截断）` : m.body,
    ...(m.kind === 'forward' ? { forward: m.meta } : {}),
    ...(m.kind === 'decision' ? { decision: (m.meta as { decision?: unknown }).decision } : {}),
    agent_visible: m.agentVisible,
    thread_id: m.threadId,
    root_of_thread_id: m.rootOfThreadId,
    reactions: m.reactions.map((r) => `${r.emoji}×${r.actors.length}`),
    outputs: m.outputs,
    sent_at: m.createdAt,
  };
}

async function memberNames(tc: ToolContext) {
  const rows = await tc.ctx.db.db
    .select({ id: users.id, name: users.name, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, tc.project.id));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * 这个 agent 能读哪个线程：项目线程都能读；个人会话只有它自己的个人 agent 能读。
 * 协调者读不到个人会话（转发后也不行）：它只看转发卡片里的附言和摘要，需要更多细节就问转发人。
 * 这样 agent 的思路（对全项目可见）里永远不会出现私聊原文。旁聊（agentVisible=false）任何 agent 都读不到。
 */
async function readableThread(tc: ToolContext, threadId: string) {
  const row = await getThreadRow(tc.ctx, tc.project.id, threadId);
  if (!row) throw new ToolError(`找不到线程 ${threadId}`);
  if (row.kind === 'personal' && row.id !== tc.thread?.id) {
    if (tc.session.role === 'coordinator' && row.forwardedAt) {
      throw new ToolError(
        '这是成员的个人会话，只能看转发卡片里的附言和摘要；需要更多细节请在时间线上问转发人。',
      );
    }
    throw new ToolError(`找不到线程 ${threadId}`);
  }
  return { row, until: null as Date | null };
}

function claimView(c: WorkClaim, names: Map<string, { name: string }>) {
  return {
    claim_id: c.id,
    resource_kind: c.resourceKind,
    resource_ref: c.resourceRef,
    mode: c.mode,
    holder: c.holder.name,
    holder_kind: c.holder.kind,
    holder_session: c.holder.kind === 'agent' ? c.holder.id : null,
    thread_id: c.threadId,
    on_behalf_of: c.onBehalfOfUserId
      ? (names.get(c.onBehalfOfUserId)?.name ?? c.onBehalfOfUserId)
      : null,
    intent: c.intent,
    status: c.status,
    expires_at: c.expiresAt,
  };
}

const PageArgs = {
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const projectTools = [
  defineTool({
    name: 'list_threads',
    description: '列出项目线程及其状态（分栏、进度清单首行、为谁工作、标签、是否已解决）。',
    roles: ALL_ROLES,
    schema: z.object({
      bucket: z
        .enum(['idle', 'working', 'blocked', 'review_ready', 'completed', 'failed'])
        .optional(),
      resolved: z.boolean().optional(),
      label: z.string().optional(),
      ...PageArgs,
    }),
    async run(tc, args) {
      const page = await listThreads(tc.ctx, tc.project.id, null, {
        kind: 'project',
        bucket: args.bucket,
        resolved: args.resolved,
        cursor: args.cursor,
        limit: args.limit ?? 50,
      });
      const names = await memberNames(tc);
      return {
        threads: page.items
          .filter((t) => !args.label || t.label === args.label)
          .map((t) => ({
            id: t.id,
            title: t.title,
            label: t.label,
            bucket: t.statusBucket,
            resolved: t.resolved,
            working_for: t.ownerUserId ? (names.get(t.ownerUserId)?.name ?? null) : null,
            status: t.statusText.split('\n').slice(0, 12).join('\n'),
            replies: t.replyCount,
            last_activity_at: t.lastActivityAt,
            root_message_id: t.rootMessageId,
          })),
        next_cursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: 'fetch_thread',
    description:
      '读一个线程的消息（含根消息与状态清单），默认从最新往前；跟着 next_cursor 继续读。',
    roles: ALL_ROLES,
    schema: z.object({
      thread_id: z.string(),
      order: z.enum(['newest_first', 'oldest_first']).optional(),
      ...PageArgs,
    }),
    async run(tc, args) {
      const { row, until } = await readableThread(tc, args.thread_id);
      const asc = args.order === 'oldest_first';
      const limit = args.limit ?? 30;
      const conds = [
        eq(messages.threadId, row.id),
        isNull(messages.deletedAt),
        eq(messages.agentVisible, true),
      ];
      if (until) conds.push(lte(messages.createdAt, until));
      if (args.cursor)
        conds.push(asc ? gt(messages.id, args.cursor) : lt(messages.id, args.cursor));
      const filtered = await tc.ctx.db.db
        .select()
        .from(messages)
        .where(and(...conds))
        .orderBy(asc ? messages.id : desc(messages.id))
        .limit(limit + 1);
      const page = filtered.slice(0, limit);
      const [thread] = await toThreads(tc.ctx, [row]);
      const root =
        row.kind === 'project'
          ? (
              await tc.ctx.db.db.select().from(messages).where(eq(messages.id, row.rootMessageId))
            )[0]
          : undefined;
      return {
        thread: {
          id: thread!.id,
          title: thread!.title,
          kind: thread!.kind,
          bucket: thread!.statusBucket,
          resolved: thread!.resolved,
          status: thread!.statusText,
          label: thread!.label,
        },
        root: root ? brief((await toMessages(tc.ctx, [root]))[0]!) : null,
        messages: (await toMessages(tc.ctx, page)).map(brief),
        next_cursor: filtered.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        ...(until ? { note: '这是成员转发的个人会话，只能读到转发时刻为止' } : {}),
      };
    },
  }),

  defineTool({
    name: 'fetch_timeline',
    description: '读项目时间线（协作台）的顶层消息，从最新往前；跟着 next_cursor 继续读。',
    roles: ALL_ROLES,
    schema: z.object({ ...PageArgs }),
    async run(tc, args) {
      const limit = args.limit ?? 30;
      const conds = [
        eq(messages.projectId, tc.project.id),
        isNull(messages.threadId),
        isNull(messages.deletedAt),
        eq(messages.agentVisible, true),
      ];
      if (args.cursor) conds.push(lt(messages.id, args.cursor));
      const rows = await tc.ctx.db.db
        .select()
        .from(messages)
        .where(and(...conds))
        .orderBy(desc(messages.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        messages: (await toMessages(tc.ctx, page)).map(brief),
        next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  }),

  defineTool({
    name: 'fetch_messages',
    description: '按 id 读取消息全文（最多 8 条）。读不到的 id 会被省略。',
    roles: ALL_ROLES,
    schema: z.object({ message_ids: z.array(z.string()).min(1).max(8) }),
    async run(tc, args) {
      const rows = await tc.ctx.db.db
        .select()
        .from(messages)
        .where(
          and(
            inArray(messages.id, args.message_ids),
            eq(messages.projectId, tc.project.id),
            isNull(messages.deletedAt),
            eq(messages.agentVisible, true),
          ),
        );
      const visible: MessageRow[] = [];
      for (const r of rows) {
        if (r.threadId && r.threadId !== tc.thread?.id) {
          try {
            const { until } = await readableThread(tc, r.threadId);
            if (until && r.createdAt > until) continue;
          } catch {
            continue;
          }
        }
        visible.push(r);
      }
      return {
        messages: (await toMessages(tc.ctx, visible)).map((m) => ({ ...brief(m), body: m.body })),
      };
    },
  }),

  defineTool({
    name: 'list_members',
    description: '列出项目成员及角色（owner / advisor / member / guest）和 user id。',
    roles: ALL_ROLES,
    schema: z.object({}),
    async run(tc) {
      const names = await memberNames(tc);
      return {
        members: [...names.values()].map((m) => ({ id: m.id, name: m.name, role: m.role })),
      };
    },
  }),

  defineTool({
    name: 'search_project',
    description: '在项目里全文检索：线程标题、时间线和项目线程的消息、项目记忆、文档。',
    roles: ALL_ROLES,
    schema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    async run(tc, args) {
      const limit = args.limit ?? 15;
      const q = `%${args.query.replace(/[%_\\]/gu, (c) => `\\${c}`)}%`;
      const db = tc.ctx.db.db;
      const threadHits = await db
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.projectId, tc.project.id),
            eq(threads.kind, 'project'),
            ilike(threads.title, q),
          ),
        )
        .limit(limit);
      const personalIds = (
        await db
          .select({ id: threads.id })
          .from(threads)
          .where(and(eq(threads.projectId, tc.project.id), eq(threads.kind, 'personal')))
      ).map((r) => r.id);
      const msgHits = (
        await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.projectId, tc.project.id),
              isNull(messages.deletedAt),
              eq(messages.agentVisible, true),
              ilike(messages.body, q),
            ),
          )
          .orderBy(desc(messages.id))
          .limit(limit * 2)
      )
        .filter(
          (m) => !m.threadId || !personalIds.includes(m.threadId) || m.threadId === tc.thread?.id,
        )
        .slice(0, limit);
      const memHits = await db
        .select({
          path: memoryFiles.path,
          description: memoryFiles.description,
          content: memoryFiles.content,
        })
        .from(memoryFiles)
        .where(
          and(
            eq(memoryFiles.projectId, tc.project.id),
            or(
              ilike(memoryFiles.content, q),
              ilike(memoryFiles.path, q),
              ilike(memoryFiles.description, q),
            ),
          ),
        )
        .limit(limit);
      const search = collab('search');
      const docHits = search
        ? await search
            .searchDocuments(tc.ctx, tc.project.id, args.query, await agentViewer(tc))
            .catch(() => [])
        : [];
      const snip = (text: string) => {
        const i = text.toLowerCase().indexOf(args.query.toLowerCase());
        const start = Math.max(0, i - 60);
        return text.slice(start, start + 200).replace(/\s+/gu, ' ');
      };
      return {
        threads: threadHits.map((t) => ({ id: t.id, title: t.title, resolved: t.resolved })),
        messages: msgHits.map((m) => ({
          id: m.id,
          thread_id: m.threadId,
          author: m.authorName,
          snippet: snip(m.body),
          sent_at: m.createdAt.toISOString(),
        })),
        memory: memHits.map((m) => ({
          path: m.path,
          description: m.description,
          snippet: snip(m.content),
        })),
        documents: docHits.slice(0, limit),
      };
    },
  }),

  // ---------------------------------------------------------------- 记忆

  defineTool({
    name: 'memory_list',
    description: '列出项目记忆文件（路径、一句话描述、类型、版本）。',
    roles: ALL_ROLES,
    schema: z.object({}),
    async run(tc) {
      const files = await listMemory(tc.ctx, tc.project.id);
      return {
        files: files.map((f) => ({
          path: f.path,
          description: f.description,
          type: f.type,
          version: f.version,
        })),
      };
    },
  }),

  defineTool({
    name: 'memory_read',
    description: '读一个项目记忆文件全文及其当前版本（写之前先读，拿 base_version）。',
    roles: ALL_ROLES,
    schema: z.object({ path: z.string() }),
    async run(tc, args) {
      const f = await readMemory(tc.ctx, tc.project.id, args.path);
      if (!f) throw new ToolError(`没有这个记忆文件：${args.path}`);
      return {
        path: f.path,
        description: f.description,
        type: f.type,
        version: f.version,
        content: f.content,
      };
    },
  }),

  defineTool({
    name: 'memory_write',
    description:
      '整体替换一个项目记忆文件（一主题一文件，约 3KB 以内，写事实或规则及其原因，不写过程）。新文件 base_version=0；否则传 memory_read 读到的版本，被别人改过会被拒绝并返回最新内容，合并后重写。新增文件后记得更新 MEMORY.md 索引。',
    roles: ALL_ROLES,
    schema: z.object({
      path: z.string(),
      content: z.string().max(16_000),
      description: z.string().max(200).optional(),
      type: MemoryType.optional(),
      base_version: z.number().int().min(0),
    }),
    async run(tc, args) {
      try {
        const f = await writeMemory(tc.ctx, tc.actor, tc.project.id, {
          path: args.path,
          content: args.content,
          description: args.description ?? '',
          type: args.type ?? null,
          baseVersion: args.base_version,
        });
        return { ok: true, path: f.path, version: f.version };
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          const cur = (
            err.details as { current?: { version: number; content: string } } | undefined
          )?.current;
          return {
            ok: false,
            error: '版本已过期：别的会话改过这个文件。合并下面的最新内容后用新版本号重写。',
            current_version: cur?.version,
            current_content: cur?.content,
          };
        }
        throw err;
      }
    },
  }),

  // ---------------------------------------------------------------- 认领

  defineTool({
    name: 'list_claims',
    description: '查看认领（谁的 agent 正在改什么、为谁、意图、到期时间）。默认只看有效的。',
    roles: ALL_ROLES,
    schema: z.object({
      status: z.enum(['active', 'released', 'expired']).optional(),
      resource_kind: ClaimResourceKind.optional(),
      resource_ref: z.string().optional(),
      thread_id: z.string().optional(),
    }),
    async run(tc, args) {
      const list = await listClaims(tc.ctx, tc.project.id, {
        status: args.status ?? 'active',
        resourceKind: args.resource_kind,
        resourceRef: args.resource_ref,
        threadId: args.thread_id,
      });
      const names = await memberNames(tc);
      return { claims: list.map((c) => claimView(c, names)) };
    },
  }),

  defineTool({
    name: 'check_conflicts',
    description:
      '派活前检查：计划要碰的资源是否与现有认领重叠。每项带 resource_kind、resource_ref、mode。返回重叠认领的持有者、线程、为谁、意图、到期时间。',
    roles: ALL_ROLES,
    schema: z.object({
      resources: z
        .array(
          z.object({
            resource_kind: ClaimResourceKind.exclude(['experiment']),
            resource_ref: z.string().min(1),
            mode: ClaimMode.optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
    async run(tc, args) {
      const res = await findConflicts(
        tc.ctx,
        tc.project.id,
        args.resources.map((r) => ({
          resourceKind: r.resource_kind,
          resourceRef: r.resource_ref,
          mode: r.mode ?? 'exclusive',
        })),
        tc.session.role === 'coordinator'
          ? {}
          : { holderId: tc.session.id, threadId: tc.thread?.id ?? null },
      );
      const names = await memberNames(tc);
      return {
        conflicts: res.map((r) => ({
          resource: r.resource,
          conflicts_with: r.conflictsWith.map((c) => claimView(c, names)),
        })),
        clear: res.length === 0,
        ...(res.length
          ? {
              note:
                tc.session.role === 'coordinator'
                  ? '被占用的资源：把活派给线程，并在 brief 里写明“先 claim，失败就把草稿写成文件，等 <claim-released> 唤醒后再并入”。不要承诺由你自己并入。'
                  : '要等对方放开就调用 claim：失败时会登记你为等待者，放开时你会被唤醒。',
            }
          : {}),
      };
    },
  }),

  defineTool({
    name: 'claim',
    description:
      '动手改共享资源之前先认领。resource_ref：document=doc_xxx；doc_section=doc_xxx#<read_document 大纲里的标题原文>；file=路径或 glob；experiment=exp_xxx；research=研究空间ID（创建时用new）；card=crd_xxx；topic=自由文本。默认 exclusive、30 分钟。认领只在这一轮里有效：本轮结束（回复完、出错或被中止）时运行时会自动全部放开，下一轮要改再重新认领；自动续跑时会续期。',
    roles: WORKER_ROLES,
    schema: z.object({
      resource_kind: ClaimResourceKind.exclude(['experiment']),
      resource_ref: z.string().min(1).max(500),
      mode: ClaimMode.optional(),
      intent: z.string().min(1).max(300),
      ttl_sec: z.number().int().min(60).max(86_400).optional(),
    }),
    async run(tc, args) {
      try {
        const c = await createClaim(tc.ctx, tc.actor, tc.project.id, {
          resourceKind: args.resource_kind,
          resourceRef: args.resource_ref,
          mode: args.mode ?? 'exclusive',
          intent: args.intent,
          ttlSec: args.ttl_sec ?? 1800,
          threadId: tc.thread?.id,
          onBehalfOfUserId: tc.session.workingForUserId,
        });
        return { ok: true, claim_id: c.id, expires_at: c.expiresAt };
      } catch (err) {
        if (err instanceof ApiError && err.code === 'claim_conflict') {
          const names = await memberNames(tc);
          const claims = ((err.details as { claims?: WorkClaim[] } | undefined)?.claims ?? []).map(
            (c) => claimView(c, names),
          );
          return {
            ok: false,
            claim_conflict: true,
            error:
              '与现有认领重叠，没有认领成功。不要动这个资源；按线程提示词第 4 节处理。你已登记为等待者：对方放开或认领过期时，你会收到 <claim-released> 唤醒，到时重新认领并把草稿并进去。',
            claims,
          };
        }
        throw err;
      }
    },
  }),

  defineTool({
    name: 'renew_claim',
    description: '续期一个认领（运行时每轮也会自动续期）。',
    roles: WORKER_ROLES,
    schema: z.object({
      claim_id: z.string(),
      ttl_sec: z.number().int().min(60).max(86_400).optional(),
    }),
    async run(tc, args) {
      const c = await renewClaim(tc.ctx, tc.actor, tc.project.id, args.claim_id, args.ttl_sec);
      return { ok: true, expires_at: c.expiresAt };
    },
  }),

  defineTool({
    name: 'release_claim',
    description: '做完就放：释放你的认领。',
    roles: WORKER_ROLES,
    schema: z.object({ claim_id: z.string() }),
    async run(tc, args) {
      await releaseClaim(tc.ctx, tc.actor, tc.project.id, args.claim_id);
      return { ok: true };
    },
  }),
];
