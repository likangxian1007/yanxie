import type { AgentSession, AgentStep, Message } from '@srh/shared';
import { groupStepsByTurn } from './thread-utils';
import { clip } from './step-summary';
import { tr } from '@/lib/i18n';

/*
 * AgentLiveActivity 的纯逻辑：根据会话状态、步骤、消息推出「工作中 / 已完成 / 出错」。
 */

export const LIVE_TEXT = {
  get thinking() {
    return tr('正在思考…');
  },
  get working() {
    return tr('工作中');
  },
  get queued() {
    return tr('排队中…');
  },
  get sent() {
    return tr('已发送，等待协调者接手…');
  },
  get notStarted() {
    return tr('协调者还没开始处理');
  },
  get notStartedHint() {
    return tr('消息已经送到，但它还没动起来。可以点「唤醒」，或稍后再看。');
  },
  get wake() {
    return tr('唤醒');
  },
  get process() {
    return tr('工作过程');
  },
  get noSteps() {
    return tr('还没有步骤，马上开始…');
  },
  get done() {
    return tr('已完成');
  },
  get steps() {
    return tr('步');
  },
  get took() {
    return tr('用时');
  },
  get failed() {
    return tr('这一轮出错停下了');
  },
  get stopped() {
    return tr('这一轮已被停止');
  },
  get noReply() {
    return tr('这一轮结束了，但没有给出回复');
  },
  get stepFailed() {
    return tr('上一步没成功');
  },
  get retry() {
    return tr('重试');
  },
  get resumed() {
    return tr('已让它接着做');
  },
  get resumeFailed() {
    return tr('没能让它继续');
  },
  get resumeGone() {
    return tr('在下面回一句「继续」也能唤醒它。');
  },
  get received() {
    return tr('收到');
  },
  get draft() {
    return tr('回复');
  },
  get think() {
    return tr('思考');
  },
} as const;

/** 用户对「工作过程」的折叠选择 */
export const LIVE_OPEN_KEY = 'srh-agent-live-open';
/** 发出后多久还没动静就提示「还没开始处理」 */
export const IDLE_HINT_MS = 20_000;
/** 发出后多久内还算「刚发」：超过就不再显示等待状态 */
export const PENDING_WINDOW_MS = 10 * 60_000;
const NO_REPLY_GRACE_MS = 3000;

export function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LIVE_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(LIVE_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 隐私模式等：只在本次生效 */
  }
}

export function ms(iso: string): number {
  return new Date(iso).getTime();
}

export function fmtSeconds(totalMs: number): string {
  const s = Math.max(0, Math.round(totalMs / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function stripNote(text: string): string {
  return text.replace(/<\/?system-note>/gu, '').trim();
}

export type LiveErrorKind = 'failed' | 'stopped' | 'step' | 'noReply' | 'notStarted';

export interface LiveError {
  kind: LiveErrorKind;
  title: string;
  reason: string | null;
  /** 红（出错）还是黄（停下 / 还没开始） */
  tone: 'danger' | 'warning';
  /** 可以「重试」（让 agent 接着做） */
  retryable: boolean;
}

export interface LiveState {
  /** 是否显示：工作中、等回复、出错，或有上一轮可以回看 */
  visible: boolean;
  /** 正在进行（显示动画、计时、默认展开） */
  live: boolean;
  label: string;
  /** 当前一轮（或上一轮）的步骤 */
  turnSteps: AgentStep[];
  /** 计时起点（ms） */
  startedAt: number | null;
  /** 一轮结束时的用时（ms） */
  tookMs: number | null;
  error: LiveError | null;
}

export interface DeriveInput {
  agent: AgentSession | null | undefined;
  steps: AgentStep[];
  messages: Message[];
  /** 本页最近一次发送成功的时间（ms） */
  sentAt: number | null;
  now: number;
}

function lastErrorNote(turn: AgentStep[]): AgentStep | null {
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const s = turn[i]!;
    if (s.kind === 'note' && s.name === 'error') return s;
  }
  return null;
}

function failedResultReason(s: AgentStep): string | null {
  if (s.kind !== 'tool_result') return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(s.content);
  } catch {
    /* 不是 JSON */
  }
  const err =
    parsed && typeof parsed === 'object' && 'error' in parsed
      ? (parsed as { error: unknown }).error
      : null;
  const failed = s.data.ok === false || typeof err === 'string';
  if (!failed) return null;
  if (typeof err === 'string' && err.trim()) return clip(err, 120);
  const first = s.content.trim().split('\n')[0] ?? '';
  return first && !first.startsWith('{') && !first.startsWith('[') ? clip(first, 120) : null;
}

/** 纯函数：根据会话状态、步骤、消息推出要显示什么（便于测试） */
export function deriveLiveState({ agent, steps, messages, sentAt, now }: DeriveInput): LiveState {
  const turns = groupStepsByTurn(steps);
  const lastTurn = turns.at(-1);
  const turnSteps = lastTurn?.steps ?? [];
  const latest = turnSteps.at(-1) ?? null;
  const status = agent?.status ?? null;
  const busy = status === 'running' || status === 'queued';

  const recentSend = sentAt !== null && now - sentAt < PENDING_WINDOW_MS ? sentAt : null;
  const replied =
    recentSend !== null &&
    messages.some(
      (m) =>
        m.author.kind === 'agent' &&
        (!agent || m.author.id === agent.id) &&
        ms(m.createdAt) >= recentSend - 1000,
    );
  // 发出之后这一轮已经跑过（有新步骤）
  const ranSinceSend =
    recentSend !== null && latest !== null && ms(latest.createdAt) >= recentSend - 1000;
  const waitingReply = recentSend !== null && !replied && !busy && !ranSinceSend;

  const live = busy || waitingReply;

  let label: string = LIVE_TEXT.working;
  if (status === 'queued') label = LIVE_TEXT.queued;
  else if (status === 'running')
    label =
      agent?.activity?.trim() ||
      (latest?.kind === 'thinking' ? LIVE_TEXT.thinking : LIVE_TEXT.working);
  else if (waitingReply) label = LIVE_TEXT.sent;

  // 当前一轮：发出后还没新步骤时，上一轮不算「这一轮」
  const turnFresh = !(live && recentSend !== null && !ranSinceSend);
  const shownSteps = turnFresh ? turnSteps : [];

  const startedAt = live
    ? turnFresh && lastTurn
      ? ms(lastTurn.startedAt)
      : (recentSend ?? null)
    : lastTurn
      ? ms(lastTurn.startedAt)
      : null;
  const tookMs =
    !live && lastTurn && latest ? Math.max(0, ms(latest.createdAt) - ms(lastTurn.startedAt)) : null;

  let error: LiveError | null = null;
  if (status === 'failed') {
    const note = lastErrorNote(turnSteps);
    error = {
      kind: 'failed',
      title: LIVE_TEXT.failed,
      reason: note ? clip(note.content.replace(/^出错：/u, ''), 160) : null,
      tone: 'danger',
      retryable: true,
    };
  } else if (status === 'stopped') {
    error = {
      kind: 'stopped',
      title: LIVE_TEXT.stopped,
      reason: null,
      tone: 'warning',
      retryable: true,
    };
  } else if (latest?.kind === 'note' && latest.name === 'error') {
    error = {
      kind: 'failed',
      title: LIVE_TEXT.failed,
      reason: clip(latest.content.replace(/^出错：/u, ''), 160),
      tone: 'danger',
      retryable: !busy,
    };
  } else if (latest && turnFresh && failedResultReason(latest) !== null) {
    error = {
      kind: 'step',
      title: LIVE_TEXT.stepFailed,
      reason: failedResultReason(latest),
      tone: 'danger',
      retryable: !busy,
    };
  } else if (
    recentSend !== null &&
    !busy &&
    ranSinceSend &&
    !replied &&
    // 回复消息和状态事件可能前后脚到，稍等一下再判定
    latest !== null &&
    now - ms(latest.createdAt) > NO_REPLY_GRACE_MS
  ) {
    error = {
      kind: 'noReply',
      title: LIVE_TEXT.noReply,
      reason: null,
      tone: 'danger',
      retryable: true,
    };
  } else if (waitingReply && now - recentSend >= IDLE_HINT_MS) {
    error = {
      kind: 'notStarted',
      title: LIVE_TEXT.notStarted,
      reason: LIVE_TEXT.notStartedHint,
      tone: 'warning',
      retryable: true,
    };
  }

  const visible = live || error !== null || turnSteps.length > 0;
  return { visible, live, label, turnSteps: shownSteps, startedAt, tookMs, error };
}
