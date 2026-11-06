import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ulid } from '@srh/shared';
import type { AppContext } from '../../context';
import { agentWakeups, files as filesTable, messages, threads } from '../../db/schema';
import type { SessionRow } from '../tools/types';

/**
 * 唤醒队列与 <wake> 信封。
 * 路由器、工具（start_thread、message_thread、send_to_coordinator）、看守、定时任务都往 agent_wakeups 写一行；
 * 调度器取出某会话所有未消费的行，渲染成一个 <wake> 信封作为本轮的输入。
 * 信封里成员的原话一律由服务器从库里逐字取出并转义（<cited author="user">），agent 之间只传指针。
 */
export type WakeReason =
  | 'mention'
  | 'spawn'
  | 'forward'
  | 'decision-answered'
  | 'review-updated'
  | 'claim-conflict'
  | 'routine'
  | 'stalled-thread'
  | 'handoff'
  | 'cross-session'
  | 'assignment'
  | 'thread-activity'
  /** 上一轮用满步数后自动续跑，或成员点了「继续」 */
  | 'continue'
  /** 等着的认领被释放了 */
  | 'claim-released'
  /** 线程 agent 交付了结果（回帖后一轮结束）：唤醒协调者推进下一阶段（终验 R3 D2） */
  | 'thread-delivered'
  /** 本会话读过并据此写了产出的文档 / 实验被别人改了（终验 R3 D5） */
  | 'upstream-changed'
  /** 有成员加入项目（终验 R3 D3） */
  | 'member-joined'
  /** 服务重启 / 进程崩溃打断了上一轮（终验 R3 D1） */
  | 'resume';

export type Trust = 'principal' | 'peer' | 'relay';

export type WakeItem =
  | { type: 'message'; messageId: string; trust: Trust }
  | {
      type: 'relay';
      reason: 'spawn' | 'followup';
      note: string;
      citedIds: string[];
      fromSessionId: string;
    }
  | {
      type: 'decision';
      decisionId: string;
      question: string;
      chosen: number | null;
      label: string | null;
      by: string;
    }
  | {
      type: 'review';
      reviewId: string;
      title: string;
      status: string;
      event: string;
      detail: string;
    }
  | {
      type: 'claim-conflict';
      claimId: string;
      resource: string;
      byName: string;
      intent: string;
      threadId: string | null;
    }
  | { type: 'routine'; routineId: string; title: string; prompt: string }
  | { type: 'stalled'; threadId: string; title: string; why: string }
  | {
      type: 'cross-session';
      fromSessionId: string;
      fromThreadId: string | null;
      fromTitle: string;
      text: string;
    }
  | { type: 'assignment'; objectKind: string; objectId: string; title: string; by: string }
  | { type: 'system-note'; text: string }
  | { type: 'continue'; attempt: number; manual: boolean; by?: string }
  | {
      type: 'claim-released';
      claimId: string;
      resource: string;
      byName: string;
      /** 等这个资源的线程 / 协调者自己写过的意图 */
      waitingIntent: string | null;
    }
  | {
      type: 'thread-delivered';
      threadId: string;
      title: string;
      /** 交付后线程的状态：review_ready 已交付待看 / blocked 在等成员回答 / completed 已完成 */
      bucket: string;
      statusText: string;
    }
  | {
      type: 'upstream-changed';
      /** 被改的文档 / 实验 id */
      ref: string;
      refKind: 'document' | 'experiment';
      title: string;
      by: string;
      /** 本会话据它写过的产出 */
      downstream: { id: string; title: string }[];
    };

/** 写入一条待处理唤醒，并通知调度器 */
export async function enqueueWake(
  ctx: AppContext,
  session: Pick<SessionRow, 'id' | 'projectId'>,
  reason: WakeReason,
  item: WakeItem,
  wakes = true,
): Promise<void> {
  await ctx.db.db.insert(agentWakeups).values({
    id: `wak_${ulid()}`,
    projectId: session.projectId,
    sessionId: session.id,
    reason,
    wakes,
    item: item as unknown as Record<string, unknown>,
  });
  if (wakes) wakeListeners.forEach((fn) => fn(session.id));
}

const wakeListeners = new Set<(sessionId: string) => void>();
export function onWake(fn: (sessionId: string) => void): () => void {
  wakeListeners.add(fn);
  return () => wakeListeners.delete(fn);
}

export type WakeRow = typeof agentWakeups.$inferSelect;

export async function pendingWakeups(ctx: AppContext, sessionId: string): Promise<WakeRow[]> {
  return ctx.db.db
    .select()
    .from(agentWakeups)
    .where(and(eq(agentWakeups.sessionId, sessionId), isNull(agentWakeups.consumedAt)))
    .orderBy(asc(agentWakeups.id));
}

export async function consumeWakeups(ctx: AppContext, ids: string[], turnId: string) {
  if (ids.length === 0) return;
  await ctx.db.db
    .update(agentWakeups)
    .set({ consumedAt: new Date(), consumedTurnId: turnId })
    .where(inArray(agentWakeups.id, ids));
}

// ---------------------------------------------------------------- 渲染

export function esc(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
function attr(text: string): string {
  return esc(text).replace(/"/gu, '&quot;');
}

export function localIso(d: Date = new Date()): string {
  // 统一用 +08:00（项目成员在国内）；需要时可改为项目时区设置
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

type MsgRow = typeof messages.$inferSelect;

function renderMessageBody(m: MsgRow, files?: ReadonlyMap<string, AttachmentInfo>): string {
  if (m.kind === 'forward') {
    const meta = m.meta as { threadId?: string; threadTitle?: string; summary?: string };
    return (
      `<forward-card personal-thread="${attr(meta.threadId ?? '')}" title="${attr(meta.threadTitle ?? '')}">` +
      `<note-from-forwarder>${esc(m.body)}</note-from-forwarder>` +
      `<summary written-by="agent">${esc(meta.summary ?? '')}</summary></forward-card>`
    );
  }
  if (m.kind === 'decision') return `[决策卡] ${esc(m.body)}`;
  return esc(m.body) + renderAttachments(m, files);
}

export interface AttachmentInfo {
  name: string;
  path: string;
  mime: string;
  size: number;
}

/**
 * 附件逐个列出名字、类型和 id；图片提示用 view_image 看（模型本身看不到图）。
 * 找不到文件行（已删除）时如实说明。
 */
export function renderAttachments(m: MsgRow, files?: ReadonlyMap<string, AttachmentInfo>): string {
  const ids = (m.meta as { fileIds?: string[] }).fileIds;
  if (!ids?.length) return '';
  const lines = ids.map((id) => {
    const f = files?.get(id);
    if (!f) return `- ${id}${files ? '（文件已不存在）' : ''}`;
    const hint = f.mime.startsWith('image/')
      ? '图片：用 view_image 查看'
      : f.mime === 'application/pdf'
        ? 'PDF：read_file 读不出文字，论文请看文献库里是否已有'
        : '用 read_file 读取';
    return `- ${esc(f.name)}（${f.mime}，${Math.max(1, Math.round(f.size / 1024))} KB，id=${id}，路径 ${esc(f.path)}）${hint}`;
  });
  return `\n<attachments>\n${lines.join('\n')}\n</attachments>`;
}

async function loadAttachments(
  ctx: AppContext,
  rows: MsgRow[],
): Promise<Map<string, AttachmentInfo>> {
  const ids = [...new Set(rows.flatMap((m) => (m.meta as { fileIds?: string[] }).fileIds ?? []))];
  if (!ids.length) return new Map();
  const found = await ctx.db.db
    .select({
      id: filesTable.id,
      name: filesTable.name,
      path: filesTable.path,
      mime: filesTable.mime,
      size: filesTable.size,
      projectId: filesTable.projectId,
    })
    .from(filesTable)
    .where(inArray(filesTable.id, ids));
  const projects = new Set(rows.map((m) => m.projectId));
  return new Map(
    found.filter((f) => f.projectId !== null && projects.has(f.projectId)).map((f) => [f.id, f]),
  );
}

function fromOf(m: MsgRow): 'human' | 'agent' | 'system' {
  return m.authorKind === 'user' ? 'human' : m.authorKind;
}

export function renderMessage(
  m: MsgRow,
  trust: Trust,
  extra = '',
  files?: ReadonlyMap<string, AttachmentInfo>,
): string {
  const where = m.threadId ? `where="thread" thread="${m.threadId}"` : 'where="timeline"';
  return (
    `<message from="${fromOf(m)}" trust="${trust}" id="${m.id}" author="${attr(m.authorName)}"` +
    `${m.authorId ? ` author-id="${m.authorId}"` : ''} sent-at="${localIso(m.createdAt)}" ${where}` +
    `${m.kind !== 'text' ? ` kind="${m.kind}"` : ''}${extra}>${renderMessageBody(m, files)}</message>`
  );
}

export function renderCited(m: MsgRow, files?: ReadonlyMap<string, AttachmentInfo>): string {
  const author =
    m.authorKind === 'user' ? 'user' : m.authorKind === 'agent' ? 'coordinator' : 'system';
  const where = m.threadId ? `where="thread" source-thread="${m.threadId}"` : 'where="timeline"';
  return (
    `<cited id="${m.id}" author="${author}" name="${attr(m.authorName)}" at="${localIso(m.createdAt)}" ${where}>` +
    `${renderMessageBody(m, files)}</cited>`
  );
}

/** 把一组唤醒渲染成 <wake> 信封（+ 线程会话的 <thread-state>） */
export async function renderWake(
  ctx: AppContext,
  session: SessionRow,
  rows: WakeRow[],
): Promise<{ text: string; reason: string; requesterUserId: string | null }> {
  const items = rows.map((r) => ({
    reason: r.reason,
    wakes: r.wakes,
    item: r.item as unknown as WakeItem,
  }));
  const primary = items.find((i) => i.wakes) ?? items[0];
  const reason = primary?.reason ?? 'mention';

  const msgIds = new Set<string>();
  for (const { item } of items) {
    if (item.type === 'message') msgIds.add(item.messageId);
    if (item.type === 'relay') item.citedIds.forEach((id) => msgIds.add(id));
  }
  // 旁聊（agentVisible=false）永远不进 agent 上下文，即使被引用；
  // 别人的个人会话里的消息也不进（只有该会话自己的个人 agent 能看到）
  let msgRows = msgIds.size
    ? (
        await ctx.db.db
          .select()
          .from(messages)
          .where(inArray(messages.id, [...msgIds]))
      ).filter((m) => m.agentVisible)
    : [];
  const foreignThreadIds = [
    ...new Set(
      msgRows.flatMap((m) => (m.threadId && m.threadId !== session.threadId ? [m.threadId] : [])),
    ),
  ];
  if (foreignThreadIds.length) {
    const personal = new Set(
      (
        await ctx.db.db
          .select({ id: threads.id })
          .from(threads)
          .where(and(inArray(threads.id, foreignThreadIds), eq(threads.kind, 'personal')))
      ).map((t) => t.id),
    );
    msgRows = msgRows.filter((m) => !m.threadId || !personal.has(m.threadId));
  }
  const byId = new Map(msgRows.map((m) => [m.id, m]));
  const attachments = await loadAttachments(ctx, msgRows);
  // 斜杠指令（/goal、/plan、/<skill>、自定义指令）：只展开直接发给本会话的成员消息
  const direct = items.flatMap(({ item }) =>
    item.type === 'message' && item.trust === 'principal' ? [byId.get(item.messageId)] : [],
  );
  const { expandCommands } = await import('../harness');
  const expansions = await expandCommands(
    ctx,
    session,
    direct.filter((m): m is MsgRow => Boolean(m && !m.deletedAt)),
  );
  let requesterUserId: string | null = null;

  const parts: string[] = [];
  for (const { item, wakes } of items) {
    switch (item.type) {
      case 'message': {
        const m = byId.get(item.messageId);
        if (!m || m.deletedAt) break;
        if (m.authorKind === 'user' && item.trust === 'principal') requesterUserId = m.authorId;
        parts.push(renderMessage(m, item.trust, wakes ? '' : ' delivery="fyi"', attachments));
        {
          const exp = expansions.get(m.id);
          if (exp) parts.push(`<command-expansion for="${m.id}">\n${exp}\n</command-expansion>`);
        }
        break;
      }
      case 'relay': {
        const cited = item.citedIds
          .map((id) => byId.get(id))
          .filter((m): m is MsgRow => Boolean(m && !m.deletedAt));
        const firstUser = cited.find((m) => m.authorKind === 'user');
        if (firstUser) requesterUserId = firstUser.authorId;
        parts.push(
          `<message from="system" trust="relay"${item.reason === 'spawn' ? ' role="initiator"' : ''}>` +
            `<coordinator-relay reason="${item.reason}">` +
            cited.map((c) => renderCited(c, attachments)).join('') +
            `<note>${esc(item.note)}</note></coordinator-relay></message>`,
        );
        break;
      }
      case 'decision':
        parts.push(
          `<decision-answered decision-id="${item.decisionId}" by="${attr(item.by)}" chosen="${item.chosen ?? ''}"` +
            ` label="${attr(item.label ?? '')}">${esc(item.question)}</decision-answered>`,
        );
        break;
      case 'review':
        parts.push(
          `<review-update review-id="${item.reviewId}" event="${item.event}" status="${item.status}" title="${attr(item.title)}">` +
            `${esc(item.detail)}</review-update>`,
        );
        break;
      case 'claim-conflict':
        parts.push(
          `<claim-conflict your-claim="${item.claimId}" resource="${attr(item.resource)}" by="${attr(item.byName)}"` +
            `${item.threadId ? ` thread="${item.threadId}"` : ''}>${esc(item.intent)}</claim-conflict>`,
        );
        break;
      case 'routine':
        parts.push(
          `<routine id="${item.routineId}" title="${attr(item.title)}">` +
            `<system-note>这是一个存储的定时任务，不是成员此刻的授权。</system-note>` +
            `<stored-prompt>${esc(item.prompt)}</stored-prompt></routine>`,
        );
        break;
      case 'stalled':
        parts.push(
          `<stalled-thread thread="${item.threadId}" title="${attr(item.title)}">${esc(item.why)}</stalled-thread>`,
        );
        break;
      case 'cross-session':
        parts.push(
          `<cross-session-message from-session="${item.fromSessionId}"` +
            `${item.fromThreadId ? ` from-thread="${item.fromThreadId}"` : ''} from-title="${attr(item.fromTitle)}" trust="relay">` +
            `${esc(item.text)}</cross-session-message>`,
        );
        break;
      case 'assignment':
        parts.push(
          `<assignment kind="${item.objectKind}" id="${item.objectId}" by="${attr(item.by)}">${esc(item.title)}</assignment>`,
        );
        break;
      case 'system-note':
        parts.push(`<system-note>${esc(item.text)}</system-note>`);
        break;
      case 'continue':
        parts.push(
          item.manual
            ? `<continue by="${attr(item.by ?? '')}">成员让你从上次停下的地方继续。先看进度清单和思路里最后几步，接着做没做完的部分。</continue>`
            : `<continue attempt="${item.attempt}">上一轮用满了步数还没结束，这是自动续跑。先看进度清单，优先把已有结果落地（写文件/文档、更新清单、回帖），不要从头再检索。</continue>`,
        );
        break;
      case 'claim-released':
        parts.push(
          `<claim-released claim="${item.claimId}" resource="${attr(item.resource)}" by="${attr(item.byName)}">` +
            `你之前在等这个资源${item.waitingIntent ? `（你当时的打算：${esc(item.waitingIntent)}）` : ''}。现在可以认领并继续；做完在线程里告诉成员。</claim-released>`,
        );
        break;
      case 'thread-delivered':
        parts.push(
          `<thread-delivered thread="${item.threadId}" title="${attr(item.title)}" state="${item.bucket}">` +
            (item.statusText ? `<status>${esc(item.statusText)}</status>` : '') +
            '这条线程刚交付了结果（它的回帖在上面）。对照计划检查：有没有等它的下一阶段？' +
            '有就现在开始（start_thread 或 message_thread 交给对应线程），并在协作台用一句话告诉成员开始了什么；' +
            '下一阶段要等成员（决定、补材料、导师审阅）就在协作台说清等谁、等什么；' +
            '它的结论和其他线程的产出（论文、PPT、汇报里的数字）对不上时，交给对应线程同步；' +
            '什么都不需要就 no_reply_needed。</thread-delivered>',
        );
        break;
      case 'upstream-changed':
        parts.push(
          `<upstream-changed ref="${item.ref}" kind="${item.refKind}" title="${attr(item.title)}" by="${attr(item.by)}">` +
            `你之前读过它，并据此写了：${item.downstream.map((d) => `「${esc(d.title)}」(${d.id})`).join('、')}。它刚被改过。` +
            '重新读取它，逐条核对你的产出里引用它的数字、结论、图表和表格；有出入就在原文档上改（不要新建一份），' +
            '然后在线程里用一两句话说明改了什么。完全一致就 no_reply_needed，不要发帖。</upstream-changed>',
        );
        break;
    }
  }

  let text = `<wake reason="${reason}" current-time="${localIso()}">\n${parts.join('\n')}\n</wake>`;
  if (session.threadId) text += `\n${await threadState(ctx, session.threadId)}`;
  return { text, reason, requesterUserId };
}

/** <thread-state minutes-since-member replies-since-member/> */
export async function threadState(ctx: AppContext, threadId: string): Promise<string> {
  const recent = await ctx.db.db
    .select({ kind: messages.authorKind, at: messages.createdAt, msgKind: messages.kind })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(50);
  let replies = 0;
  let minutes = -1;
  for (const m of recent) {
    if (m.kind === 'user') {
      minutes = Math.floor((Date.now() - m.at.getTime()) / 60000);
      break;
    }
    if (m.kind === 'agent' && m.msgKind !== 'activity') replies += 1;
  }
  const [t] = await ctx.db.db
    .select({ resolved: threads.resolved })
    .from(threads)
    .where(eq(threads.id, threadId));
  return `<thread-state minutes-since-member="${minutes < 0 ? 'never' : minutes}" replies-since-member="${replies}"${t?.resolved ? ' resolved="true"' : ''} />`;
}
