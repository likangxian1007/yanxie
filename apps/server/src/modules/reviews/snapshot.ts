import { researchHistoryMarkdown } from '../research/history-markdown';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ActorRef, ReviewTargetKind } from '@srh/shared';
import type { AppContext } from '../../context';
import { documents, messages, outputs, reports, threads } from '../../db/schema';
import { memberRole, notFound } from '../collab-common';
import { accessOf } from '../sharing/access';
import { getDocumentMarkdown } from '../documents/service';
import { allEntities, getEntity, recordDetail } from '../research/service';
import { captureWorkspaceArchive, workspaceArchiveMarkdown } from '../research/workspace-archive';
import type {
  EvidenceExcerpt,
  ResearchFinding,
  ResearchSnapshot,
  ResearchSource,
} from '@srh/shared';

/**
 * 审阅快照：发起时目标内容的 markdown（像 PR 的 diff 基线）。
 * 目标不在本项目里时抛 404。
 */

/** 线程快照带最近几条消息 */
const THREAD_MESSAGES = 20;

/** 文档 → markdown（有人在线编辑时取内存里的最新状态） */
async function documentMarkdown(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  docId: string,
): Promise<string> {
  const [doc] = await ctx.db.db
    .select({ id: documents.id, space: documents.space, ownerUserId: documents.ownerUserId })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.id, docId)));
  if (!doc) notFound('要审阅的文档');
  // 个人空间的文档：只有能看到它的人能拿来送审（agent 一律看不到别人的个人文档）
  if (doc.space === 'personal') {
    const userId = actor.kind === 'user' ? actor.id : null;
    const role = userId ? await memberRole(ctx, projectId, userId) : null;
    const level = await accessOf(
      ctx,
      { kind: 'document', id: doc.id, projectId, space: 'personal', ownerUserId: doc.ownerUserId },
      { userId, role },
    );
    if (level === 'none') notFound('要审阅的文档');
  }
  return getDocumentMarkdown(ctx, projectId, docId);
}

/** 个人线程只有主人自己可以拿来审阅，别人一律当作不存在 */
function threadVisibleTo(
  actor: ActorRef,
  thread: { kind: string; ownerUserId: string | null },
): boolean {
  return thread.kind !== 'personal' || (actor.kind === 'user' && actor.id === thread.ownerUserId);
}

async function messageBody(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  messageId: string,
): Promise<string> {
  const [msg] = await ctx.db.db
    .select({ body: messages.body, threadKind: threads.kind, ownerUserId: threads.ownerUserId })
    .from(messages)
    .leftJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.id, messageId),
        isNull(messages.deletedAt),
        // 旁聊不进快照：快照会被 agent 和审阅人读到
        eq(messages.agentVisible, true),
      ),
    );
  // 时间线上的消息没有线程；在线程里的消息要对发起人可见（个人线程只有主人）
  const visible =
    msg &&
    (msg.threadKind === null ||
      threadVisibleTo(actor, { kind: msg.threadKind, ownerUserId: msg.ownerUserId }));
  if (!visible) notFound('要审阅的消息');
  return msg.body;
}

async function threadMarkdown(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  threadId: string,
): Promise<string> {
  const [thread] = await ctx.db.db
    .select()
    .from(threads)
    .where(and(eq(threads.projectId, projectId), eq(threads.id, threadId)));
  if (!thread || !threadVisibleTo(actor, thread)) notFound('要审阅的线程');
  const rows = await ctx.db.db
    .select({ authorName: messages.authorName, body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, thread.id),
        isNull(messages.deletedAt),
        // 旁聊不进快照：快照会被 agent 读到
        eq(messages.agentVisible, true),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(THREAD_MESSAGES);
  const out = [`# 线程：${thread.title}`, ''];
  if (thread.statusText.trim()) out.push('## 状态', '', thread.statusText.trim(), '');
  if (rows.length > 0) {
    out.push('## 最近消息', '');
    for (const m of rows.reverse()) out.push(`**${m.authorName}**：${m.body.trim()}`, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

type SnapshotProvider = (ctx: AppContext, projectId: string, targetId: string) => Promise<string>;
const providers = new Map<ReviewTargetKind, SnapshotProvider>();

/** 其他模块注册的审阅目标（改动提案由版本管理模块注册） */
export function registerSnapshotProvider(kind: ReviewTargetKind, fn: SnapshotProvider): void {
  providers.set(kind, fn);
}

export async function buildSnapshot(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  kind: ReviewTargetKind,
  targetId: string,
): Promise<string> {
  switch (kind) {
    case 'document':
      return documentMarkdown(ctx, actor, projectId, targetId);
    case 'experiment':
      return notFound('内容已移除：实验');
    case 'report': {
      const [report] = await ctx.db.db
        .select({ content: reports.content })
        .from(reports)
        .where(and(eq(reports.projectId, projectId), eq(reports.id, targetId)));
      if (!report) notFound('要审阅的组会汇报');
      return report.content;
    }
    case 'message':
    case 'plan': {
      if (targetId.startsWith('msg_')) return messageBody(ctx, actor, projectId, targetId);
      if (targetId.startsWith('doc_')) return documentMarkdown(ctx, actor, projectId, targetId);
      return notFound(kind === 'plan' ? '要审阅的计划' : '要审阅的消息');
    }
    case 'thread':
      return threadMarkdown(ctx, actor, projectId, targetId);
    case 'output': {
      const [output] = await ctx.db.db
        .select({ title: outputs.title, kind: outputs.kind, ref: outputs.ref })
        .from(outputs)
        .where(and(eq(outputs.projectId, projectId), eq(outputs.id, targetId)));
      if (!output) notFound('要审阅的产出');
      return `# ${output.title}\n\n类型：${output.kind}\n\n引用：${output.ref}\n`;
    }
    case 'proposal': {
      const fn = providers.get('proposal');
      if (!fn) return notFound('要审阅的改动提案');
      return fn(ctx, projectId, targetId);
    }
    case 'research_record': {
      const { record, template, sources, logs } = await recordDetail(ctx, projectId, targetId);
      const findings = (await allEntities<ResearchFinding>(ctx, projectId, 'finding')).filter(
        (finding) => finding.recordId === record.id,
      );
      const workspace = await captureWorkspaceArchive(ctx, projectId, targetId);
      return `# ${record.title}\n\n研究空间 ${record.id} · 修订 v${record.version}\n\n问题：${record.question}\n\n来源：${sources.map((source) => `${source.title} (#${source.id})`).join('、') || '无'}\n\n发现：${findings.map((finding) => `${finding.statement} (#${finding.id}，v${finding.version}，${finding.needsReview ? '待复核' : '已记录'})`).join('；') || '无'}\n\n${workspaceArchiveMarkdown(workspace)}\n\n${researchHistoryMarkdown({ record, template, logs })}`;
    }
    case 'research_finding': {
      const finding = await getEntity<ResearchFinding>(ctx, projectId, 'finding', targetId);
      const excerpts = await allEntities<EvidenceExcerpt>(ctx, projectId, 'excerpt');
      const sources = await allEntities<ResearchSource>(ctx, projectId, 'source');
      const snapshots = await allEntities<ResearchSnapshot>(ctx, projectId, 'snapshot');
      const byId = new Map(excerpts.map((excerpt) => [excerpt.id, excerpt]));
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      const evidence = (ids: string[]) =>
        ids
          .map((id) => {
            const e = byId.get(id);
            if (!e) return `${id}（摘录已不可访问）`;
            const source = sourceById.get(e.sourceId);
            const snapshot = snapshotById.get(e.snapshotId);
            return `- ${e.quote.slice(0, 1000)}\n  来源：${snapshot?.sourceMetadata.title ?? source?.title ?? e.sourceId} (#${e.sourceId})；快照 ${e.snapshotId} (来源v${snapshot?.sourceVersion ?? '未知'}，${snapshot?.coverage ?? '未知'}；${snapshot?.sourceMetadata.citation ?? '无书目信息'})；定位 ${JSON.stringify(e.locator)}；${e.verification}`;
          })
          .join('\n') || '无';
      return `# 研究发现 ${finding.id}\n\n研究空间：${finding.recordId}；修订 v${finding.version}\n\n${finding.statement}\n\n## 支持证据\n${evidence(finding.supportingExcerptIds)}\n\n## 反例证据\n${evidence(finding.counterExcerptIds)}\n\n## 背景证据\n${evidence(finding.contextExcerptIds)}\n\n局限：${finding.limitations}\n\n人工确认：${finding.humanConfirmed ? '是' : '否'}；待复核：${finding.needsReview ? '是' : '否'}\n`;
    }
  }
}
