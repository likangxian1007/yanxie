import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, INBOX_PRIORITY, MessageMentions } from '@srh/shared';
import type { AppContext } from '../../context';
import type { UserRow } from '../auth/service';
import { memberRole, roleCan, type Capability } from '../collab-common/guard';
import { inboxItems, projectMembers, projects, threads } from '../../db/schema';
import { listDocuments, readDocument } from '../documents/service';
import { toInboxItem } from '../inbox/service';
import type { ApiTokenRow } from '../integrations/service';
import { getProjectRow, listMembers, listProjectsForUser, toProject } from '../projects/service';
import { accessOf, type Viewer } from '../sharing/access';
import { loadResource } from '../sharing/service';
import { listMessages } from '../timeline/service';
import { requireVisibleThread, toThread } from '../threads/service';

/**
 * 九个兼容 MCP 工具（API.md §9，ARCHITECTURE.md §17）。
 *
 * 设计纪律（改这里之前先读）：
 * - 兼容入口与通用操作目录共用令牌、项目与资源权限；写入通过统一 REST 生命周期。
 *   敏感管理与人工确认仅限网页会话，按操作目录的 interactive 分类拒绝。
 * - **不写 SQL 的业务逻辑**：除收件箱（inbox 模块没有导出 service 函数）之外，
 *   一律调用既有 service，继承它们原有的角色、成员、个人线程过滤。
 * - **写工具单列 `write: true`**：只读令牌根本不会看到它们（`tools/list` 就被裁掉），
 *   调用时还有一次兜底判定。
 * - 出错一律返回 `isError` 的工具级错误，不抛 500（MCP 客户端只会看到一句中文）。
 */
export interface McpToolCtx {
  ctx: AppContext;
  user: UserRow;
  token: ApiTokenRow;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** 写操作：只读令牌看不到，且要计入每日额度 */
  write: boolean;
  schema: () => Record<string, z.ZodType>;
  run?: (args: Record<string, unknown>, c: McpToolCtx) => Promise<unknown>;
}

// ---------------------------------------------------------------- 入参与权限小工具

const text = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
};

function needId(args: Record<string, unknown>, key: string): string {
  const v = text(args, key);
  if (!v) throw new ApiError('validation_failed', `缺少 ${key}`);
  return v;
}

function optInt(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = Number(args[key]);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), max);
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const v = text(args, key);
  return v ? v : undefined;
}

/**
 * 项目权限：和 REST 的两条 guard 链同规则——限项目范围外一律「不存在」（不泄露是否存在），
 * 不是成员 404，能力不够 403。这里不经过 FastifyRequest，所以单独实现一份。
 */
async function projectAccess(c: McpToolCtx, projectId: string, cap: Capability): Promise<Viewer> {
  if (c.token.projectIds.length > 0 && !c.token.projectIds.includes(projectId)) {
    throw new ApiError('not_found', '项目不存在或你不是成员');
  }
  const role = await memberRole(c.ctx, projectId, c.user.id);
  if (!role) throw new ApiError('not_found', '项目不存在或你不是成员');
  if (!roleCan(role, cap)) {
    throw new ApiError(
      'forbidden',
      cap === 'write' ? '你在该项目里没有写权限（访客只能查看）' : '你没有权限进行这个操作',
    );
  }
  return { userId: c.user.id, role };
}

// ---------------------------------------------------------------- 收件箱（镜像 inbox 模块的规则）

/** 与 `modules/inbox` 的 GET /inbox 同条件：本人 + 仍是成员 + 未归档项目 + 令牌限项目 */
async function listInbox(c: McpToolCtx, projectId: string | null, done: boolean, limit: number) {
  const conds: SQL[] = [eq(inboxItems.userId, c.user.id), isNull(projects.archivedAt)];
  if (projectId) conds.push(eq(inboxItems.projectId, projectId));
  else if (c.token.projectIds.length > 0) {
    conds.push(inArray(inboxItems.projectId, c.token.projectIds));
  }
  conds.push(done ? isNotNull(inboxItems.doneAt) : isNull(inboxItems.doneAt));
  const rows = await c.ctx.db.db
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
    .orderBy(desc(inboxItems.createdAt))
    .limit(500);
  return rows
    .map((r) => r.item)
    .sort(
      (a, b) =>
        INBOX_PRIORITY[a.kind] - INBOX_PRIORITY[b.kind] ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : -1),
    )
    .slice(0, limit)
    .map(toInboxItem);
}

// ---------------------------------------------------------------- 工具清单

/** 读工具：只读令牌也能用 */
const READ_TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    title: '列出我能看到的项目',
    description:
      '列出这个令牌的主人参与的项目（已按令牌限定的项目过滤）。返回 id、名称、我的角色、未处理收件箱数。',
    write: false,
    schema: () => ({}),
    run: async (_args, c) => {
      const rows = await listProjectsForUser(c.ctx, c.user.id, c.token.projectIds);
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        unread: p.unread,
        eventSeq: p.eventSeq,
        archivedAt: p.archivedAt,
      }));
    },
  },
  {
    name: 'get_project',
    title: '项目概况',
    description:
      '看一个项目的名称、简介、我的角色、成员、文档清单和最近的线程。用它拿到 documentId / threadId 再去读正文或消息。',
    write: false,
    schema: () => ({ projectId: z.string().min(1).describe('项目 id，形如 prj_…') }),
    run: async (args, c) => {
      const projectId = needId(args, 'projectId');
      const viewer = await projectAccess(c, projectId, 'view');
      const row = await getProjectRow(c.ctx, projectId);
      if (!row) throw new ApiError('not_found', '项目不存在或你不是成员');
      const [members, documents, recentThreads] = await Promise.all([
        listMembers(c.ctx, projectId),
        listDocuments(c.ctx, projectId, {}, viewer),
        c.ctx.db.db
          .select({
            id: threads.id,
            kind: threads.kind,
            title: threads.title,
            statusBucket: threads.statusBucket,
            resolved: threads.resolved,
            lastActivityAt: threads.lastActivityAt,
          })
          .from(threads)
          .where(
            and(
              eq(threads.projectId, projectId),
              // 个人线程只有主人能看（与 threads/requireVisibleThread 一致）
              or(eq(threads.kind, 'project'), eq(threads.ownerUserId, c.user.id))!,
            ),
          )
          .orderBy(desc(threads.lastActivityAt))
          .limit(10),
      ]);
      return {
        project: toProject(row),
        members: members.map((m) => ({ id: m.user.id, name: m.user.name, role: m.role })),
        documents: documents.map((d) => ({
          id: d.id,
          title: d.title,
          kind: d.kind,
          updatedAt: d.updatedAt,
        })),
        threads: recentThreads.map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          statusBucket: t.statusBucket,
          resolved: t.resolved,
          lastActivityAt: t.lastActivityAt,
        })),
      };
    },
  },
  {
    name: 'get_timeline',
    title: '读项目时间线',
    description:
      '读项目时间线的顶层消息（不含线程内回复），按时间倒序。cursor 传上一页返回的 nextCursor。',
    write: false,
    schema: () => ({
      projectId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional().describe('默认 20，最多 50'),
      cursor: z.string().optional().describe('上一页的 nextCursor'),
    }),
    run: async (args, c) => {
      const projectId = needId(args, 'projectId');
      await projectAccess(c, projectId, 'view');
      return listMessages(c.ctx, projectId, null, {
        limit: optInt(args, 'limit', 20, 50),
        ...(optionalText(args, 'cursor') ? { cursor: optionalText(args, 'cursor') } : {}),
        order: 'desc',
      });
    },
  },
  {
    name: 'get_thread',
    title: '读一个线程',
    description: '读线程本身和消息。个人线程只有主人能读；用 messages.nextCursor 继续读取历史。',
    write: false,
    schema: () => ({
      projectId: z.string().min(1),
      threadId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().optional().describe('上一页 messages.nextCursor'),
    }),
    run: async (args, c) => {
      const projectId = needId(args, 'projectId');
      const threadId = needId(args, 'threadId');
      await projectAccess(c, projectId, 'view');
      // 个人线程只有主人可见（这里就会 404，不会把别人线程的内容吐出去）
      const row = await requireVisibleThread(c.ctx, projectId, threadId, c.user.id);
      const thread = await toThread(c.ctx, row);
      const messages = await listMessages(c.ctx, projectId, threadId, {
        limit: optInt(args, 'limit', 20, 50),
        ...(optionalText(args, 'cursor') ? { cursor: optionalText(args, 'cursor') } : {}),
        order: 'desc',
      });
      return { thread, messages };
    },
  },
  {
    name: 'read_document',
    title: '读文档正文',
    description:
      '读取本人有权访问的文档正文。长文档按 offset 分段，用 nextOffset 继续读；documentId 从 get_project 获取。',
    write: false,
    schema: () => ({
      projectId: z.string().min(1),
      documentId: z.string().min(1),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('正文字符偏移，默认 0；续读传 nextOffset'),
    }),
    run: async (args, c) => {
      const projectId = needId(args, 'projectId');
      const documentId = needId(args, 'documentId');
      const viewer = await projectAccess(c, projectId, 'view');
      const resource = await loadResource(c.ctx, 'document', documentId);
      if (
        !resource ||
        resource.projectId !== projectId ||
        (await accessOf(c.ctx, resource, viewer)) === 'none'
      ) {
        throw new ApiError('not_found', '文档不存在，或你没有访问权限');
      }
      const content = await readDocument(c.ctx, projectId, documentId);
      const MAX = 20_000;
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const end = offset + MAX;
      const truncated = content.markdown.length > end;
      return {
        document: content.meta,
        outline: content.outline,
        markdown: content.markdown.slice(offset, end),
        offset,
        totalLength: content.markdown.length,
        nextOffset: truncated ? end : null,
        ...(truncated
          ? {
              truncated: true,
              note: `正文共 ${content.markdown.length} 字，请用 nextOffset 继续读取`,
            }
          : {}),
      };
    },
  },
  {
    name: 'list_inbox',
    title: '看我的收件箱',
    description:
      '列出「待我处理」的条目（决策卡、请你审阅、有人 @ 你、认领冲突、派给你的活等），按优先级排序。',
    write: false,
    schema: () => ({
      projectId: z.string().optional().describe('不填 = 我能看到的所有项目'),
      done: z.boolean().optional().describe('默认 false，只看未处理'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async (args, c) => {
      const projectId = optionalText(args, 'projectId') ?? null;
      if (projectId) await projectAccess(c, projectId, 'view');
      return listInbox(c, projectId, args.done === true, optInt(args, 'limit', 30, 100));
    },
  },
];

/** 写工具：需要 write 权限的令牌，且计入每日额度 */
const WRITE_TOOLS: ToolDef[] = [
  {
    name: 'post_message',
    title: '以本人身份发消息',
    description:
      '在时间线或线程发消息并标明令牌来源；agentVisible=false 仅同步结果，显式 mentions 才通知成员。',
    write: true,
    schema: () => ({
      projectId: z.string().min(1),
      body: z.string().min(1).max(20_000),
      threadId: z.string().optional(),
      agentVisible: z.boolean().optional(),
      mentions: MessageMentions.optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/u)
        .optional(),
    }),
  },
  {
    name: 'create_todo',
    title: '建待办',
    description: '创建项目共享待办。',
    write: true,
    schema: () => ({
      projectId: z.string().min(1),
      title: z.string().min(1).max(200),
      notes: z.string().max(5000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().optional(),
      assigneeId: z.string().optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/u)
        .optional(),
    }),
  },
  {
    name: 'mark_inbox_done',
    title: '标记收件箱处理完',
    description: '标记自己的提醒已处理；这不会完成提醒关联的任务或审批。',
    write: true,
    schema: () => ({
      itemId: z.string().min(1),
      done: z.boolean().optional(),
      read: z.boolean().optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/u)
        .optional(),
    }),
  },
];

export const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** 这张令牌能用哪些工具：只读令牌连写工具都看不到（不是"调了才报错"） */
export function toolsFor(token: ApiTokenRow): ToolDef[] {
  const canWrite = token.scopes.includes('write');
  return canWrite ? ALL_TOOLS : READ_TOOLS;
}

export type { ToolDef };
