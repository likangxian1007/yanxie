import { parseChecklist, type AgentSession, type StatusBucket, type Thread } from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 线程状态中文名（STYLE §1.3）。review_ready = agent 交了结果、等人看一眼，叫「待验收」，
 * 和真正的「审阅」功能（请人审阅、LGTM）区分开；线程页筛选、卡片、右栏都用这一份。
 */
export const STATUS_LABEL: Record<StatusBucket, string> = {
  working: tr('进行中'),
  blocked: tr('等你处理'),
  review_ready: tr('待验收'),
  completed: tr('已完成'),
  failed: tr('出错'),
  idle: tr('空闲'),
};

/** 状态点颜色（只用语义色类） */
export const STATUS_DOT_CLASS: Record<StatusBucket, string> = {
  working: 'bg-accent',
  blocked: 'bg-warning',
  review_ready: 'bg-agent',
  completed: 'bg-success',
  failed: 'bg-danger',
  idle: 'bg-fg-subtle',
};

/** agent 会话状态的中文 */
export const AGENT_STATUS_LABEL = {
  idle: tr('空闲'),
  queued: tr('排队中'),
  running: tr('工作中'),
  waiting: tr('等你回复'),
  failed: tr('已停下'),
  stopped: tr('已停止'),
} as const;

export type ThreadDisplayKind = StatusBucket | 'halted' | 'stopped' | 'awaiting';

export interface ThreadDisplay {
  /** 显示用的状态（比 statusBucket 多三种：出错或步数用完停下、被手动停止、清单没走完、agent 在等人回复） */
  kind: ThreadDisplayKind;
  /** 状态点用的桶（StatusDot 只认 StatusBucket） */
  dot: StatusBucket;
  label: string;
  /** agent 停下了、需要人决定要不要继续 */
  needsResume: boolean;
}

const DISPLAY_TEXT_CLASS: Record<ThreadDisplayKind, string> = {
  working: 'text-accent-text',
  blocked: 'text-warning',
  review_ready: 'text-agent-text',
  completed: 'text-success',
  failed: 'text-danger',
  idle: '',
  halted: 'text-danger',
  stopped: 'text-warning',
  awaiting: 'text-warning',
};

export function displayTextClass(kind: ThreadDisplayKind): string {
  return DISPLAY_TEXT_CLASS[kind];
}

/**
 * 线程「如实」的显示状态。statusBucket 由服务端按最后发言人算，agent 中途停工时
 * 会落在 review_ready（待验收）。这里结合 agent 会话状态和进度清单纠正：
 * - 会话 failed（出错、跑满步数上限）或桶为 failed → 「已停下」
 * - 会话 stopped（有人点了停止）→ 「已停止」
 * - agent 空闲，但清单里还有 ✱ 正在做的一步 → 「等你回复」：它停在半路、多半在等人给材料或答复，
 *   不是做完了等审阅（真正的中途停工由服务端标成 failed，落在上一条）
 */
export function threadDisplay(thread: Thread, agent?: AgentSession | null): ThreadDisplay {
  const base = (kind: ThreadDisplayKind, dot: StatusBucket, label: string, needsResume = false) =>
    ({ kind, dot, label, needsResume }) satisfies ThreadDisplay;
  if (thread.resolved)
    return base(thread.statusBucket, thread.statusBucket, STATUS_LABEL[thread.statusBucket]);
  const busy = agent && (agent.status === 'running' || agent.status === 'queued');
  if (busy || thread.statusBucket === 'working')
    return base('working', 'working', STATUS_LABEL.working);
  if (agent?.status === 'failed' || thread.statusBucket === 'failed')
    return base('halted', 'failed', tr('已停下'), true);
  if (agent?.status === 'stopped') return base('stopped', 'blocked', tr('已停止'), true);
  if (thread.statusBucket === 'review_ready' || thread.statusBucket === 'idle') {
    const active = parseChecklist(thread.statusText).lines.some((l) => l.mark === 'active');
    if (active && agent) return base('awaiting', 'blocked', tr('等你回复'));
  }
  return base(thread.statusBucket, thread.statusBucket, STATUS_LABEL[thread.statusBucket]);
}
