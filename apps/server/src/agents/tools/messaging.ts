import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { OutputKind } from '@srh/shared';
import { agentSessions, decisions, messages, threads } from '../../db/schema';
import {
  createDecision,
  createProjectThread,
  getThreadRow,
  settleDecision,
  toThread,
  updateThread,
} from '../../modules/threads/service';
import {
  createMessage,
  editMessage,
  getMessageRow,
  setReaction,
} from '../../modules/timeline/service';
import { enqueueWake } from '../runtime/wake';
import { ALL_ROLES, defineTool, ToolError, WORKER_ROLES, type ToolContext } from './types';

/**
 * 说话与协调类工具：reply、post_message、update_status、react、no_reply_needed、start_thread、
 * message_thread、ask_decision、send_to_coordinator……
 * 单写者规则（ARCHITECTURE §5.4）在这里强制：reply 没有 thread_id，只能写自己的线程；协调者没有 reply。
 */
const Outputs = z
  .array(
    z.object({
      kind: OutputKind.exclude(['experiment']),
      ref: z.string().min(1),
      title: z.string().min(1).max(200),
    }),
  )
  .max(10)
  .optional()
  .describe('本条消息交付的产出（文件 id、链接 URL、文档 id、汇报 id），会进资料库');

function ownThread(tc: ToolContext) {
  if (!tc.thread) throw new ToolError('这个会话没有线程');
  return tc.thread;
}

function activityFromStatus(text: string): string | null {
  const line = text
    .split(/\r?\n/u)
    .map((l) => l.replace(/\*\*/gu, '').trim())
    .find((l) => l.startsWith('✱'));
  return line ? line.slice(1).trim().slice(0, 80) : null;
}

/** 消息必须属于本项目，且对这个 agent 可见（个人会话只对它自己的个人 agent 可见） */
async function visibleMessage(tc: ToolContext, messageId: string) {
  const row = await getMessageRow(tc.ctx, tc.project.id, messageId);
  // 旁聊对 agent 不存在
  if (!row || !row.agentVisible) throw new ToolError(`找不到消息 ${messageId}`);
  if (row.threadId && row.threadId !== tc.thread?.id) {
    const t = await getThreadRow(tc.ctx, tc.project.id, row.threadId);
    if (t?.kind === 'personal') throw new ToolError(`找不到消息 ${messageId}`);
  }
  return row;
}

export const messagingTools = [
  defineTool({
    name: 'reply',
    description:
      '在你自己的线程（或个人会话）里发一条回复。只用于结果、阻塞、需要成员拍板的决定。没有 thread_id 参数。',
    roles: WORKER_ROLES,
    visible: true,
    schema: z.object({ body: z.string().min(1).max(20_000), outputs: Outputs }),
    async run(tc, args) {
      const thread = ownThread(tc);
      const msg = await createMessage(tc.ctx, {
        projectId: tc.project.id,
        threadId: thread.id,
        author: tc.actor,
        body: args.body,
        meta: { agentSessionId: tc.session.id },
        outputs: args.outputs ?? [],
      });
      return { ok: true, message_id: msg.id };
    },
  }),

  defineTool({
    name: 'post_message',
    description:
      '在项目时间线（协作台）发一条消息。协调者专用：回答项目问题、进度汇报、一行回执、拆分请求时的分项行。',
    roles: ['coordinator'],
    visible: true,
    schema: z.object({ body: z.string().min(1).max(8000), outputs: Outputs }),
    async run(tc, args) {
      const msg = await createMessage(tc.ctx, {
        projectId: tc.project.id,
        threadId: null,
        author: tc.actor,
        body: args.body,
        meta: { agentSessionId: tc.session.id },
        outputs: args.outputs ?? [],
      });
      return { ok: true, message_id: msg.id };
    },
  }),

  defineTool({
    name: 'update_status',
    description:
      '替换本线程的进度清单（线程卡片上显示）。第 1 行标题，空一行，之后每步一行，以 ✓（完成）✱（进行中）○（未开始）开头，刚完成的一步整行加粗。',
    roles: WORKER_ROLES,
    visible: true,
    schema: z.object({
      text: z.string().min(1).max(4000),
      start_new: z.boolean().optional().describe('只在一个全新任务的第一次调用时传 true'),
    }),
    async run(tc, args) {
      const thread = ownThread(tc);
      const updated = await updateThread(tc.ctx, thread, { statusText: args.text }, tc.actor);
      tc.thread = { ...thread, statusText: args.text };
      await tc.setActivity(activityFromStatus(args.text));
      return { ok: true, status_bucket: updated.statusBucket };
    },
  }),

  defineTool({
    name: 'update_message',
    description: '修改你自己之前发的一条消息（更正、划掉错误结论、补链接）。不会通知任何人。',
    roles: ALL_ROLES,
    schema: z.object({ message_id: z.string(), body: z.string().min(1).max(20_000) }),
    async run(tc, args) {
      const row = await visibleMessage(tc, args.message_id);
      if (row.authorKind !== 'agent') throw new ToolError('只能修改 agent 自己发的消息');
      // 同一线程的 agent 都以本线程会话为作者；协调者只能改自己的
      if (row.authorId !== tc.session.id) throw new ToolError('只能修改你自己发的消息');
      await editMessage(tc.ctx, tc.project.id, row.id, tc.actor, args.body);
      return { ok: true };
    },
  }),

  defineTool({
    name: 'react',
    description:
      '给一条消息加表情反应作为确认：👀 我在做了；👍 收到/同意/已处理；🎉 真正值得庆祝的结果。',
    roles: ALL_ROLES,
    visible: true,
    schema: z.object({ message_id: z.string(), emoji: z.string().min(1).max(16) }),
    async run(tc, args) {
      await visibleMessage(tc, args.message_id);
      await setReaction(tc.ctx, tc.project.id, args.message_id, tc.actor, args.emoji, true);
      return { ok: true };
    },
  }),

  defineTool({
    name: 'unreact',
    description: '去掉你之前加的表情（之后发了正式回复时，去掉作占位用的 👀）。',
    roles: ALL_ROLES,
    schema: z.object({ message_id: z.string(), emoji: z.string().min(1).max(16) }),
    async run(tc, args) {
      await visibleMessage(tc, args.message_id);
      await setReaction(tc.ctx, tc.project.id, args.message_id, tc.actor, args.emoji, false);
      return { ok: true };
    },
  }),

  defineTool({
    name: 'no_reply_needed',
    description:
      '这一轮不需要对外说任何话时调用（成员之间聊天、只为知情的动态、重复的消息）。调用后本轮结束。',
    roles: ALL_ROLES,
    visible: true,
    schema: z.object({
      // 模型偶尔传中文理由：不认识的一律当 other，不要因此让一轮多跑一步（验收附录 E 观察）
      reason: z
        .preprocess(
          (v) =>
            typeof v === 'string' &&
            ![
              'nothing_to_add',
              'duplicate',
              'awaiting_context',
              'not_relevant',
              'user_requested_silence',
              'other',
            ].includes(v)
              ? 'other'
              : v,
          z.enum([
            'nothing_to_add',
            'duplicate',
            'awaiting_context',
            'not_relevant',
            'user_requested_silence',
            'other',
          ]),
        )
        .optional(),
    }),
    async run() {
      return { ok: true };
    },
  }),

  defineTool({
    name: 'set_thread_label',
    description:
      '设置本线程的标签（两三个字的模块名，优先复用 list_threads 里已有的标签原文）。空串清除。',
    roles: ['thread'],
    schema: z.object({ label: z.string().max(20) }),
    async run(tc, args) {
      const thread = ownThread(tc);
      await updateThread(tc.ctx, thread, { label: args.label.trim() || null }, tc.actor);
      return { ok: true };
    },
  }),

  defineTool({
    name: 'set_thread_resolved',
    description:
      '把线程标为已解决（resolved=true）或重开（false）。线程 agent 只能操作自己的线程（不传 thread_id）；协调者必须传 thread_id。已解决会释放该线程的认领。',
    roles: ['coordinator', 'thread'],
    schema: z.object({ thread_id: z.string().optional(), resolved: z.boolean() }),
    async run(tc, args) {
      let row;
      if (tc.session.role === 'coordinator') {
        if (!args.thread_id) throw new ToolError('协调者需要传 thread_id');
        row = await getThreadRow(tc.ctx, tc.project.id, args.thread_id);
      } else {
        if (args.thread_id && args.thread_id !== tc.thread?.id) {
          throw new ToolError('只能解决你自己的线程');
        }
        row = tc.thread;
      }
      if (!row || row.kind !== 'project') throw new ToolError('找不到这个项目线程');
      const t = await updateThread(tc.ctx, row, { resolved: args.resolved }, tc.actor);
      if (tc.thread?.id === row.id) tc.thread = { ...row, resolved: args.resolved };
      return { ok: true, thread_id: t.id, resolved: t.resolved };
    },
  }),

  defineTool({
    name: 'ask_decision',
    description:
      '发一张决策卡：一个只有成员能拍板的分叉（改变目标、成员会注意到的产出、不可撤销的一步）。问题动词开头约 12 个字；2–4 个选项，每个一两个词 + 一句后果；标推荐项与理由。卡片不阻塞工作，按推荐项继续。',
    roles: WORKER_ROLES,
    visible: true,
    schema: z.object({
      question: z.string().min(1).max(300),
      context: z.string().max(1200).optional(),
      options: z
        .array(
          z.object({ label: z.string().min(1).max(40), consequence: z.string().min(1).max(200) }),
        )
        .min(2)
        .max(4),
      recommended: z.number().int().min(0).max(3),
      reason: z.string().max(200).optional(),
    }),
    async run(tc, args) {
      const thread = ownThread(tc);
      const d = await createDecision(tc.ctx, {
        projectId: tc.project.id,
        threadId: thread.id,
        actor: tc.actor,
        question: args.question,
        context: args.context,
        options: args.options,
        recommended: args.recommended,
        reason: args.reason,
        notifyUserId: tc.session.workingForUserId,
      });
      return { ok: true, decision_id: d.id, message_id: d.messageId };
    },
  }),

  defineTool({
    name: 'close_decision',
    description:
      '成员用文字（而不是点卡片）回答了决策卡时，关闭卡片：chose 为你按他的话采用的选项序号；不传 chose = 撤回卡片。成员已点选的卡片以成员为准，不能改。',
    roles: WORKER_ROLES,
    schema: z.object({ message_id: z.string(), chose: z.number().int().min(0).max(3).optional() }),
    async run(tc, args) {
      const [row] = await tc.ctx.db.db
        .select()
        .from(decisions)
        .where(
          and(eq(decisions.messageId, args.message_id), eq(decisions.projectId, tc.project.id)),
        );
      if (!row || row.threadId !== tc.thread?.id) throw new ToolError('找不到本线程的这张决策卡');
      if (row.state !== 'open') {
        return {
          ok: true,
          already: row.state,
          chosen: row.chosen,
          note: '卡片已被处理，以现有结果为准',
        };
      }
      const d = await settleDecision(tc.ctx, row, args.chose ?? null, tc.actor);
      return { ok: true, state: d.state, chosen: d.chosen };
    },
  }),

  defineTool({
    name: 'send_to_coordinator',
    description:
      '给协调者发一条备注（成员看不到）：只在协调者必须知道某事才能做它的工作时用，例如需要把建议稿转给另一个线程、发现与别的线程目标冲突。',
    roles: WORKER_ROLES,
    schema: z.object({ text: z.string().min(1).max(4000) }),
    async run(tc, args) {
      const [coord] = await tc.ctx.db.db
        .select()
        .from(agentSessions)
        .where(
          and(eq(agentSessions.projectId, tc.project.id), eq(agentSessions.role, 'coordinator')),
        );
      if (!coord) throw new ToolError('项目没有协调者');
      await enqueueWake(tc.ctx, coord, 'cross-session', {
        type: 'cross-session',
        fromSessionId: tc.session.id,
        // 个人会话的内容不外泄：只给标题，不给线程 id
        fromThreadId: tc.thread?.kind === 'project' ? tc.thread.id : null,
        fromTitle: tc.thread?.kind === 'personal' ? '某成员的个人会话' : (tc.thread?.title ?? ''),
        text: args.text,
      });
      return { ok: true, delivered: true };
    },
  }),

  defineTool({
    name: 'start_thread',
    description:
      '为一个新需求开线程，交给线程 agent 去做。anchor_message_id 是成员的请求消息（或你为拆分项发的那行、或转发卡片）。成员原话放 context_message_ids，服务器逐字转给线程。同一锚点重复调用返回 already_running。',
    roles: ['coordinator'],
    visible: true,
    schema: z.object({
      anchor_message_id: z.string(),
      title: z.string().min(2).max(40).describe('4 到 12 个字，用成员自己的词'),
      brief: z.string().min(1).max(6000),
      context_message_ids: z.array(z.string()).max(8).optional(),
      ack: z.string().min(1).max(300).describe('线程里的第一句话：先做什么'),
      project_ack: z
        .string()
        .max(200)
        .optional()
        .describe('时间线上一行“开始了”；同一批请求只第一条带'),
      project_post_id: z
        .string()
        .optional()
        .describe('同批后续请求：复用第一条 project_ack 的消息 id'),
      working_for_user_id: z.string().optional(),
    }),
    async run(tc, args) {
      const anchor = await getMessageRow(tc.ctx, tc.project.id, args.anchor_message_id);
      if (!anchor) throw new ToolError(`找不到锚点消息 ${args.anchor_message_id}`);
      if (anchor.threadId) throw new ToolError('锚点必须是时间线上的消息，不能是线程里的回复');
      const workingFor =
        args.working_for_user_id ??
        (anchor.authorKind === 'user' ? anchor.authorId : null) ??
        tc.requesterUserId;

      const res = await createProjectThread(tc.ctx, {
        projectId: tc.project.id,
        rootMessageId: anchor.id,
        title: args.title.trim(),
        workingForUserId: workingFor,
        actor: tc.actor,
      });
      if (res.alreadyRunning) {
        return {
          already_running: true,
          thread_id: res.thread.id,
          note: '这个锚点已经有线程，这次什么都没送达；用 message_thread 转过去',
        };
      }
      let projectPostId = args.project_post_id ?? null;
      if (args.project_ack?.trim() && !projectPostId) {
        const post = await createMessage(tc.ctx, {
          projectId: tc.project.id,
          threadId: null,
          author: tc.actor,
          body: args.project_ack.trim(),
          meta: { agentSessionId: tc.session.id, ackFor: res.thread.id },
        });
        projectPostId = post.id;
      }
      // 线程第一句话以线程 agent 的身份发出
      const threadActor = { kind: 'agent' as const, id: res.sessionId, name: tc.actor.name };
      await createMessage(tc.ctx, {
        projectId: tc.project.id,
        threadId: res.thread.id,
        author: threadActor,
        body: args.ack.trim(),
        meta: { agentSessionId: res.sessionId },
      });
      const cited = [
        ...(anchor.authorKind === 'user' || anchor.kind === 'forward' ? [anchor.id] : []),
        ...(args.context_message_ids ?? []),
      ];
      await enqueueWake(tc.ctx, { id: res.sessionId, projectId: tc.project.id }, 'spawn', {
        type: 'relay',
        reason: 'spawn',
        note: args.brief,
        citedIds: [...new Set(cited)].slice(0, 9),
        fromSessionId: tc.session.id,
      });
      return {
        ok: true,
        thread_id: res.thread.id,
        link: `[${res.thread.title}](#${res.thread.id})`,
        project_post_id: projectPostId,
      };
    },
  }),

  defineTool({
    name: 'message_thread',
    description:
      '把跟进转给已有线程（线程 agent 会被唤醒）。note 一两句写给线程 agent；成员原话一律放 context_message_ids。目标线程已解决且转的是成员新消息时会自动重开（返回 reopened）。',
    roles: ['coordinator'],
    visible: true,
    schema: z.object({
      thread_id: z.string(),
      note: z.string().min(1).max(4000),
      context_message_ids: z.array(z.string()).max(8).optional(),
    }),
    async run(tc, args) {
      const row = await getThreadRow(tc.ctx, tc.project.id, args.thread_id);
      if (!row || row.kind !== 'project') throw new ToolError('找不到这个项目线程');
      const [session] = await tc.ctx.db.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.threadId, row.id));
      if (!session) throw new ToolError('这个线程没有 agent');
      const ids = args.context_message_ids ?? [];
      let reopened = false;
      if (row.resolved && ids.length) {
        const userMsgs = await tc.ctx.db.db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              inArray(messages.id, ids),
              eq(messages.projectId, tc.project.id),
              eq(messages.authorKind, 'user'),
              isNull(messages.deletedAt),
            ),
          );
        if (userMsgs.length) {
          await updateThread(tc.ctx, row, { resolved: false }, tc.actor);
          reopened = true;
        }
      }
      await enqueueWake(tc.ctx, session, 'mention', {
        type: 'relay',
        reason: 'followup',
        note: args.note,
        citedIds: ids,
        fromSessionId: tc.session.id,
      });
      const [fresh] = await tc.ctx.db.db.select().from(threads).where(eq(threads.id, row.id));
      const t = await toThread(tc.ctx, fresh!);
      return {
        ok: true,
        delivered: true,
        reopened,
        resolved: t.resolved,
        link: `[${t.title}](#${t.id})`,
      };
    },
  }),
];
