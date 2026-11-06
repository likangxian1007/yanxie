import { and, asc, between, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type {
  EvidenceExcerpt,
  ReportStats,
  ResearchFinding,
  ResearchRecord,
  ResearchSnapshot,
  ResearchSource,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  agentSessions,
  decisions,
  documents,
  memoryFiles,
  messages,
  projectMembers,
  projects,
  reviewComments,
  reviewParticipants,
  reviews,
  researchEntities,
  researchWorkspaceItems,
  researchRuns,
  threads,
  todos,
  users,
} from '../../db/schema';
import { notFound } from '../collab-common';
import { shortTime, ymd } from './time';

/**
 * 组会汇报的上下文收集（纯读库）。
 *
 * 输出给 LLM 的是分节 Markdown（每个对象带 id，方便模型按 report.md 的规则写 `[标题](#id)` 链接），
 * 总长控制在 CONTEXT_BUDGET 字符内；超了按优先级截断：实验 > 审阅 > 线程 > 消息 > 其他。
 * 只收项目线程与时间线上 agentVisible 的消息：旁聊和个人工作区的内容永远不进汇报。
 */
export const CONTEXT_BUDGET = 60_000;
export const MAX_MESSAGES = 200;
const MESSAGE_CHARS = 400;
const DOC_EXCERPT_CHARS = 300;
const MEMORY_CHARS = 3000;
const COMMENTS_PER_REVIEW = 3;

export interface ReportContext {
  text: string;
  stats: ReportStats;
  projectName: string;
}

const BUCKET_ZH: Record<string, string> = {
  idle: '空闲',
  working: '进行中',
  blocked: '等人处理',
  review_ready: '待审阅',
  completed: '已完成',
  failed: '出错',
};

const REVIEW_STATUS_ZH: Record<string, string> = {
  open: '审阅中',
  approved: '已通过',
  changes_requested: '要求修改',
  closed: '已关闭',
};

const VERDICT_ZH: Record<string, string> = {
  pending: '未表态',
  lgtm: 'LGTM',
  changes_requested: '要求修改',
  commented: '已评论',
};

/** 截断到 n 个字符，超出时加省略号。 */
export function clip(text: string, n: number): string {
  const s = text.trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 压成一行（消息、日志摘录用）。 */
function oneLine(text: string, n: number): string {
  return clip(text.replace(/\s*\n+\s*/gu, ' / '), n);
}

function indent(text: string, prefix = '  > '): string {
  return text
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

interface Section {
  title: string;
  entries: string[];
  /** 截断时保留开头还是结尾（消息保留最近的） */
  keep: 'head' | 'tail';
  empty: string;
}

function renderSection(section: Section, budget: number): string {
  const head = `## ${section.title}\n\n`;
  if (section.entries.length === 0) return `${head}${section.empty}\n`;
  const ordered = section.keep === 'tail' ? [...section.entries].reverse() : section.entries;
  const picked: string[] = [];
  let used = head.length + 40;
  for (const entry of ordered) {
    if (used + entry.length + 1 > budget) {
      // 一条都放不下时，截断第一条
      if (picked.length === 0 && budget - used > 200) picked.push(clip(entry, budget - used - 1));
      break;
    }
    picked.push(entry);
    used += entry.length + 1;
  }
  const omitted = section.entries.length - picked.length;
  if (section.keep === 'tail') picked.reverse();
  const note = omitted > 0 ? `\n（另有 ${omitted} 条因篇幅省略）` : '';
  return `${head}${picked.join('\n')}${note}\n`;
}

export async function collectReportContext(
  ctx: AppContext,
  projectId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportContext> {
  const db = ctx.db.db;
  const inPeriod = between;
  const [start, end] = [periodStart, periodEnd];

  const [project] = await db
    .select({ name: projects.name, instructions: projects.instructions })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) notFound('项目');

  // 成员与姓名
  const memberRows = await db
    .select({ id: users.id, name: users.name, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.joinedAt));
  const names = new Map(memberRows.map((m) => [m.id, m.name]));
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return '无';
    if (id === 'agent:coordinator') return '协调者';
    if (id.startsWith('agent:')) return `线程 agent（${id.slice(6)}）`;
    return names.get(id) ?? id;
  };

  // 研究空间与证据摘要：内容、版本、来源和发现均带原始 ID，供汇报引用。
  const researchRows = await db
    .select()
    .from(researchEntities)
    .where(
      and(
        eq(researchEntities.projectId, projectId),
        inArray(researchEntities.kind, [
          'record',
          'log',
          'source',
          'snapshot',
          'excerpt',
          'finding',
        ]),
      ),
    );
  const allResearchRecords = researchRows
    .filter((r) => r.kind === 'record')
    .map((r) => r.data as ResearchRecord);
  const researchSources = researchRows
    .filter((r) => r.kind === 'source')
    .map((r) => r.data as ResearchSource);
  const researchSnapshots = researchRows
    .filter((r) => r.kind === 'snapshot')
    .map((r) => r.data as ResearchSnapshot);
  const researchExcerpts = researchRows
    .filter((r) => r.kind === 'excerpt')
    .map((r) => r.data as EvidenceExcerpt);
  const researchFindings = researchRows
    .filter((r) => r.kind === 'finding')
    .map((r) => r.data as ResearchFinding);
  const changed = researchRows.filter((r) => r.createdAt <= end && r.updatedAt >= start);
  const workspaceItems = await db
    .select()
    .from(researchWorkspaceItems)
    .where(
      and(
        eq(researchWorkspaceItems.projectId, projectId),
        lte(researchWorkspaceItems.createdAt, end),
        inPeriod(researchWorkspaceItems.updatedAt, start, end),
      ),
    )
    .orderBy(desc(researchWorkspaceItems.updatedAt))
    .limit(200);
  const workspaceRuns = await db
    .select()
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.projectId, projectId),
        lte(researchRuns.createdAt, end),
        inPeriod(researchRuns.updatedAt, start, end),
      ),
    )
    .orderBy(desc(researchRuns.updatedAt))
    .limit(100);
  const changedRecordIds = new Set([
    ...changed.map((r) => r.recordId).filter((id): id is string => !!id),
    ...workspaceItems.map((item) => item.recordId),
    ...workspaceRuns.map((run) => run.recordId),
  ]);
  const changedSourceIds = new Set(changed.filter((r) => r.kind === 'source').map((r) => r.id));
  for (const snapshot of researchSnapshots)
    if (new Date(snapshot.createdAt) >= start && new Date(snapshot.createdAt) <= end)
      changedSourceIds.add(snapshot.sourceId);
  const researchRecords = allResearchRecords.filter(
    (record) =>
      changedRecordIds.has(record.id) || record.sourceIds.some((id) => changedSourceIds.has(id)),
  );
  const researchEntries = researchRecords.map((record) => {
    const sources = researchSources.filter((s) => record.sourceIds.includes(s.id));
    const findings = researchFindings.filter((f) => f.recordId === record.id);
    const work = workspaceItems
      .filter((item) => item.recordId === record.id)
      .map(
        (item) =>
          `[${item.title}](/p/${projectId}/research/${record.id}?item=${item.id})（${item.id} v${item.version}；${item.kind}；${item.archivedAt ? '已归档；' : ''}作者 ${item.createdBy.kind}:${item.createdBy.name}；更新者 ${item.updatedBy.kind}:${item.updatedBy.name}）：${oneLine(item.body, 400)}`,
      );
    const runs = workspaceRuns
      .filter((run) => run.recordId === record.id)
      .map(
        ({ data: run }) =>
          `${run.id}：${run.status}；输入 ${run.inputSnapshots.map((input) => `${input.item.id} v${input.item.version} sha256:${input.hash}`).join('、')}；产物 ${run.steps.flatMap((step) => step.attempts.flatMap((attempt) => attempt.outputs.map((output) => `${output.itemId} v${output.version}（${output.origin}）`))).join('、') || '尚无产物'}；人工检查 ${run.steps.flatMap((step) => (step.confirmedBy ? [`${step.definition.title}：${step.confirmedBy.name}`] : [])).join('、') || '尚无人工检查'}`,
      );
    return `- [${record.title}](#${record.id})｜${record.status}｜修订 v${record.version}\n  问题：${oneLine(record.question, 300)}\n  工作内容：${work.join('；') || '本期无条目变化'}\n  实际运行：${runs.join('；') || '本期无运行'}\n  来源：${
      sources
        .map(
          (s) =>
            `${s.title} (#${s.id})；快照 ${
              researchSnapshots
                .filter((snap) => snap.sourceId === s.id)
                .map(
                  (snap) =>
                    `${snap.id}/${snap.coverage}/来源v${snap.sourceVersion} ${oneLine(snap.sourceMetadata.title, 80)} ${oneLine(snap.sourceMetadata.citation, 120) || '无书目信息'}`,
                )
                .join('、') || '无'
            }`,
        )
        .join('、') || '无'
    }\n  发现：${findings.map((f) => `${oneLine(f.statement, 200)} (#${f.id}，${f.needsReview ? '待复核' : '已记录'}，人工确认 ${f.humanConfirmed ? '是' : '否'}，作者 ${f.createdBy.kind}:${f.createdBy.name}，更新者 ${f.updatedBy.kind}:${f.updatedBy.name}；支持 ${f.supportingExcerptIds.join('、') || '无'}；反例 ${f.counterExcerptIds.join('、') || '无'}；局限 ${oneLine(f.limitations, 120) || '未写'})`).join('；') || '无'}\n  摘录定位：${
      researchExcerpts
        .filter((e) => e.recordId === record.id)
        .map((e) => `${e.id}→${e.snapshotId} ${JSON.stringify(e.locator)} ${e.verification}`)
        .join('；') || '无'
    }\n  历史步骤报告：${
      Object.entries(record.stepReports)
        .map(
          ([id, report]) =>
            `${id}:${report.done ? '完成' : '未完成'} / ${report.origin} / ${report.reportedBy.kind}:${report.reportedBy.name} / ${report.verification}`,
        )
        .join('；') || '无'
    }`;
  });

  // ---------------------------------------------------------------- 线程
  const threadRows = await db
    .select({
      id: threads.id,
      title: threads.title,
      label: threads.label,
      statusBucket: threads.statusBucket,
      statusText: threads.statusText,
      resolved: threads.resolved,
      ownerUserId: threads.ownerUserId,
      createdAt: threads.createdAt,
      lastActivityAt: threads.lastActivityAt,
      workingFor: agentSessions.workingForUserId,
    })
    .from(threads)
    .leftJoin(agentSessions, eq(agentSessions.threadId, threads.id))
    .where(
      and(
        eq(threads.projectId, projectId),
        eq(threads.kind, 'project'),
        or(inPeriod(threads.createdAt, start, end), inPeriod(threads.lastActivityAt, start, end)),
      ),
    )
    .orderBy(desc(threads.lastActivityAt))
    .limit(100);
  // 一个线程可能有多个 agent 会话（left join 会重复），按线程去重
  const seenThreads = new Set<string>();
  const uniqueThreads = threadRows.filter((t) => !seenThreads.has(t.id) && !!seenThreads.add(t.id));
  const threadEntries = uniqueThreads.map((t) => {
    const lines = [
      `### ${t.title}（#${t.id}）`,
      `- 标签：${t.label ?? '无'}；状态：${BUCKET_ZH[t.statusBucket] ?? t.statusBucket}（${t.statusBucket}）；已解决：${t.resolved ? '是' : '否'}`,
      `- 发起人：${nameOf(t.ownerUserId)}；为谁工作：${nameOf(t.workingFor ?? t.ownerUserId)}；创建：${shortTime(t.createdAt)}；最近活动：${shortTime(t.lastActivityAt)}`,
    ];
    if (t.statusText.trim()) lines.push('- 最新进度清单：', indent(clip(t.statusText, 1500)));
    return lines.join('\n');
  });

  // ---------------------------------------------------------------- 时间线与线程消息
  const messageRows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      authorKind: messages.authorKind,
      authorName: messages.authorName,
      kind: messages.kind,
      body: messages.body,
      createdAt: messages.createdAt,
      threadTitle: threads.title,
    })
    .from(messages)
    .leftJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.agentVisible, true),
        isNull(messages.deletedAt),
        inPeriod(messages.createdAt, start, end),
        // 个人工作区的消息是私有的，不进汇报
        or(isNull(messages.threadId), eq(threads.kind, 'project')),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MAX_MESSAGES);
  messageRows.reverse();
  const messageEntries = messageRows
    .filter((m) => m.body.trim())
    .map((m) => {
      const where = m.threadId ? `线程「${m.threadTitle ?? m.threadId}」` : '时间线';
      const who =
        m.authorKind === 'agent'
          ? `${m.authorName}（agent）`
          : m.authorKind === 'system'
            ? `${m.authorName}（系统）`
            : m.authorName;
      const kind = m.kind === 'text' ? '' : `[${m.kind}] `;
      return `- ${shortTime(m.createdAt)} ${where} ${who}（#${m.id}）：${kind}${oneLine(m.body, MESSAGE_CHARS)}`;
    });

  // ---------------------------------------------------------------- 审阅
  const reviewRows = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.projectId, projectId),
        or(inPeriod(reviews.createdAt, start, end), inPeriod(reviews.updatedAt, start, end)),
      ),
    )
    .orderBy(desc(reviews.updatedAt))
    .limit(60);
  const reviewIds = reviewRows.map((r) => r.id);
  const participantRows =
    reviewIds.length > 0
      ? await db
          .select({
            reviewId: reviewParticipants.reviewId,
            userId: reviewParticipants.userId,
            verdict: reviewParticipants.verdict,
            name: users.name,
          })
          .from(reviewParticipants)
          .innerJoin(users, eq(users.id, reviewParticipants.userId))
          .where(inArray(reviewParticipants.reviewId, reviewIds))
      : [];
  const commentRows =
    reviewIds.length > 0
      ? await db
          .select()
          .from(reviewComments)
          .where(inArray(reviewComments.reviewId, reviewIds))
          .orderBy(desc(reviewComments.createdAt), desc(reviewComments.id))
          .limit(1000)
      : [];
  const reviewEntries = reviewRows.map((r) => {
    const verdicts = participantRows
      .filter((p) => p.reviewId === r.id)
      .map((p) => `${p.name}：${VERDICT_ZH[p.verdict] ?? p.verdict}`);
    const comments = commentRows
      .filter((c) => c.reviewId === r.id)
      .slice(0, COMMENTS_PER_REVIEW)
      .reverse();
    const lines = [
      `### ${r.title}（#${r.id}）`,
      `- 目标：${r.targetKind} #${r.targetId}；状态：${REVIEW_STATUS_ZH[r.status] ?? r.status}（${r.status}）；发起人：${r.requestedBy.name}`,
      `- 审阅人结论：${verdicts.length > 0 ? verdicts.join('；') : '（无）'}`,
    ];
    if (r.summary.trim()) lines.push(`- 说明：${oneLine(r.summary, 400)}`);
    if (comments.length > 0) {
      lines.push('- 最近评论：');
      for (const c of comments) {
        const verdict = c.verdict ? `［${VERDICT_ZH[c.verdict] ?? c.verdict}］` : '';
        const resolved = c.resolved ? '（已解决）' : '';
        lines.push(`  - ${c.author.name}${verdict}${resolved}：${oneLine(c.body, 300)}`);
      }
    }
    return lines.join('\n');
  });

  // ---------------------------------------------------------------- 决策卡（未回答的 + 本期的）
  const decisionRows = await db
    .select({
      id: decisions.id,
      threadId: decisions.threadId,
      question: decisions.question,
      options: decisions.options,
      state: decisions.state,
      chosen: decisions.chosen,
      threadTitle: threads.title,
    })
    .from(decisions)
    .leftJoin(threads, eq(threads.id, decisions.threadId))
    .where(
      and(
        eq(decisions.projectId, projectId),
        or(isNull(decisions.threadId), eq(threads.kind, 'project')),
        or(
          inPeriod(decisions.createdAt, start, end),
          and(eq(decisions.state, 'open'), lte(decisions.createdAt, end)),
        ),
      ),
    )
    .orderBy(desc(decisions.createdAt))
    .limit(30);
  const decisionEntries = decisionRows.map((d) => {
    const options = d.options.map((o, i) => `${i + 1}. ${o.label}`).join('；');
    const chosen =
      d.state === 'answered' && d.chosen !== null
        ? `；已选：${d.options[d.chosen]?.label ?? d.chosen}`
        : '';
    const where = d.threadId ? `线程「${d.threadTitle ?? d.threadId}」` : '时间线';
    return `- ${where}（#${d.id}）：${oneLine(d.question, 300)}（状态 ${d.state}；选项：${options}${chosen}）`;
  });

  // ---------------------------------------------------------------- 待办（项目共享）
  const todoRows = await db
    .select()
    .from(todos)
    .where(
      and(
        eq(todos.projectId, projectId),
        isNull(todos.ownerUserId),
        or(inPeriod(todos.createdAt, start, end), inPeriod(todos.completedAt, start, end)),
      ),
    )
    .orderBy(asc(todos.done), desc(todos.createdAt))
    .limit(100);
  const todoEntries = todoRows.map((t) => {
    const due = t.dueAt ? `；截止 ${ymd(t.dueAt)}` : '';
    const done = t.done ? `已完成${t.completedAt ? `（${ymd(t.completedAt)}）` : ''}` : '未完成';
    return `- [${t.done ? 'x' : ' '}] ${oneLine(t.title, 200)}（#${t.id}；负责人：${nameOf(t.assigneeId)}；${done}${due}）`;
  });

  // ---------------------------------------------------------------- 文档
  const documentRows = await db
    .select({
      id: documents.id,
      kind: documents.kind,
      title: documents.title,
      contentText: documents.contentText,
      updatedBy: documents.updatedBy,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.projectId, projectId),
        // 组会汇报面向全组：只取团队空间的文档，个人空间不进汇报
        eq(documents.space, 'team'),
        isNull(documents.archivedAt),
        inPeriod(documents.updatedAt, start, end),
      ),
    )
    .orderBy(desc(documents.updatedAt))
    .limit(50);
  const documentEntries = documentRows.map((d) => {
    const by = (d.updatedBy as { name?: string } | null)?.name;
    const excerpt = d.contentText.trim() ? oneLine(d.contentText, DOC_EXCERPT_CHARS) : '（空）';
    return `- ${d.title}（#${d.id}，${d.kind}；最近修改 ${shortTime(d.updatedAt)}${by ? ` by ${by}` : ''}）：${excerpt}`;
  });

  // ---------------------------------------------------------------- 项目记忆
  const [memory] = await db
    .select({ content: memoryFiles.content })
    .from(memoryFiles)
    .where(and(eq(memoryFiles.projectId, projectId), eq(memoryFiles.path, 'MEMORY.md')));

  // ---------------------------------------------------------------- 组装
  const header = [
    `# 项目：${project.name}`,
    '',
    `汇报时间段：${ymd(start)} 至 ${ymd(end)}`,
    `成员：${memberRows.length > 0 ? memberRows.map((m) => `${m.name}（${m.role}）`).join('、') : '（无）'}`,
    `项目说明：${project.instructions.trim() ? clip(project.instructions, 2000) : '（无）'}`,
    '',
  ].join('\n');

  const sections: Record<string, Section> = {
    memory: {
      title: '项目记忆（MEMORY.md 摘录）',
      entries: memory?.content.trim() ? [clip(memory.content, MEMORY_CHARS)] : [],
      keep: 'head',
      empty: '（无）',
    },
    threads: {
      title: `线程（本期有动静的 ${threadEntries.length} 个）`,
      entries: threadEntries,
      keep: 'head',
      empty: '本期没有线程活动。',
    },
    messages: {
      title: `时间线与线程消息（${messageEntries.length} 条，按时间顺序，不含旁聊）`,
      entries: messageEntries,
      keep: 'tail',
      empty: '本期没有消息。',
    },
    research: {
      title: `研究空间（本期有变化的 ${researchEntries.length} 个）`,
      entries: researchEntries,
      keep: 'head',
      empty: '本期没有研究空间变化。',
    },
    reviews: {
      title: `审阅（${reviewEntries.length} 个）`,
      entries: reviewEntries,
      keep: 'head',
      empty: '本期没有审阅。',
    },
    decisions: {
      title: `决策卡（${decisionEntries.length} 个）`,
      entries: decisionEntries,
      keep: 'head',
      empty: '（无）',
    },
    todos: {
      title: `项目待办（本期新建或完成的 ${todoEntries.length} 条）`,
      entries: todoEntries,
      keep: 'head',
      empty: '（无）',
    },
    documents: {
      title: `文档（本期修改过的 ${documentEntries.length} 篇）`,
      entries: documentEntries,
      keep: 'head',
      empty: '（无）',
    },
  };

  // 预算分配顺序（优先级），与展示顺序无关
  const priority = [
    'research',
    'reviews',
    'threads',
    'messages',
    'decisions',
    'todos',
    'documents',
    'memory',
  ];
  const display = [
    'memory',
    'threads',
    'research',
    'reviews',
    'decisions',
    'todos',
    'documents',
    'messages',
  ];
  let remaining = CONTEXT_BUDGET - header.length;
  const rendered = new Map<string, string>();
  for (const key of priority) {
    const section = sections[key];
    if (!section) continue;
    const text = renderSection(section, Math.max(remaining, 0));
    rendered.set(key, text);
    remaining -= text.length + 1;
  }
  const text = [header, ...display.map((k) => rendered.get(k) ?? '')]
    .join('\n')
    .replace(/<\/?project-records[^>]*>/giu, '');

  return {
    text,
    stats: {
      threads: uniqueThreads.length,
      messages: messageEntries.length,
      experiments: 0,
      researchRecords: researchRecords.length,
      reviews: reviewRows.length,
      todos: todoRows.length,
      documents: documentRows.length,
    },
    projectName: project.name,
  };
}
