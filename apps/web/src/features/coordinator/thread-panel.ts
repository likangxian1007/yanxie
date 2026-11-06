import {
  parseChecklist,
  type AgentSession,
  type PresenceState,
  type StatusBucket,
  type Thread,
  type ThreadSummary,
  type ThreadWaiting,
} from '@srh/shared';
import { STATUS_LABEL, threadDisplay, type ThreadDisplay } from '@/lib/status';
import { tr } from '@/lib/i18n';

/**
 * 协作台右侧线程面板的数据整理（纯函数，便于测试）：
 * 每个线程一行的状态、进度、产出、在等谁、谁在看；按标签筛选与分组；“等你处理”的计数。
 */

/** 面板里的状态：比线程桶更贴近“现在要不要我管” */
export type PanelStatusKind =
  'running' | 'waiting' | 'halted' | 'stopped' | 'review' | 'done' | 'idle';

export interface PanelStatus {
  kind: PanelStatusKind;
  label: string;
  /** StatusDot 用的桶 */
  dot: StatusBucket;
  /** 文字色（语义色类） */
  textClass: string;
}

const STATUS: Record<PanelStatusKind, Omit<PanelStatus, 'kind'>> = {
  running: { label: tr('在跑'), dot: 'working', textClass: 'text-accent-text' },
  waiting: { label: tr('等你'), dot: 'blocked', textClass: 'text-warning' },
  halted: { label: tr('已停下'), dot: 'failed', textClass: 'text-danger' },
  stopped: { label: tr('已停止'), dot: 'blocked', textClass: 'text-warning' },
  review: { label: STATUS_LABEL.review_ready, dot: 'review_ready', textClass: 'text-agent-text' },
  done: { label: tr('已完成'), dot: 'completed', textClass: 'text-success' },
  idle: { label: tr('空闲'), dot: 'idle', textClass: 'text-fg-muted' },
};

/** threadDisplay 的结果 → 面板状态。“等人”统一叫“等你”，在等别人时由调用方改写成“等 某某”。 */
export function panelStatus(display: ThreadDisplay): PanelStatus {
  const kind: PanelStatusKind = (() => {
    switch (display.kind) {
      case 'working':
        return 'running';
      case 'halted':
      case 'failed':
        return 'halted';
      case 'stopped':
        return 'stopped';
      case 'awaiting':
      case 'blocked':
        return 'waiting';
      case 'review_ready':
        return 'review';
      case 'completed':
        return 'done';
      default:
        return 'idle';
    }
  })();
  return { kind, ...STATUS[kind] };
}

export interface PanelViewer {
  userId: string;
  name: string;
  color: number;
  typing: boolean;
}

export interface PanelThread {
  thread: Thread;
  agent: AgentSession | null;
  display: ThreadDisplay;
  status: PanelStatus;
  /** 规整后的标签；没有标签为 '' */
  label: string;
  progress: { done: number; total: number };
  /** 现在在做什么：清单里 ✱ 那一行，或 agent 的一句话动态 */
  current: string | null;
  outputs: number;
  openDecisions: number;
  /** 在等哪些成员（去重，按先后） */
  waitingOn: string[];
  waitingOnMe: boolean;
  /** 正在看这个线程的其他成员 */
  viewers: PanelViewer[];
}

export interface BuildInput {
  threads: readonly Thread[];
  agents: readonly AgentSession[];
  /** GET P/thread-summaries；接口还没有时为 undefined */
  summaries?: readonly ThreadSummary[] | undefined;
  presence?: readonly PresenceState[] | undefined;
  meId: string | null;
}

export function normalizeLabel(label: string | null | undefined): string {
  return label?.trim() ?? '';
}

function agentFor(thread: Thread, agents: readonly AgentSession[]): AgentSession | null {
  return (
    agents.find((a) => a.id === thread.agentSessionId) ??
    agents.find((a) => a.threadId === thread.id) ??
    null
  );
}

/**
 * 线程在等谁：优先用服务端汇总（未处理的拍板、审阅、@、冲突，覆盖所有成员）；
 * 没有汇总时退回到“线程在等人回复 → 等 agent 为之工作的成员（或发起人）”。
 */
export function waitingOnFor(
  thread: Thread,
  agent: AgentSession | null,
  status: PanelStatus,
  waiting: readonly ThreadWaiting[] | undefined,
): string[] {
  if (thread.resolved) return [];
  if (waiting && waiting.length > 0) return [...new Set(waiting.map((w) => w.userId))];
  if (status.kind === 'waiting') {
    const who = agent?.workingForUserId ?? thread.ownerUserId;
    return who ? [who] : [];
  }
  return [];
}

export function buildPanelThreads(input: BuildInput): PanelThread[] {
  const summaryById = new Map(
    (Array.isArray(input.summaries) ? input.summaries : []).map((s) => [s.threadId, s]),
  );
  return input.threads
    .filter((t) => t.kind === 'project')
    .map((thread) => {
      const agent = agentFor(thread, input.agents);
      const display = threadDisplay(thread, agent);
      const base = panelStatus(display);
      const checklist = parseChecklist(thread.statusText);
      const active = checklist.lines.find((l) => l.mark === 'active')?.text ?? null;
      const summary = summaryById.get(thread.id);
      const waitingOn = waitingOnFor(thread, agent, base, summary?.waitingOn);
      // agent 没在跑、也没停下，但有成员还没处理（拍板、审阅、@）：如实写成在等人
      const status: PanelStatus =
        waitingOn.length > 0 && (base.kind === 'idle' || base.kind === 'review')
          ? { kind: 'waiting', ...STATUS.waiting }
          : base;
      const viewers = (input.presence ?? [])
        .filter((p) => p.view === 'thread' && p.objectId === thread.id && p.userId !== input.meId)
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          color: p.avatarColor,
          typing: p.activity === 'typing',
        }));
      return {
        thread,
        agent,
        display,
        status,
        label: normalizeLabel(thread.label),
        progress: {
          done: checklist.lines.filter((l) => l.mark === 'done').length,
          total: checklist.lines.length,
        },
        current: thread.resolved
          ? null
          : status.kind === 'running'
            ? (agent?.activity ?? active)
            : active,
        outputs: summary?.outputs ?? 0,
        openDecisions: summary?.openDecisions ?? 0,
        waitingOn,
        waitingOnMe: input.meId !== null && waitingOn.includes(input.meId),
        viewers,
      } satisfies PanelThread;
    });
}

/** 排序：等你的 → 在跑 → 停下需要人管的 → 其余；同类按最近活动。 */
const RANK: Record<PanelStatusKind, number> = {
  waiting: 1,
  halted: 1,
  stopped: 1,
  running: 2,
  review: 3,
  idle: 4,
  done: 5,
};

export function compareRows(a: PanelThread, b: PanelThread): number {
  const ra = a.waitingOnMe ? 0 : RANK[a.status.kind];
  const rb = b.waitingOnMe ? 0 : RANK[b.status.kind];
  if (ra !== rb) return ra - rb;
  return b.thread.lastActivityAt.localeCompare(a.thread.lastActivityAt);
}

export interface LabelChip {
  /** '' = 未分类 */
  label: string;
  /** 未解决的线程数 */
  count: number;
  /** 其中在等你的 */
  waitingOnMe: number;
}

/** 标签筛选条：有线程的标签（含已解决），按名字排序；“未分类”放最后。 */
export function labelChips(rows: readonly PanelThread[]): LabelChip[] {
  const map = new Map<string, LabelChip>();
  for (const r of rows) {
    const chip = map.get(r.label) ?? { label: r.label, count: 0, waitingOnMe: 0 };
    if (!r.thread.resolved) chip.count += 1;
    if (r.waitingOnMe) chip.waitingOnMe += 1;
    map.set(r.label, chip);
  }
  return [...map.values()].sort((a, b) => {
    if (!a.label !== !b.label) return a.label ? -1 : 1;
    // 只剩已解决线程的标签排到后面
    if (!a.count !== !b.count) return a.count ? -1 : 1;
    return a.label.localeCompare(b.label, 'zh-CN');
  });
}

/** 按标签筛选；`null` = 全部，'' = 未分类。 */
export function filterByLabel(rows: readonly PanelThread[], label: string | null): PanelThread[] {
  if (label === null) return [...rows];
  return rows.filter((r) => r.label === label);
}

export interface PanelGroup {
  label: string;
  active: PanelThread[];
  resolved: PanelThread[];
  /** 组头右侧的小结：各状态的数量（只算未解决），按 在跑/等你/已停下/空闲… 的顺序 */
  tally: { kind: PanelStatusKind; label: string; count: number }[];
}

const TALLY_ORDER: PanelStatusKind[] = [
  'running',
  'waiting',
  'halted',
  'stopped',
  'review',
  'idle',
  'done',
];

function tallyOf(rows: readonly PanelThread[]): PanelGroup['tally'] {
  const out: PanelGroup['tally'] = [];
  for (const kind of TALLY_ORDER) {
    const inKind = rows.filter((r) => r.status.kind === kind);
    if (kind === 'waiting') {
      // 「等你」只算真在等我的；在等别人的单独记成「等人」
      const mine = inKind.filter((r) => r.waitingOnMe).length;
      const others = inKind.length - mine;
      if (mine > 0) out.push({ kind, label: tr('等你'), count: mine });
      if (others > 0) out.push({ kind, label: tr('等人'), count: others });
      continue;
    }
    if (inKind.length > 0) out.push({ kind, label: STATUS[kind].label, count: inKind.length });
  }
  return out;
}

/** 按标签分组：组内未解决的按 compareRows 排序，已解决的单独收起；组按名字排序，“未分类”最后。 */
export function groupByLabel(rows: readonly PanelThread[]): PanelGroup[] {
  const groups = labelChips(rows).map(({ label }) => {
    const inGroup = rows.filter((r) => r.label === label);
    const active = inGroup.filter((r) => !r.thread.resolved).sort(compareRows);
    const resolved = inGroup
      .filter((r) => r.thread.resolved)
      .sort((a, b) => b.thread.lastActivityAt.localeCompare(a.thread.lastActivityAt));
    return { label, active, resolved, tally: tallyOf(active) };
  });
  // 稳定排序：只剩已解决线程的组放到后面
  return groups.sort((a, b) => Number(a.active.length === 0) - Number(b.active.length === 0));
}

/** 平铺列表：未解决的排前面，已解决的另给。 */
export function flatList(rows: readonly PanelThread[]): {
  active: PanelThread[];
  resolved: PanelThread[];
} {
  return {
    active: rows.filter((r) => !r.thread.resolved).sort(compareRows),
    resolved: rows
      .filter((r) => r.thread.resolved)
      .sort((a, b) => b.thread.lastActivityAt.localeCompare(a.thread.lastActivityAt)),
  };
}

/** 在等你处理的线程数（面板头部与窄屏按钮上的数字）。 */
export function waitingOnMeCount(rows: readonly PanelThread[]): number {
  return rows.filter((r) => r.waitingOnMe).length;
}

/** 状态文字：在等别人时写成“等 张三”，等多人时“等 张三 等 2 人”。 */
export function statusText(
  row: PanelThread,
  nameOf: (userId: string) => string | undefined,
): string {
  if (row.status.kind !== 'waiting' || row.waitingOnMe || row.waitingOn.length === 0) {
    return row.status.label;
  }
  const first = nameOf(row.waitingOn[0] ?? '') ?? tr('成员');
  return row.waitingOn.length > 1
    ? tr('等 {first} 等 {count} 人', { first, count: row.waitingOn.length })
    : tr('等 {first}', { first });
}
