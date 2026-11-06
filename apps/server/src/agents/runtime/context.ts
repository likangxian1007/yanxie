import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { BASIS_CLAIM_TYPE_LABEL } from '@srh/shared';
import type { AppContext } from '../../context';
import {
  memoryFiles,
  personalMemory,
  plans,
  projectMembers,
  teamBasis,
  users,
} from '../../db/schema';
import type { ProjectRow, SessionRow, ThreadRow } from '../tools/types';
import { clipToTokens, contextBudget, estimateTokens, type ContextBudget } from './budget';
import { esc, localIso } from './wake';

/**
 * system prompt 组装（prompts/README.md §2）：
 *   shared-protocol.md → <角色>.md（模板变量）→ <session-context nonce> → <memory> → 压缩摘要
 * 1、2 两块字节稳定以命中 DeepSeek 的前缀缓存：本轮工具清单和当前时间这类每轮会变的内容
 * 只放在 session-context 里。<memory>、摘要各有 token 预算（budget.ts）。
 */
export function promptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PROMPTS_DIR,
    resolve(here, '../../../prompts'), // src/agents/runtime → apps/server/prompts
    resolve(here, '../prompts'), // dist → apps/server/prompts（Docker 里 /app/prompts）
    resolve(process.cwd(), 'prompts'),
    resolve(process.cwd(), 'apps/server/prompts'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(resolve(p, 'shared-protocol.md')));
  if (!found) throw new Error(`找不到 prompts 目录，已尝试：${candidates.join(', ')}`);
  return found;
}

const cache = new Map<string, string>();
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined && process.env.NODE_ENV === 'production') return hit;
  const raw = readFileSync(resolve(promptsDir(), name), 'utf8');
  // 去掉文件头部给维护者看的 HTML 注释
  const text = raw.replace(/^\s*<!--[\s\S]*?-->\s*/u, '');
  cache.set(name, text);
  return text;
}

export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gu, (_, key: string) => vars[key] ?? '');
}

const ROLE_FILE = {
  coordinator: 'coordinator.md',
  thread: 'thread.md',
  personal: 'personal.md',
} as const;
const MEMORY_FILE_BYTES = 4096;
const MEMORY_EXTRA_FILES = 6;

export interface PromptInput {
  session: SessionRow;
  project: ProjectRow;
  thread: ThreadRow | null;
  toolNames: string[];
  requesterUserId: string | null;
  budget?: ContextBudget;
}

export async function buildSystemPrompt(ctx: AppContext, input: PromptInput): Promise<string> {
  const { session, project, thread } = input;
  const members = await ctx.db.db
    .select({ id: users.id, name: users.name, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, project.id))
    .orderBy(asc(projectMembers.joinedAt));
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? '';
  const workingFor = nameOf(session.workingForUserId);
  const owner = thread?.kind === 'personal' ? nameOf(thread.ownerUserId) : '';

  const vars = {
    project_name: esc(project.name),
    tool_list: input.toolNames.join(', '),
    thread_title: esc(thread?.title ?? ''),
    working_for: esc(workingFor || '团队'),
    owner_name: esc(owner),
    now: '（见 session-context）',
  };
  const shared = fillTemplate(loadPrompt('shared-protocol.md'), vars);
  const role = fillTemplate(loadPrompt(ROLE_FILE[session.role]), vars);

  const nonce = randomBytes(8).toString('hex');
  const lines = [
    `<session-context nonce="${nonce}">`,
    `项目：${esc(project.name)}（id ${project.id}）`,
    `项目说明：${esc(project.description || '（无）')}`,
    `项目指令：${esc(project.instructions || '（无）')}`,
    '成员：',
    ...members.map((m) => `- ${esc(m.name)}（${m.role}，id ${m.id}）`),
    `本次请求人：${esc(nameOf(input.requesterUserId) || '（无）')}`,
  ];
  if (thread?.kind === 'project') {
    lines.push(
      `当前线程：${esc(thread.title)}（id ${thread.id}，为 ${esc(workingFor || '团队')}）`,
    );
  }
  if (thread?.kind === 'personal') {
    lines.push(`当前个人会话：${esc(thread.title)}（id ${thread.id}）`, `主人：${esc(owner)}`);
  }
  // 计划卡上的进度清单：成员可以直接在计划卡上改，以这里的最新版本为准
  if (thread?.statusText.trim()) {
    lines.push(
      '当前计划（进度清单最新版本；成员可能在计划卡上直接改过，按它继续推进，update_status 时在它的基础上改）：',
      esc(thread.statusText.trim()),
    );
  }
  lines.push(
    `你的会话 id：${session.id}（你写的消息、认领以这个 id 作为作者）`,
    `链接写法：线程 [标题](#thr_…)，消息 [短标题](#msg_…)，文档 [标题](#doc_…)，实验 [标题](#exp_…)`,
    `本轮可用的工具：${input.toolNames.join(', ')}`,
    `当前时间：${localIso()}`,
    `</session-context nonce="${nonce}">`,
  );

  const actorUserId =
    input.requesterUserId ??
    (thread?.kind === 'personal' ? thread.ownerUserId : null) ??
    session.workingForUserId ??
    undefined;
  const memory = await renderMemory(ctx, project.id, {
    budgetTokens: (input.budget ?? contextBudget(ctx.config)).memory,
    ...(actorUserId ? { actorUserId } : {}),
  });
  const parts = [shared, role, lines.join('\n'), memory];
  if (session.contextSummary) {
    parts.push(
      `<context-summary>\n以下是你此前对话的压缩摘要（有损，承重事实请重新读取验证）：\n${clipToTokens(esc(session.contextSummary), (input.budget ?? contextBudget(ctx.config)).summary)}\n</context-summary>`,
    );
  }
  return parts.join('\n\n');
}

export interface RenderMemoryOptions {
  /** <memory> 整块的 token 上限（默认 contextBudget().memory） */
  budgetTokens?: number;
  /**
   * 本轮代表的成员：触发本次唤醒的成员，其次个人会话主人、线程为之工作的成员；没有就是 undefined。
   * 只用来挑这位成员自己的个人工作记忆；没有时不注入任何人的个人记忆。
   */
  actorUserId?: string;
}

/** <memory> 里方案相关各段占整块预算的上限比例（只按实际用量扣减，剩下的给项目记忆文件） */
const PLAN_SHARE = { official: 0.3, basis: 0.2, personal: 0.1, exploration: 0.05 } as const;
/** 单条团队依据 / 个人记忆正文的上限（token） */
const PLAN_ITEM_TOKENS = 300;
/** 单个探索副本说明的上限（token） */
const EXPLORATION_ITEM_TOKENS = 80;
/** 收尾行（「另有 N 个记忆文件未展开」与 </memory>）预留的 token */
const MEMORY_TAIL_TOKENS = 40;
export const EXPLORATION_LABEL = '探索中，非正式结论';
const PLANS_PAGE = '「方案与依据」页面';

/**
 * 按条放进一段，放不下就停，最后附「另有 N 条未展开」。
 * 返回渲染出的行（没有条目时为空数组）与估算 token。
 */
function section(head: string[], items: string[][], cap: number, more: (n: number) => string) {
  if (items.length === 0) return { lines: [] as string[], tokens: 0 };
  const lines = [...head];
  let tokens = estimateTokens(lines.join('\n'));
  const tail = estimateTokens(more(items.length));
  let shown = 0;
  for (const item of items) {
    const cost = estimateTokens(item.join('\n')) + 1;
    if (tokens + cost + tail > cap) break;
    lines.push(...item);
    tokens += cost;
    shown += 1;
  }
  // 一条都放不下就整段不出现，只留一句提示（标题本身也要占预算）
  if (shown === 0) {
    const only = [more(items.length)];
    return { lines: only, tokens: estimateTokens(only.join('\n')) };
  }
  if (shown < items.length) {
    lines.push(more(items.length - shown));
    tokens += tail;
  }
  return { lines, tokens };
}

/** 方案与依据（plans 模块）渲染进 <memory> 的几段；整块预算由调用方给 */
async function renderPlans(
  ctx: AppContext,
  projectId: string,
  budget: number,
  actorUserId: string | undefined,
) {
  const db = ctx.db.db;
  const blocks: string[][] = [];
  let used = 0;

  // ---- 正式方案：版本号 + 要点；超出就截断，提示到页面看全文
  const [official] = await db
    .select()
    .from(plans)
    .where(
      and(eq(plans.projectId, projectId), eq(plans.kind, 'official'), eq(plans.status, 'active')),
    )
    .limit(1);
  if (official) {
    const cap = Math.floor(budget * PLAN_SHARE.official);
    const head = [
      `\n## 正式方案：${esc(official.title)}（v${official.version}，团队当前采用的方案）`,
      ...(official.summary.trim()
        ? [`说明：${clipToTokens(esc(official.summary.trim()), Math.floor(cap / 4), '…')}`]
        : []),
    ];
    const note = `\n…（正式方案 v${official.version} 超出记忆预算，已截断；全文在${PLANS_PAGE}，需要细节时请成员查看或贴出相关部分，不要凭截断的内容推断后文）`;
    const room = Math.max(0, cap - estimateTokens(head.join('\n')) - estimateTokens(note));
    const body = official.content.trim() ? esc(official.content.trim()) : '（正文为空）';
    const block = [...head, clipToTokens(body, room, note)];
    blocks.push(block);
    used += estimateTokens(block.join('\n'));
  }

  // ---- 团队依据：已采纳且仍有效（含待复核），带类型和适用条件
  const basisRows = await db
    .select()
    .from(teamBasis)
    .where(
      and(
        eq(teamBasis.projectId, projectId),
        inArray(teamBasis.status, ['active', 'needs_review']),
      ),
    )
    .orderBy(desc(teamBasis.updatedAt));
  basisRows.sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active'));
  const basis = section(
    ['\n## 团队依据（负责人已采纳；只在适用条件内成立，待复核的先别当作定论）'],
    basisRows.map((r) => [
      `- [${BASIS_CLAIM_TYPE_LABEL[r.claimType]}${r.status === 'needs_review' ? '，待复核' : ''}] ${esc(r.title)}` +
        `（适用条件：${esc(r.conditions.trim() || '未写明')}${r.planVersion ? `；依据方案 v${r.planVersion}` : ''}）`,
      ...(r.status === 'needs_review' && r.reviewReason.trim()
        ? [`  待复核原因：${esc(clipToTokens(r.reviewReason.trim(), 60, '…'))}`]
        : []),
      `  ${clipToTokens(esc(r.content.trim()), PLAN_ITEM_TOKENS, '…（截断）').replace(/\n/gu, '\n  ')}`,
    ]),
    Math.floor(budget * PLAN_SHARE.basis),
    (n) => `（另有 ${n} 条团队依据未展开，见${PLANS_PAGE}）`,
  );
  if (basis.lines.length) blocks.push(basis.lines);
  used += basis.tokens;

  // ---- 探索副本：只列标题和说明，明确不是正式结论
  const explorations = await db
    .select({
      title: plans.title,
      summary: plans.summary,
      forkedFromVersion: plans.forkedFromVersion,
      ownerName: users.name,
    })
    .from(plans)
    .leftJoin(users, eq(users.id, plans.ownerId))
    .where(
      and(
        eq(plans.projectId, projectId),
        eq(plans.kind, 'exploration'),
        eq(plans.status, 'active'),
      ),
    )
    .orderBy(desc(plans.updatedAt));
  const exp = section(
    [
      `\n## 探索副本（${EXPLORATION_LABEL}：成员在试的改法，没有经过负责人采纳，不能当作团队结论引用）`,
    ],
    explorations.map((r) => [
      `- 「${EXPLORATION_LABEL}」${esc(r.title)}（${esc(r.ownerName ?? '成员')}${r.forkedFromVersion ? `，从正式方案 v${r.forkedFromVersion} 分叉` : ''}）` +
        (r.summary.trim()
          ? `：${clipToTokens(esc(r.summary.trim()), EXPLORATION_ITEM_TOKENS, '…').replace(/\n/gu, ' ')}`
          : ''),
    ]),
    Math.floor(budget * PLAN_SHARE.exploration),
    (n) => `（另有 ${n} 个探索副本未展开，见${PLANS_PAGE}）`,
  );
  if (exp.lines.length) blocks.push(exp.lines);
  used += exp.tokens;

  // ---- 个人工作记忆：只取本轮成员本人的；没有本轮成员、或他已不是项目成员，就不注入任何人的
  const [who] = actorUserId
    ? await db
        .select({ name: users.name })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actorUserId)))
    : [];
  if (actorUserId && who) {
    const rows = await db
      .select({ title: personalMemory.title, content: personalMemory.content })
      .from(personalMemory)
      .where(and(eq(personalMemory.projectId, projectId), eq(personalMemory.userId, actorUserId)))
      .orderBy(desc(personalMemory.updatedAt));
    const mine = section(
      [
        `\n## ${esc(who.name)}的个人工作记忆（只属于这位成员，用来理解这位成员的工作习惯和进行中的想法；不是团队结论，不要在团队可见的地方原样转述）`,
      ],
      rows.map((r) => [
        `- ${esc(r.title)}`,
        `  ${clipToTokens(esc(r.content.trim()), PLAN_ITEM_TOKENS, '…（截断）').replace(/\n/gu, '\n  ')}`,
      ]),
      Math.floor(budget * PLAN_SHARE.personal),
      (n) => `（另有 ${n} 条个人工作记忆未展开，成员可在${PLANS_PAGE}查看）`,
    );
    if (mine.lines.length) blocks.push(mine.lines);
    used += mine.tokens;
  }

  return { lines: blocks.flat(), tokens: used };
}

/**
 * <memory>：
 * 1. MEMORY.md（项目记忆索引）；
 * 2. 方案与依据：正式方案（版本号 + 要点，超出截断）、已采纳的团队依据（类型 + 适用条件）、
 *    探索副本（逐条标「探索中，非正式结论」）、本轮成员自己的个人工作记忆；
 * 3. 挑选的记忆文件（偏好类优先，其次最近更新），每个文件最多 4KB。
 * 整块不超过 budgetTokens：方案各段有各自的比例上限，只按实际用量扣；
 * MEMORY.md 最多占一半且不超过剩余；记忆文件放到预算用完为止。
 */
export async function renderMemory(
  ctx: AppContext,
  projectId: string,
  opts: RenderMemoryOptions = {},
): Promise<string> {
  const budget = Math.max(200, opts.budgetTokens ?? contextBudget(ctx.config).memory);
  const rows = await ctx.db.db
    .select()
    .from(memoryFiles)
    .where(eq(memoryFiles.projectId, projectId));
  const index = rows.find((r) => r.path === 'MEMORY.md');
  const rank = (t: string | null) =>
    t === 'user' || t === 'feedback' ? 0 : t === 'project' ? 1 : 2;
  const others = rows
    .filter((r) => r.path !== 'MEMORY.md')
    .sort((a, b) => rank(a.type) - rank(b.type) || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, MEMORY_EXTRA_FILES);
  const planned = await renderPlans(ctx, projectId, budget, opts.actorUserId);
  const indexHead = ['<memory>', `## MEMORY.md（version ${index?.version ?? 0}）`];
  const indexNote = '\n…（MEMORY.md 超出记忆预算，已截断；memory_read 读全文）';
  const indexRoom = Math.max(
    0,
    Math.min(
      Math.floor(budget / 2),
      budget -
        planned.tokens -
        estimateTokens(indexHead.join('\n')) -
        estimateTokens(indexNote) -
        MEMORY_TAIL_TOKENS,
    ),
  );
  const indexBody = clipToTokens(esc(index?.content ?? '（空）'), indexRoom, indexNote);
  const out = [...indexHead, indexBody, ...planned.lines];
  let used = estimateTokens(out.join('\n'));
  let shown = 0;
  for (const f of others) {
    const body = Buffer.from(f.content, 'utf8').subarray(0, MEMORY_FILE_BYTES).toString('utf8');
    const block = [
      `\n## ${esc(f.path)}（version ${f.version}${f.type ? `，type ${f.type}` : ''}）— ${esc(f.description)}`,
      esc(body) +
        (Buffer.byteLength(f.content) > MEMORY_FILE_BYTES ? '\n…（截断，memory_read 读全文）' : ''),
    ];
    const cost = estimateTokens(block.join('\n'));
    if (used + cost + MEMORY_TAIL_TOKENS > budget) break;
    out.push(...block);
    used += cost;
    shown += 1;
  }
  const rest = rows.filter((r) => r.path !== 'MEMORY.md').length - shown;
  if (rest > 0) out.push(`\n（另有 ${rest} 个记忆文件未展开，用 memory_list / memory_read 查看）`);
  out.push('</memory>');
  return out.join('\n');
}
