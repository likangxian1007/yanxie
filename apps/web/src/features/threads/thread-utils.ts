import type {
  AgentStep,
  Message,
  OutputKind,
  OutputRef,
  Page,
  Review,
  StatusBucket,
  Thread,
} from '@srh/shared';
import { STATUS_LABEL } from '@/lib/status';
import { isChangeTool } from './step-summary';
import { locale, tr } from '@/lib/i18n';

/**
 * 线程页的纯函数：筛选、分组、产出与改动的提取。不依赖 React，方便单测。
 */

// ---------------------------------------------------------------- 列表筛选

export type BucketTab = 'all' | Exclude<StatusBucket, 'idle'>;

/** 列表 tabs / 看板列的顺序；中文和卡片、右栏同一份（lib/status 的 STATUS_LABEL） */
export const BUCKET_TABS: { value: BucketTab; label: string }[] = [
  { value: 'all', label: tr('全部') },
  { value: 'working', label: STATUS_LABEL.working },
  { value: 'blocked', label: STATUS_LABEL.blocked },
  { value: 'review_ready', label: STATUS_LABEL.review_ready },
  { value: 'completed', label: STATUS_LABEL.completed },
  { value: 'failed', label: STATUS_LABEL.failed },
];

export const BOARD_COLUMNS = BUCKET_TABS.filter(
  (t): t is { value: Exclude<BucketTab, 'all'>; label: string } => t.value !== 'all',
);

export function isBucketTab(v: string | null): v is BucketTab {
  return BUCKET_TABS.some((t) => t.value === v);
}

export interface ThreadFilter {
  query: string;
  /** 只看某个标签；'' = 只看没有标签的；undefined = 不按标签筛 */
  label?: string | undefined;
  /** 是否显示已解决的线程（“已完成”里总是显示） */
  showResolved: boolean;
}

function matchesQuery(t: Thread, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return t.title.toLowerCase().includes(needle) || (t.label ?? '').toLowerCase().includes(needle);
}

/** 标签筛选：undefined 不筛，'' 只要没有标签的。 */
export function matchesLabel(t: Pick<Thread, 'label'>, label: string | undefined): boolean {
  if (label === undefined) return true;
  return (t.label ?? '') === label;
}

/** 列表里出现过的标签，按使用次数多到少，同次数按名字。 */
export function collectLabels(threads: readonly Pick<Thread, 'label'>[]): string[] {
  const n = new Map<string, number>();
  for (const t of threads) if (t.label) n.set(t.label, (n.get(t.label) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([l]) => l);
}

export interface LabelGroup<T> {
  /** null = 未加标签 */
  label: string | null;
  items: T[];
}

/** 按标签分组：组按 collectLabels 的顺序，未加标签的放最后；组内保持原顺序。 */
export function groupByLabel<T extends Pick<Thread, 'label'>>(
  items: readonly T[],
): LabelGroup<T>[] {
  const order = collectLabels(items);
  const groups = new Map<string | null, T[]>(order.map((l) => [l, []]));
  const none: T[] = [];
  for (const t of items) (t.label ? groups.get(t.label)! : none).push(t);
  const out: LabelGroup<T>[] = order.map((l) => ({ label: l, items: groups.get(l)! }));
  if (none.length) out.push({ label: null, items: none });
  return out;
}

/** 某个分组（tab / 看板列）里应该出现的线程。 */
export function threadsInBucket(threads: Thread[], bucket: BucketTab, f: ThreadFilter): Thread[] {
  const q = f.query.trim();
  return threads.filter((t) => {
    if (t.kind !== 'project') return false;
    if (bucket !== 'all' && t.statusBucket !== bucket) return false;
    if (t.resolved && !f.showResolved && bucket !== 'completed') return false;
    if (!matchesLabel(t, f.label)) return false;
    return matchesQuery(t, q);
  });
}

export function countByBucket(threads: Thread[], f: ThreadFilter): Record<BucketTab, number> {
  const out = {} as Record<BucketTab, number>;
  for (const tab of BUCKET_TABS) out[tab.value] = threadsInBucket(threads, tab.value, f).length;
  return out;
}

/** 置顶的在前，其余按最近活动新到旧。 */
export function sortThreads(threads: Thread[], pinned: readonly string[]): Thread[] {
  const pinRank = new Map(pinned.map((id, i) => [id, i]));
  return [...threads].sort((a, b) => {
    const pa = pinRank.get(a.id);
    const pb = pinRank.get(b.id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}

// ---------------------------------------------------------------- agent 思路

export interface StepTurn {
  turnId: string;
  /** 第几轮（从 1 开始，按出现顺序） */
  ordinal: number;
  startedAt: string;
  steps: AgentStep[];
}

/**
 * 分页数据（每页新→旧，apply-event 把新步骤插到第一页最前）→ 旧→新、去重的步骤列表。
 */
export function flattenSteps(pages: Page<AgentStep>[] | undefined): AgentStep[] {
  const seen = new Set<string>();
  const out: AgentStep[] = [];
  for (const page of pages ?? []) {
    for (const s of page.items) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out.sort((a, b) => {
    const t = a.createdAt.localeCompare(b.createdAt);
    if (t !== 0) return t;
    if (a.turnId === b.turnId && a.index !== b.index) return a.index - b.index;
    return a.id.localeCompare(b.id);
  });
}

/** 按 turnId 连续分组（同一轮的步骤是连续产生的）。 */
export function groupStepsByTurn(steps: AgentStep[]): StepTurn[] {
  const turns: StepTurn[] = [];
  const ordinals = new Map<string, number>();
  for (const s of steps) {
    const last = turns[turns.length - 1];
    if (last && last.turnId === s.turnId) {
      last.steps.push(s);
      continue;
    }
    let ordinal = ordinals.get(s.turnId);
    if (ordinal === undefined) {
      ordinal = ordinals.size + 1;
      ordinals.set(s.turnId, ordinal);
    }
    turns.push({ turnId: s.turnId, ordinal, startedAt: s.createdAt, steps: [s] });
  }
  return turns;
}

/** 会改动东西的工具调用（写文件、改文档、新建实验……；汇报进度、改自己消息的不算）。 */
export function isChangeStep(s: AgentStep): boolean {
  return s.kind === 'tool_call' && isChangeTool(s.name);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const TARGET_KEYS = [
  'path',
  'ref',
  'title',
  'document_id',
  'experiment_id',
  'card_id',
  'resource_ref',
  'resourceRef',
  'id',
  'file',
  'config',
  'name',
];

function pickTarget(rec: Record<string, unknown> | null): string | null {
  if (!rec) return null;
  for (const key of TARGET_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** 从 content 解析参数对象：整段 JSON，或 `name({...})`（解析不了返回 null）。 */
export function parseCallArgs(content: string): Record<string, unknown> | null {
  try {
    const whole = asRecord(JSON.parse(content));
    if (whole) return whole;
  } catch {
    // 不是整段 JSON，再试 name(...)
  }
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open === -1 || close <= open) return null;
  try {
    return asRecord(JSON.parse(content.slice(open + 1, close)));
  } catch {
    return null;
  }
}

/** 改动的目标：data.path / data.ref / data.title，其次 data.args 里的，再其次 content 里的参数。 */
export function changeTarget(s: AgentStep): string | null {
  return (
    pickTarget(s.data) ?? pickTarget(asRecord(s.data.args)) ?? pickTarget(parseCallArgs(s.content))
  );
}

/** 工具调用的参数（展开时显示的 JSON）。 */
export function callPayload(s: AgentStep): unknown {
  if (s.data.args !== undefined) return s.data.args;
  return parseCallArgs(s.content);
}

export type ResultTone = 'success' | 'error' | 'neutral';

export function resultTone(s: AgentStep): ResultTone {
  if (s.data.ok === false) return 'error';
  if (s.data.ok === true) return 'success';
  return 'neutral';
}

export interface ChangeEntry {
  step: AgentStep;
  target: string | null;
  /** 配对的结果：同一个 callId，没有 callId 时取同一轮里紧随其后的同名结果 */
  result: AgentStep | null;
}

/** 改动列表（新→旧）。 */
export function collectChanges(steps: AgentStep[]): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  steps.forEach((s, i) => {
    if (!isChangeStep(s)) return;
    const callId = typeof s.data.callId === 'string' ? s.data.callId : null;
    const later = steps.slice(i + 1);
    const result =
      (callId
        ? later.find((r) => r.kind === 'tool_result' && r.data.callId === callId)
        : undefined) ??
      later.find(
        (r) =>
          r.turnId === s.turnId &&
          r.kind === 'tool_result' &&
          r.name === s.name &&
          (!callId || r.data.callId === undefined),
      ) ??
      null;
    out.push({ step: s, target: changeTarget(s), result });
  });
  return out.reverse();
}

// ---------------------------------------------------------------- 产出

export interface OutputEntry {
  output: OutputRef;
  message: Message;
}

/** 线程消息里的全部产出（新→旧，同一对象只留最新的一次）。 */
export function collectOutputs(messages: Message[]): OutputEntry[] {
  const seen = new Set<string>();
  const out: OutputEntry[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    for (const o of m.outputs) {
      const key = `${o.kind}:${o.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ output: o, message: m });
    }
  }
  return out;
}

export const OUTPUT_KIND_LABEL: Record<OutputKind, string> = {
  file: tr('文件'),
  link: tr('链接'),
  document: tr('文档'),
  experiment: tr('实验记录'),
  report: tr('组会汇报'),
  research: tr('研究空间'),
};

export { outputHref } from '@/lib/outputs';

// ---------------------------------------------------------------- 审阅

/** 审阅是否属于这个线程：直接审阅线程，或由这个线程（的 agent）发起、审阅它的计划 / 文档等产出。 */
export function reviewBelongsToThread(r: Review, threadId: string): boolean {
  return (r.targetKind === 'thread' && r.targetId === threadId) || r.threadId === threadId;
}

/** GET P/reviews 可能返回数组或 Page：统一成数组，并只留属于这个线程的。 */
export function reviewsForThread(data: Review[] | Page<Review> | undefined, threadId: string) {
  const list = Array.isArray(data) ? data : (data?.items ?? []);
  return list
    .filter((r) => reviewBelongsToThread(r, threadId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 格式化 token 数：1234 → 1,234；96300 → 9.6 万 */
export function formatTokens(n: number): string {
  if (n >= 10_000) {
    const wan = n / 10_000;
    return tr('{value} 万', { value: wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10 });
  }
  return n.toLocaleString(locale());
}
