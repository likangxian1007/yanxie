import { scopeKey, scopeOf, type LibraryScopeInput } from './scope';
import type { AppContext } from '../../context';
import { pendingPapers, processPaper } from './pipeline';

/**
 * 解析队列：每个进程并发 1（GROBID CRF 一篇要占 1–2 GB 内存、几十秒 CPU，
 * 小服务器上同时解析两篇只会互相拖慢、还可能 OOM）。暂时性失败按 30s / 2min 退避重试，
 * 最多 3 次（pipeline.MAX_ATTEMPTS）。进程重启时把没解析完的重新排上。
 */
interface Job {
  projectId: LibraryScopeInput;
  paperId: string;
}

interface QueueState {
  waiting: Job[];
  running: Job | null;
  timers: Set<NodeJS.Timeout>;
  stopped: boolean;
  /** 测试用：队列空闲时 resolve */
  idle: (() => void)[];
}

const queues = new WeakMap<AppContext, QueueState>();

const RETRY_DELAYS_MS = [30_000, 120_000];

function state(ctx: AppContext): QueueState {
  let s = queues.get(ctx);
  if (!s) {
    s = { waiting: [], running: null, timers: new Set(), stopped: false, idle: [] };
    queues.set(ctx, s);
  }
  return s;
}

export function enqueuePaper(ctx: AppContext, projectId: LibraryScopeInput, paperId: string): void {
  const s = state(ctx);
  if (s.stopped) return;
  if (s.running?.paperId === paperId || s.waiting.some((j) => j.paperId === paperId)) return;
  s.waiting.push({ projectId, paperId });
  void pump(ctx);
}

export function queueStats(
  ctx: AppContext,
  scope?: LibraryScopeInput,
): { running: number; waiting: number } {
  const s = state(ctx);
  const matches = (j: Job) => scope === undefined || scopeKey(j.projectId) === scopeKey(scope);
  return {
    running: s.running && matches(s.running) ? 1 : 0,
    waiting: s.waiting.filter(matches).length,
  };
}

/** 队列里排在第几（0 = 正在解析，-1 = 不在队列里） */
export function queuePosition(ctx: AppContext, paperId: string): number {
  const s = state(ctx);
  if (s.running?.paperId === paperId) return 0;
  const i = s.waiting.findIndex((j) => j.paperId === paperId);
  return i < 0 ? -1 : i + 1;
}

async function pump(ctx: AppContext): Promise<void> {
  const s = state(ctx);
  if (s.running || s.stopped) return;
  const job = s.waiting.shift();
  if (!job) {
    for (const fn of s.idle.splice(0)) fn();
    return;
  }
  s.running = job;
  try {
    const r = await processPaper(ctx, job.projectId, job.paperId);
    if (r.kind === 'retry' && !s.stopped) {
      const attempt = Math.min(RETRY_DELAYS_MS.length - 1, s.timers.size);
      const delay = ctx.config.NODE_ENV === 'test' ? 10 : RETRY_DELAYS_MS[attempt]!;
      const t = setTimeout(() => {
        s.timers.delete(t);
        enqueuePaper(ctx, job.projectId, job.paperId);
      }, delay);
      t.unref?.();
      s.timers.add(t);
    }
  } catch (err) {
    console.error('[library] 解析任务异常', err);
  } finally {
    s.running = null;
    void pump(ctx);
  }
}

/** 测试用：等到队列空闲（没有正在跑、没有排队、没有待重试） */
export function waitForQueueIdle(ctx: AppContext, timeoutMs = 10_000): Promise<void> {
  const s = state(ctx);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (!s.running && s.waiting.length === 0 && s.timers.size === 0) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('解析队列一直没有空闲'));
      setTimeout(check, 10);
    };
    check();
  });
}

export async function resumePending(ctx: AppContext): Promise<void> {
  try {
    for (const p of await pendingPapers(ctx)) enqueuePaper(ctx, scopeOf(p), p.id);
  } catch (err) {
    console.error('[library] 恢复解析队列失败', err);
  }
}

export function stopQueue(ctx: AppContext): void {
  const s = state(ctx);
  s.stopped = true;
  s.waiting = [];
  for (const t of s.timers) clearTimeout(t);
  s.timers.clear();
}
