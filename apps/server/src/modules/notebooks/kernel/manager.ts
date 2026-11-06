import { randomUUID } from 'node:crypto';
import { and, inArray, isNull } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  NOTEBOOK_METRICS_MIME,
  type ActorRef,
  type KernelStatus,
  type NbOutput,
  type NotebookRun,
  type NotebookVariable,
} from '@srh/shared';
import type { AppContext } from '../../../context';
import { projects } from '../../../db/schema';
import { openLiveDocument, type LiveDocumentHandle } from '../../../realtime/collab';
import { IdleReaper } from '../../../sandbox/idle';
import { cellsOf, findCell } from '../nbformat';
import { GatewayError, KernelGatewayClient, type GatewayEndpoint } from './gateway';
import { createKernelHost, type KernelHost, type OomState } from './host';
import { appendOutput, updateDisplay } from './output';
import { KernelDiedError, KernelSession, VARIABLES_CODE } from './session';

/**
 * 内核调度：每个 notebook 一个内核会话（同一项目的会话都在该项目的容器里），
 * 每个 notebook 一条执行队列，串行执行；输出实时写进 Y.Doc，所有打开这本 notebook 的人同时看到。
 */
export interface MetricsSink {
  (
    notebookId: string,
    kind: 'params' | 'metrics',
    values: Record<string, unknown>,
    actor: ActorRef,
  ): Promise<void>;
}

interface QueueItem {
  cellId: string;
  runId: string;
  actor: ActorRef;
  /** 研究空间运行固定的代码；普通 Notebook 执行仍读取实时内容。 */
  frozenCode?: string;
}

interface NotebookKernel {
  notebookId: string;
  projectId: string;
  session: KernelSession | null;
  starting: Promise<KernelSession> | null;
  queue: QueueItem[];
  working: boolean;
  /** 正在执行的单元格 */
  current: QueueItem | null;
  live: LiveDocumentHandle | null;
  /** 最近一次被使用（执行、启动），用来挑最久没用的内核休眠 */
  lastUsed: number;
  /** 内核意外退出后的处理（判断是否 OOM → 给用户看的说明）；处理完（已重启）置空 */
  crash: Promise<string> | null;
  /** 下次启动时写进 kernel.error 的说明（崩溃后自动重启） */
  notice: string | null;
  /** 启动内核时容器的 OOM 计数，崩溃后对比判断是不是内存超限 */
  oomBase: OomState | null;
}

/** 同时运行的内核到了上限，而且都在忙 */
export class KernelCapacityError extends Error {}

export interface KernelManagerOptions {
  /** 测试用：替换网关客户端 */
  clientFactory?: (ep: GatewayEndpoint) => KernelGatewayClient;
  /** 执行中向网关确认内核还活着的间隔（毫秒，默认 15s；0 关闭） */
  watchdogMs?: number;
}

type CellResult = { status: 'ok' | 'error' | 'aborted' } | { status: 'died'; message: string };

const SYSTEM: ActorRef = { kind: 'system', id: null, name: '研协' };

/** 内核崩溃后给用户看的说明（写在单元格错误输出和 kernel.error 里） */
export function crashText(oom: boolean, memoryMb: number): string {
  return oom
    ? `内核已崩溃（内存超过上限 ${memoryMb} MB），已自动重启，之前的变量已清空。`
    : '内核意外退出，已自动重启，之前的变量已清空。';
}

/** 网关报告空闲 / 刚启动、但我们的执行请求还没回复：连续这么多次就认为请求丢了（内核被重启过） */
const LOST_STRIKES = 3;

export class KernelManager {
  readonly host: KernelHost | null;
  private readonly kernels = new Map<string, NotebookKernel>();
  private readonly reaper: IdleReaper | null;
  private readonly clientFactory: (ep: GatewayEndpoint) => KernelGatewayClient;
  private readonly watchdogMs: number;
  /** 崩溃说明：KernelDiedError → 判断完 OOM 后的中文说明 */
  private readonly crashMessages = new WeakMap<KernelDiedError, Promise<string>>();
  private sweepTimers: ReturnType<typeof setTimeout>[] = [];
  metricsSink: MetricsSink | null = null;

  constructor(
    private readonly ctx: AppContext,
    host?: KernelHost | null,
    opts: KernelManagerOptions = {},
  ) {
    this.host = host === undefined ? createKernelHost(ctx.config) : host;
    this.clientFactory = opts.clientFactory ?? ((ep) => new KernelGatewayClient(ep));
    this.watchdogMs = opts.watchdogMs ?? 15_000;
    const idleMs = ctx.config.KERNEL_IDLE_MINUTES * 60_000;
    this.reaper =
      this.host && idleMs > 0
        ? new IdleReaper(
            idleMs,
            (projectId) => this.releaseProject(projectId),
            (projectId) =>
              [...this.kernels.values()].some((k) => k.projectId === projectId && k.working),
          )
        : null;
  }

  get available() {
    return this.host !== null;
  }

  private entry(notebookId: string, projectId: string): NotebookKernel {
    let k = this.kernels.get(notebookId);
    if (!k) {
      k = {
        notebookId,
        projectId,
        session: null,
        starting: null,
        queue: [],
        working: false,
        current: null,
        live: null,
        lastUsed: Date.now(),
        crash: null,
        notice: null,
        oomBase: null,
      };
      this.kernels.set(notebookId, k);
    }
    return k;
  }

  /** 改 notebook 的 kernel / runs 状态（有执行中的连接就复用，否则临时打开） */
  private async patchDoc(k: NotebookKernel, fn: (doc: Y.Doc) => void) {
    if (k.live) {
      await k.live.transact(fn);
      return;
    }
    let handle: LiveDocumentHandle | null = null;
    try {
      handle = await openLiveDocument(this.ctx, k.notebookId, SYSTEM);
      await handle.transact(fn);
    } catch {
      /* notebook 已删除 */
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private setKernelState(
    k: NotebookKernel,
    patch: {
      status?: KernelStatus;
      error?: string | null;
      executionCount?: number;
      startedAt?: string | null;
    },
  ) {
    return this.patchDoc(k, (doc) => {
      const m = doc.getMap('kernel');
      if (patch.status !== undefined) m.set('status', patch.status);
      if (patch.error !== undefined) m.set('error', patch.error);
      if (patch.executionCount !== undefined) m.set('executionCount', patch.executionCount);
      if (patch.startedAt !== undefined) m.set('startedAt', patch.startedAt);
      if (!m.has('language')) m.set('language', 'python');
    });
  }

  kernelStatus(notebookId: string): KernelStatus {
    if (!this.host) return 'unavailable';
    const k = this.kernels.get(notebookId);
    if (!k) return 'none';
    if (k.crash) return 'restarting';
    if (k.starting) return 'starting';
    return k.session ? (k.session.status as KernelStatus) : 'none';
  }

  /** 正在占资源的内核（活着或正在启动） */
  runningCount(except?: NotebookKernel) {
    let n = 0;
    for (const k of this.kernels.values()) {
      if (k !== except && (k.starting || k.session?.alive)) n += 1;
    }
    return n;
  }

  /**
   * 同时运行的内核数有上限（KERNEL_MAX_RUNNING），防止几个人同时跑把服务器内存用光。
   * 到上限时先休眠最久没用、也没在执行的内核；全都在忙就报「资源不足」。
   */
  private overCapacity(k: NotebookKernel) {
    const max = this.ctx.config.KERNEL_MAX_RUNNING;
    return max > 0 && this.runningCount(k) >= max;
  }

  private async makeRoom(k: NotebookKernel) {
    const max = this.ctx.config.KERNEL_MAX_RUNNING;
    const victim = [...this.kernels.values()]
      .filter(
        (o) => o !== k && o.session?.alive && !o.starting && !o.working && o.queue.length === 0,
      )
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) {
      throw new KernelCapacityError(
        `资源不足：服务器上已有 ${max} 个内核在运行，而且都在执行代码。请等别人的单元格跑完再试，或在用完的 Notebook 里点「内核 → 关闭」。`,
      );
    }
    await this.sleep(victim);
  }

  /** 休眠一个内核：关掉进程（变量清空），记一条原因给打开这本 notebook 的人看 */
  private async sleep(k: NotebookKernel) {
    const projectId = k.projectId;
    await this.shutdown(k.notebookId);
    await this.setKernelState(k, {
      status: 'none',
      error:
        '为了给其他 Notebook 腾出资源，这个内核已自动休眠，变量已清空；重新运行单元格会自动启动。',
    });
    // 这个项目已经没有内核了，容器也一起停掉（docker 模式下才真正释放内存）
    const left = [...this.kernels.values()].some((o) => o.projectId === projectId);
    if (!left) await this.host?.release(projectId).catch(() => undefined);
  }

  /** 拿到（必要时启动）内核会话 */
  async ensureSession(notebookId: string, projectId: string): Promise<KernelSession> {
    if (!this.host) throw new Error('服务器没有配置内核服务');
    const k = this.entry(notebookId, projectId);
    this.reaper?.touch(projectId);
    k.lastUsed = Date.now();
    if (k.session?.alive) return k.session;
    if (k.starting) return k.starting;
    if (k.crash) {
      // 内核刚崩溃：等崩溃处理（OOM 判断）完成，它会自动重启
      await k.crash.catch(() => undefined);
      if (k.session?.alive) return k.session;
      if (k.starting) return k.starting;
    }
    // 检查名额和占位（设 k.starting）之间不能有 await，否则并发启动会一起越过上限
    while (this.overCapacity(k)) {
      await this.makeRoom(k);
      if (k.session?.alive) return k.session;
      if (k.starting) return k.starting;
    }
    k.starting = (async () => {
      const notice = k.notice;
      k.notice = null;
      await this.setKernelState(k, { status: 'starting', error: notice });
      try {
        const ep = await this.host!.endpoint(projectId);
        // 记下容器当前的 OOM 计数，内核死掉时对比，判断是不是内存超限
        k.oomBase = (await this.host!.oomState?.(projectId).catch(() => null)) ?? null;
        const client = this.clientFactory(ep);
        const kernelId = await client.startKernel('python3');
        const session = new KernelSession(client, kernelId);
        session.onStatus = (s) => {
          // restarting / dead 由 onDead 统一处理（失败当前和排队的单元格、自动重启）
          if (s === 'restarting' || s === 'dead') return;
          void this.setKernelState(k, { status: s });
        };
        session.onDead = (_reason, err) => this.onKernelDied(k, session, err);
        await session.connect();
        k.session = session;
        await this.setKernelState(k, {
          status: 'idle',
          executionCount: 0,
          startedAt: new Date().toISOString(),
        });
        return session;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.setKernelState(k, { status: 'dead', error: `内核启动失败：${msg}` });
        throw err;
      } finally {
        k.starting = null;
      }
    })();
    return k.starting;
  }

  /** 把单元格排进执行队列，立即返回（输出通过 Y.Doc 流出去） */
  async enqueue(
    notebookId: string,
    projectId: string,
    cellIds: string[],
    actor: ActorRef,
  ): Promise<NotebookRun[]> {
    return this.enqueueItems(notebookId, projectId, cellIds, actor);
  }

  /** 仍使用同一个隔离内核和输出管道，但运行用户启动时冻结的代码。 */
  async enqueueFrozen(
    notebookId: string,
    projectId: string,
    cells: { id: string; source: string }[],
    actor: ActorRef,
  ): Promise<NotebookRun[]> {
    return this.enqueueItems(
      notebookId,
      projectId,
      cells.map((cell) => cell.id),
      actor,
      new Map(cells.map((cell) => [cell.id, cell.source])),
    );
  }

  private async enqueueItems(
    notebookId: string,
    projectId: string,
    cellIds: string[],
    actor: ActorRef,
    frozen?: Map<string, string>,
  ): Promise<NotebookRun[]> {
    if (!this.host) throw new Error('服务器没有配置内核服务');
    const k = this.entry(notebookId, projectId);
    const at = new Date().toISOString();
    const items = cellIds
      .filter((id) => !k.queue.some((q) => q.cellId === id) && k.current?.cellId !== id)
      .map((cellId) => ({
        cellId,
        runId: randomUUID(),
        actor,
        ...(frozen ? { frozenCode: frozen.get(cellId)! } : {}),
      }));
    if (!items.length) return [];
    k.queue.push(...items);
    await this.patchDoc(k, (doc) => {
      const runs = doc.getMap<NotebookRun>('runs');
      for (const it of items)
        runs.set(it.cellId, { runId: it.runId, state: 'queued', by: actor, at });
    });
    void this.work(k);
    return items.map((it) => ({ runId: it.runId, state: 'queued' as const, by: actor, at }));
  }

  /** 把这些单元格标成失败：清掉排队状态，输出换成一条错误 */
  private async failCells(
    live: LiveDocumentHandle,
    items: QueueItem[],
    err: { ename: string; evalue: string; traceback: string[] },
  ) {
    if (!items.length) return;
    await live.transact((doc) => {
      const runs = doc.getMap('runs');
      for (const it of items) {
        runs.delete(it.cellId);
        const found = findCell(doc, it.cellId);
        const outputs = found?.cell.get('outputs');
        if (outputs instanceof Y.Array) {
          outputs.delete(0, outputs.length);
          outputs.push([{ output_type: 'error', ...err }]);
        }
        if (found?.cell.get('type') === 'code') found.cell.set('execution_count', null);
      }
    });
  }

  /** 执行队列（同一 notebook 只有一个 worker） */
  private async work(k: NotebookKernel) {
    if (k.working) return;
    k.working = true;
    try {
      k.live = await openLiveDocument(this.ctx, k.notebookId, SYSTEM);
      let lastPersist = Date.now();
      while (k.queue.length) {
        // 每个单元格前都确认一次内核：上一个单元格把内核搞崩了，这里会等自动重启完成
        let session: KernelSession;
        try {
          session = await this.ensureSession(k.notebookId, k.projectId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.failCells(k.live, k.queue.splice(0), {
            ename: 'KernelError',
            evalue: msg,
            traceback: [`内核启动失败：${msg}`],
          });
          return;
        }
        const item = k.queue.shift();
        if (!item) break;
        k.current = item;
        k.lastUsed = Date.now();
        this.reaper?.touch(k.projectId);
        const r = await this.runCell(k, session, item);
        k.current = null;
        if (r.status === 'died') {
          // 内核崩了：排队的单元格明确报错（而不是一直排着），用户确认后重新运行
          const note = `这个单元格没有运行：${r.message}请重新运行。`;
          await this.failCells(k.live, k.queue.splice(0), {
            ename: 'DeadKernelError',
            evalue: note,
            traceback: [note],
          });
        } else if (r.status !== 'ok') {
          // 和 Jupyter 一样：出错 / 中断后，后面排队的单元格全部取消
          const aborted = k.queue.splice(0);
          await k.live.transact((doc) => {
            const runs = doc.getMap('runs');
            for (const it of aborted) runs.delete(it.cellId);
          });
        }
        if (Date.now() - lastPersist > 5000) {
          await k.live.persist();
          lastPersist = Date.now();
        }
      }
    } finally {
      k.current = null;
      k.working = false;
      const live = k.live;
      k.live = null;
      await live?.close().catch(() => undefined);
      this.reaper?.touch(k.projectId);
      if (k.queue.length) void this.work(k);
    }
  }

  private async runCell(
    k: NotebookKernel,
    session: KernelSession,
    item: QueueItem,
  ): Promise<CellResult> {
    const live = k.live!;
    let code: string | null = null;
    await live.transact((doc) => {
      const found = findCell(doc, item.cellId);
      const runs = doc.getMap<NotebookRun>('runs');
      if (!found || found.cell.get('type') !== 'code') {
        runs.delete(item.cellId);
        return;
      }
      // 上一次崩溃 / 休眠的说明，开始跑新单元格后就不再显示
      const km = doc.getMap('kernel');
      if (km.get('error')) km.set('error', null);
      const src = found.cell.get('source');
      code = item.frozenCode ?? (src instanceof Y.Text ? src.toString() : String(src ?? ''));
      const outputs = found.cell.get('outputs');
      if (outputs instanceof Y.Array) outputs.delete(0, outputs.length);
      found.cell.set('execution_count', null);
      runs.set(item.cellId, {
        runId: item.runId,
        state: 'running',
        by: item.actor,
        at: new Date().toISOString(),
      });
    });
    if (code === null) return { status: 'ok' };

    // 输出先攒一小批再写（避免每个 print 一次事务），50ms 刷一次
    type Op =
      | { kind: 'out'; out: NbOutput }
      | { kind: 'clear' }
      | { kind: 'update'; id: string; out: NbOutput }
      | { kind: 'count'; n: number };
    let ops: Op[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let clearPending = false;
    const metrics: { kind: 'params' | 'metrics'; values: Record<string, unknown> }[] = [];
    const flush = async () => {
      timer = null;
      if (!ops.length) return;
      const batch = ops;
      ops = [];
      await live.transact((doc) => {
        const found = findCell(doc, item.cellId);
        const outputs = found?.cell.get('outputs');
        for (const op of batch) {
          if (op.kind === 'update') updateDisplay(doc, op.id, op.out);
          if (!found || !(outputs instanceof Y.Array)) continue;
          const arr = outputs as Y.Array<NbOutput>;
          if (op.kind === 'clear') arr.delete(0, arr.length);
          if (op.kind === 'out') appendOutput(arr, op.out);
          if (op.kind === 'count') found.cell.set('execution_count', op.n);
        }
      });
    };
    const push = (op: Op) => {
      ops.push(op);
      timer ??= setTimeout(() => void flush(), 50);
    };

    let result: Awaited<ReturnType<KernelSession['execute']>>;
    let died: string | null = null;
    // 看门狗：内核死了但网关的 restarting / dead 消息没到我们这里时，靠轮询网关发现
    const strikes = { n: 0 };
    const watchdog =
      this.watchdogMs > 0
        ? setInterval(() => void this.probe(session, strikes), this.watchdogMs)
        : null;
    try {
      result = await session.execute(code, {
        onStart: (n) => push({ kind: 'count', n }),
        onOutput: (out) => {
          if (clearPending) {
            clearPending = false;
            push({ kind: 'clear' });
          }
          if (out.output_type === 'display_data' && out.data[NOTEBOOK_METRICS_MIME]) {
            const m = out.data[NOTEBOOK_METRICS_MIME] as {
              kind?: string;
              values?: Record<string, unknown>;
            };
            if ((m.kind === 'params' || m.kind === 'metrics') && m.values) {
              metrics.push({ kind: m.kind, values: m.values });
            }
          }
          push({ kind: 'out', out });
        },
        onClear: (wait) => {
          if (wait) clearPending = true;
          else push({ kind: 'clear' });
        },
        onUpdateDisplay: (id, out) => push({ kind: 'update', id, out }),
      });
    } catch (err) {
      if (err instanceof KernelDiedError) {
        // 内核进程没了（多半是内存超限被杀）：说明里写清楚原因和后果
        died = await (this.crashMessages.get(err) ?? Promise.resolve(crashText(false, 0)));
        push({
          kind: 'out',
          out: { output_type: 'error', ename: 'DeadKernelError', evalue: died, traceback: [died] },
        });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        push({
          kind: 'out',
          out: {
            output_type: 'error',
            ename: 'KernelError',
            evalue: msg,
            traceback: [`内核出错：${msg}`],
          },
        });
      }
      result = { status: 'error', executionCount: null };
    } finally {
      if (watchdog) clearInterval(watchdog);
    }
    if (timer) clearTimeout(timer);
    await flush();
    await live.transact((doc) => {
      const found = findCell(doc, item.cellId);
      if (found && result.executionCount !== null)
        found.cell.set('execution_count', result.executionCount);
      doc.getMap<NotebookRun>('runs').delete(item.cellId);
      doc.getMap('kernel').set('executionCount', session.executionCount);
    });
    if (metrics.length && this.metricsSink) {
      for (const m of metrics) {
        await this.metricsSink(k.notebookId, m.kind, m.values, item.actor).catch(() => undefined);
      }
    }
    return died !== null ? { status: 'died', message: died } : { status: result.status };
  }

  /** 执行中问一下网关：内核还在不在、是不是在自动重启 */
  private async probe(session: KernelSession, strikes: { n: number }) {
    if (!session.alive) return;
    let state: string | null;
    try {
      state = await session.client.kernelState(session.kernelId);
    } catch {
      return; // 网关暂时连不上：WS 断开时会另外处理
    }
    if (!session.alive) return;
    if (state === null) return session.markDead('dead', '内核已不存在');
    if (state === 'dead' || state === 'restarting') return session.markDead(state);
    if ((state === 'idle' || state === 'starting') && session.executing) {
      strikes.n += 1;
      if (strikes.n >= LOST_STRIKES) session.markDead('lost');
    } else {
      strikes.n = 0;
    }
  }

  /**
   * 内核意外退出（会话已经让所有进行中的请求失败）：
   * 判断是不是内存超限（容器 OOM 计数），把状态广播成 restarting，关掉旧内核并自动启动新内核。
   * 正在执行的单元格由 runCell 写错误输出，排队的由 work 标成失败。
   */
  private onKernelDied(k: NotebookKernel, session: KernelSession, err: KernelDiedError) {
    if (k.session !== session) return; // 启动过程中死掉（ensureSession 自己报错）或已被替换
    k.session = null;
    const base = k.oomBase;
    const mb = this.ctx.config.KERNEL_MEMORY_MB;
    const crash = this.detectOom(k.projectId, base)
      .catch(() => false)
      .then((oom) => crashText(oom, mb));
    this.crashMessages.set(err, crash);
    k.crash = crash;
    void this.setKernelState(k, { status: 'restarting' });
    void (async () => {
      try {
        const msg = await crash;
        void session.client.shutdown(session.kernelId).catch(() => undefined);
        if (this.kernels.get(k.notebookId) !== k) return; // 期间被关闭了
        k.notice = msg;
        k.crash = null;
        await this.ensureSession(k.notebookId, k.projectId).catch(() => undefined);
      } finally {
        if (k.crash === crash) k.crash = null;
      }
    })();
  }

  /** 内核死掉是不是因为内存超限：容器的 OOM 计数比启动内核时多了 / docker 标记了 OOMKilled */
  private async detectOom(projectId: string, base: OomState | null): Promise<boolean> {
    const now = await this.host?.oomState?.(projectId);
    if (!now) return false;
    if (now.kills !== null && base && base.kills !== null) return now.kills > base.kills;
    if (now.oomKilled && !base?.oomKilled) return true;
    return !base && (now.kills ?? 0) > 0;
  }

  async interrupt(notebookId: string) {
    const k = this.kernels.get(notebookId);
    if (!k) return;
    if (k.crash || k.starting) return; // 正在自动重启 / 启动：没有可中断的
    const s = k.session;
    if (!s) return;
    if (!s.alive || s.status === 'restarting' || s.status === 'dead') {
      // 内核已经死了：中断没有意义，直接重启
      await this.restart(notebookId, k.projectId);
      return;
    }
    // 先确认内核还活着：网关说它在重启 / 已死时，按崩溃处理（当前单元格报错、排队的失败、自动重启）
    const state = await s.client.kernelState(s.kernelId).catch(() => 'unknown');
    if (state === null || state === 'dead' || state === 'restarting') {
      s.markDead(state ?? 'dead');
      return;
    }
    // 中断当前单元格；排队的会因为 KeyboardInterrupt 出错而被取消
    try {
      await s.client.interrupt(s.kernelId);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) s.markDead('dead', '内核已不存在');
      else throw err;
    }
  }

  async restart(notebookId: string, projectId: string, opts: { clearOutputs?: boolean } = {}) {
    const k = this.entry(notebookId, projectId);
    const queued = k.queue.splice(0);
    const old = k.session;
    k.session = null;
    await this.setKernelState(k, { status: 'restarting' });
    if (old) {
      old.close();
      await old.client.shutdown(old.kernelId).catch(() => undefined);
    }
    // 等正在执行的 worker 结束（会话关闭会让当前执行立即失败）
    for (let i = 0; i < 100 && k.working; i += 1) await new Promise((r) => setTimeout(r, 50));
    await this.patchDoc(k, (doc) => {
      const runs = doc.getMap('runs');
      for (const it of queued) runs.delete(it.cellId);
      runs.clear();
      if (opts.clearOutputs) {
        for (const cell of cellsOf(doc).toArray()) {
          const outputs = cell.get('outputs');
          if (outputs instanceof Y.Array) outputs.delete(0, outputs.length);
          if (cell.get('type') === 'code') cell.set('execution_count', null);
        }
      }
    });
    await this.ensureSession(notebookId, projectId);
  }

  async shutdown(notebookId: string) {
    const k = this.kernels.get(notebookId);
    if (!k) return;
    k.queue.splice(0);
    const s = k.session;
    k.session = null;
    this.kernels.delete(notebookId);
    if (s) {
      s.close();
      await s.client.shutdown(s.kernelId).catch(() => undefined);
    }
    await this.setKernelState(k, { status: 'none' });
  }

  async variables(notebookId: string): Promise<NotebookVariable[]> {
    const k = this.kernels.get(notebookId);
    if (!k?.session?.alive) return [];
    if (k.working) {
      // 内核忙的时候请求会排在当前单元格后面；给个短超时，别卡住界面
    }
    const out = await k.session
      .runSilent(VARIABLES_CODE, k.working ? 2000 : 15_000)
      .catch(() => '');
    const line = out.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(line) as NotebookVariable[];
    } catch {
      return [];
    }
  }

  async complete(notebookId: string, code: string, cursorPos: number) {
    const k = this.kernels.get(notebookId);
    if (!k?.session?.alive) return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    return k.session.complete(code, cursorPos);
  }

  async inspect(notebookId: string, code: string, cursorPos: number) {
    const k = this.kernels.get(notebookId);
    if (!k?.session?.alive) return { found: false, data: {} };
    return k.session.inspect(code, cursorPos);
  }

  /** 等某个 notebook 的执行队列跑完（agent 工具、测试用） */
  async waitIdle(notebookId: string, timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const k = this.kernels.get(notebookId);
      if (!k || (!k.working && !k.queue.length)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  private async releaseProject(projectId: string) {
    for (const k of [...this.kernels.values()]) {
      if (k.projectId === projectId) await this.shutdown(k.notebookId);
    }
    await this.host?.release(projectId);
  }

  /**
   * 项目归档（删除）：关掉它的所有内核，并删除内核容器（不只是停掉）。
   * 数据卷保留——项目恢复后再运行会重建容器，工作目录里的文件还在。
   */
  async reclaimProject(projectId: string) {
    for (const k of [...this.kernels.values()]) {
      if (k.projectId === projectId) await this.shutdown(k.notebookId).catch(() => undefined);
    }
    this.reaper?.forget(projectId);
    if (!this.host) return;
    if (this.host.remove) await this.host.remove(projectId);
    else await this.host.release(projectId);
  }

  /**
   * 兜底清理：列出所有内核容器，删掉项目已归档或已不存在的
   * （归档钩子执行失败、服务重启错过钩子、项目被直接从库里删掉）。返回被删除容器的项目 ID。
   */
  async sweepOrphanContainers(): Promise<string[]> {
    if (!this.host?.list) return [];
    const list = await this.host.list();
    const ids = [...new Set(list.map((c) => c.projectId).filter((x): x is string => !!x))];
    if (!ids.length) return [];
    const alive = await this.ctx.db.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(inArray(projects.id, ids), isNull(projects.archivedAt)));
    const keep = new Set(alive.map((r) => r.id));
    const removed: string[] = [];
    for (const id of ids) {
      if (keep.has(id)) continue;
      try {
        await this.reclaimProject(id);
        removed.push(id);
      } catch (err) {
        console.warn(`[notebooks] 清理项目 ${id} 的内核容器失败`, err);
      }
    }
    return removed;
  }

  /** 定期兜底清理孤儿内核容器（启动 1 分钟后一次，之后每 everyMs 一次） */
  startSweeper(everyMs = 30 * 60_000) {
    if (!this.host?.list || this.sweepTimers.length) return;
    const run = () => void this.sweepOrphanContainers().catch(() => undefined);
    const first = setTimeout(run, Math.min(60_000, everyMs));
    const timer = setInterval(run, everyMs);
    first.unref?.();
    timer.unref?.();
    this.sweepTimers.push(first, timer);
  }

  async close() {
    this.reaper?.stop();
    for (const t of this.sweepTimers) clearInterval(t);
    this.sweepTimers = [];
    for (const k of [...this.kernels.values()]) {
      k.queue.splice(0);
      const s = k.session;
      k.session = null;
      if (s) {
        s.close();
        await s.client.shutdown(s.kernelId).catch(() => undefined);
      }
    }
    this.kernels.clear();
  }
}
