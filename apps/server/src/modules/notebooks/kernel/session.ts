import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { NbOutput } from '@srh/shared';
import { type KernelGatewayClient, makeMessage, type JupyterMessage } from './gateway';

/**
 * 一个 notebook 的内核会话：一条到 Kernel Gateway 的 WS，按 parent msg_id 把 iopub 消息分给对应的执行。
 * 执行本身由 runner 串行排队（与 Jupyter 前端一致：前一个出错，后面排队的全部取消）。
 */
export type KernelLiveStatus = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead';

export interface ExecuteHandlers {
  /** execute_input：内核分配的执行计数 */
  onStart?(executionCount: number): void;
  onOutput(output: NbOutput): void;
  onClear(wait: boolean): void;
  onUpdateDisplay(displayId: string, output: NbOutput): void;
}

export interface ExecuteResult {
  status: 'ok' | 'error' | 'aborted';
  executionCount: number | null;
}

interface Pending {
  handlers?: ExecuteHandlers;
  /** 静默执行收集的 stdout（变量查看器等） */
  stdout?: string[];
  resolveReply: (msg: JupyterMessage) => void;
  rejectReply: (err: Error) => void;
  replied?: JupyterMessage;
  idle: boolean;
  done?: () => void;
  /** 代码调用了 input()，我们拒绝了输入请求并中断了内核（随后的 KeyboardInterrupt 不再显示） */
  stdinRefused?: boolean;
}

/**
 * 内核进程没了：
 *   restarting    网关报告内核正在自动重启（通常是内存超限被杀）
 *   dead          网关报告内核已死 / 内核不存在了
 *   disconnected  到网关的 WS 断开（容器被杀、网关重启）
 *   lost          网关说内核是空闲的，但我们的执行请求一直没有回复（内核重启时请求丢了）
 */
export type KernelDeathKind = 'restarting' | 'dead' | 'disconnected' | 'lost';

const DEATH_TEXT: Record<KernelDeathKind, string> = {
  restarting: '内核意外退出，正在重启',
  dead: '内核意外退出',
  disconnected: '内核连接断开',
  lost: '内核意外重启，正在执行的代码丢失',
};

export class KernelDiedError extends Error {
  constructor(
    readonly kind: KernelDeathKind,
    message = DEATH_TEXT[kind],
  ) {
    super(message);
    this.name = 'KernelDiedError';
  }
}

/** Notebook 不支持交互输入（allow_stdin=false），input() 时给出的提示 */
export const STDIN_HINT = 'Notebook 暂不支持 input() 交互输入，请把值直接写在代码里';

const stdinHintOutput = (): NbOutput => ({
  output_type: 'error',
  ename: 'StdinNotImplementedError',
  evalue: STDIN_HINT,
  traceback: [`\u001b[0;31mStdinNotImplementedError\u001b[0m: ${STDIN_HINT}`],
});

/** 内核启动时静默执行：注入 srh 模块（记录实验参数 / 指标），统一 matplotlib 输出 */
export const KERNEL_STARTUP_CODE = String.raw`
def __srh_bootstrap():
    import sys, types, json
    m = types.ModuleType("srh")
    MIME = "application/vnd.srh.metrics+json"
    def _emit(kind, values):
        from IPython.display import display
        clean = {}
        for k, v in values.items():
            try:
                json.dumps(v); clean[str(k)] = v
            except TypeError:
                clean[str(k)] = repr(v)
        display({MIME: {"kind": kind, "values": clean}, "text/plain": f"[srh] {kind}: " + ", ".join(f"{k}={v}" for k, v in clean.items())}, raw=True)
    def log_param(name, value): _emit("params", {name: value})
    def log_params(d=None, **kw): _emit("params", {**(d or {}), **kw})
    def log_metric(name, value, step=None, **_): _emit("metrics", {name: value})
    def log_metrics(d=None, **kw): _emit("metrics", {**(d or {}), **kw})
    m.log_param, m.log_params, m.log_metric, m.log_metrics = log_param, log_params, log_metric, log_metrics
    m.log = log_metrics
    m.__doc__ = "研协 Notebook：srh.log_param('lr', 3e-4) / srh.log_metric('acc', 0.91) 会显示在单元格输出的参数和指标"
    sys.modules["srh"] = m
    try:
        ip = get_ipython()
        ip.run_line_magic("matplotlib", "inline")
        ip.run_line_magic("config", "InlineBackend.figure_formats = ['png']")
    except Exception:
        pass
    # tqdm.auto 在 Jupyter 里会用 ipywidgets 进度条（走 comm 消息，研协不渲染，看起来卡在 0%）：
    # 换成文本进度条（与 deploy/kernel/startup/00-srh-tqdm.py 相同，本地网关模式也生效）
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            import tqdm.std, tqdm.auto, tqdm.autonotebook
            try:
                from tqdm.asyncio import tqdm as _t, trange as _r
            except Exception:
                _t, _r = tqdm.std.tqdm, tqdm.std.trange
            tqdm.auto.tqdm = tqdm.autonotebook.tqdm = _t
            tqdm.auto.trange = tqdm.autonotebook.trange = _r
    except Exception:
        pass
__srh_bootstrap()
del __srh_bootstrap
`;

/** 变量查看器：静默执行，最后一行 stdout 是 JSON */
export const VARIABLES_CODE = String.raw`
def __srh_vars():
    import json, types, sys
    ip = get_ipython()
    ns, hidden = ip.user_ns, ip.user_ns_hidden
    out = []
    skip = {"In", "Out", "exit", "quit", "get_ipython", "open"}
    for k, v in list(ns.items()):
        if k.startswith("_") or k in skip or (k in hidden and hidden[k] is v):
            continue
        if isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        t = type(v)
        tname = t.__name__ if t.__module__ in ("builtins", None) else f"{t.__module__.split('.')[0]}.{t.__name__}"
        shape = getattr(v, "shape", None)
        try:
            shape = str(tuple(shape)) if shape is not None else (f"len={len(v)}" if hasattr(v, "__len__") and not isinstance(v, str) else None)
        except Exception:
            shape = None
        try:
            r = repr(v)
        except Exception as e:
            r = f"<repr 失败: {e}>"
        r = " ".join(r.split())
        size = getattr(v, "nbytes", None)
        if size is None:
            try: size = sys.getsizeof(v)
            except Exception: size = None
        out.append({"name": k, "type": tname, "summary": r[:200], "shape": shape, "size": size})
    print(json.dumps(out[:500], ensure_ascii=False, default=str))
__srh_vars()
del __srh_vars
`;

export class KernelSession {
  status: KernelLiveStatus = 'starting';
  executionCount = 0;
  private ws: WebSocket | null = null;
  private readonly sessionId = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private closedByUs = false;
  /** 内核进程没了（不是我们关的）；之后这个会话不能再用 */
  deadKind: KernelDeathKind | null = null;
  onStatus: (status: KernelLiveStatus) => void = () => undefined;
  /** 内核意外退出：在拒绝所有进行中的请求之前同步调用 */
  onDead: (reason: string, err: KernelDiedError) => void = () => undefined;

  constructor(
    readonly client: KernelGatewayClient,
    readonly kernelId: string,
  ) {}

  async connect(): Promise<void> {
    const ws = this.client.connect(this.kernelId);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接内核超时')), 30_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ws.on('message', (data) => this.handle(data.toString()));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs) return;
      this.markDead('disconnected');
    });
    ws.on('error', () => undefined);
    // 等内核就绪（kernel_info 有回复即就绪）
    await this.request('kernel_info_request', {}, 60_000);
    this.setStatus('idle');
    await this.runSilent(KERNEL_STARTUP_CODE);
  }

  get alive() {
    return this.ws !== null && this.deadKind === null && this.status !== 'dead';
  }

  /** 还有没回复的执行请求（看门狗用：网关说空闲但请求还挂着 = 请求丢了） */
  get executing() {
    return [...this.pending.values()].some((p) => p.handlers || p.stdout);
  }

  /**
   * 内核进程没了（OOM 被杀、崩溃、网关自动重启、连接断开）：
   * 先通知调度器（同步），再让所有进行中的请求失败，然后断开连接——这个会话不再使用。
   */
  markDead(kind: KernelDeathKind, message?: string) {
    if (this.deadKind || this.closedByUs) return;
    this.deadKind = kind;
    const err = new KernelDiedError(kind, message);
    this.setStatus(kind === 'restarting' ? 'restarting' : 'dead');
    const ws = this.ws;
    this.ws = null;
    this.closedByUs = true;
    try {
      this.onDead(err.message, err);
    } finally {
      this.failAll(err);
      try {
        ws?.close();
      } catch {
        /* 已经断了 */
      }
    }
  }

  private setStatus(s: KernelLiveStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private send(msg: JupyterMessage) {
    if (!this.ws) throw new Error('内核未连接');
    this.ws.send(JSON.stringify(msg));
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.rejectReply(err);
    this.pending.clear();
  }

  private handle(raw: string) {
    let msg: JupyterMessage;
    try {
      msg = JSON.parse(raw) as JupyterMessage;
    } catch {
      return;
    }
    const parentId = msg.parent_header?.msg_id;
    const type = msg.header.msg_type;
    if (msg.channel === 'iopub' && type === 'status') {
      const state = (msg.content as { execution_state?: string }).execution_state;
      const p = parentId ? this.pending.get(parentId) : undefined;
      if (state === 'busy') this.setStatus('busy');
      if (state === 'idle') {
        if (p) {
          p.idle = true;
          this.maybeDone(parentId!, p);
        }
        if (![...this.pending.values()].some((x) => !x.idle)) this.setStatus('idle');
      }
      // 网关在内核进程死掉（多半是内存超限被杀）后会发 restarting / dead：
      // 正在执行的请求永远等不到回复了，必须立即失败，否则后面排队的单元格会一直卡着
      if (state === 'restarting' || state === 'dead') this.markDead(state);
      return;
    }
    if (!parentId) return;
    const p = this.pending.get(parentId);
    if (!p) return;

    if (msg.channel === 'shell' || msg.channel === 'control') {
      p.replied = msg;
      this.maybeDone(parentId, p);
      return;
    }
    if (msg.channel === 'stdin') {
      // 我们发的是 allow_stdin=false，正常不会收到；万一收到（老内核 / 自定义内核），
      // 不回复内核会一直等输入：给出提示并中断执行
      if (type === 'input_request' && !p.stdinRefused) {
        p.stdinRefused = true;
        p.handlers?.onOutput(stdinHintOutput());
        void this.client.interrupt(this.kernelId).catch(() => undefined);
      }
      return;
    }
    if (msg.channel !== 'iopub') return;
    const c = msg.content as Record<string, unknown>;
    if (p.stdout) {
      if (type === 'stream' && c.name === 'stdout') p.stdout.push(String(c.text ?? ''));
      return;
    }
    const h = p.handlers;
    if (!h) return;
    switch (type) {
      case 'execute_input':
        if (typeof c.execution_count === 'number') {
          this.executionCount = c.execution_count;
          h.onStart?.(c.execution_count);
        }
        break;
      case 'stream':
        h.onOutput({
          output_type: 'stream',
          name: c.name === 'stderr' ? 'stderr' : 'stdout',
          text: String(c.text ?? ''),
        });
        break;
      case 'display_data':
        h.onOutput({
          output_type: 'display_data',
          data: (c.data as Record<string, unknown>) ?? {},
          metadata: (c.metadata as Record<string, unknown>) ?? {},
          ...(c.transient && (c.transient as { display_id?: string }).display_id
            ? { transient: { display_id: (c.transient as { display_id: string }).display_id } }
            : {}),
        });
        break;
      case 'update_display_data': {
        const id = (c.transient as { display_id?: string } | undefined)?.display_id;
        if (id) {
          h.onUpdateDisplay(id, {
            output_type: 'display_data',
            data: (c.data as Record<string, unknown>) ?? {},
            metadata: (c.metadata as Record<string, unknown>) ?? {},
            transient: { display_id: id },
          });
        }
        break;
      }
      case 'execute_result':
        h.onOutput({
          output_type: 'execute_result',
          execution_count: (c.execution_count as number | null) ?? null,
          data: (c.data as Record<string, unknown>) ?? {},
          metadata: (c.metadata as Record<string, unknown>) ?? {},
        });
        break;
      case 'error': {
        const ename = String(c.ename ?? '');
        // input() / getpass() 在 allow_stdin=false 时抛 StdinNotImplementedError（英文、看不懂）
        if (ename === 'StdinNotImplementedError') {
          if (!p.stdinRefused) h.onOutput(stdinHintOutput());
          p.stdinRefused = true;
          break;
        }
        // 我们为拒绝 input() 而发的中断，不再额外显示 KeyboardInterrupt
        if (p.stdinRefused && ename === 'KeyboardInterrupt') break;
        h.onOutput({
          output_type: 'error',
          ename,
          evalue: String(c.evalue ?? ''),
          traceback: Array.isArray(c.traceback) ? (c.traceback as string[]) : [],
        });
        break;
      }
      case 'clear_output':
        h.onClear(!!c.wait);
        break;
      default:
        break;
    }
  }

  /** reply 和 iopub idle 都到了才算结束（保证输出收全） */
  private maybeDone(id: string, p: Pending) {
    if (!p.replied) return;
    // 没有 iopub 的请求（complete / inspect / kernel_info）只等 reply
    if (!p.handlers && !p.stdout) {
      this.pending.delete(id);
      p.resolveReply(p.replied);
      return;
    }
    if (!p.idle) return;
    this.pending.delete(id);
    p.resolveReply(p.replied);
  }

  /** 发一条 shell 请求并等回复（不收集 iopub） */
  request<C = Record<string, unknown>>(
    msgType: string,
    content: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<JupyterMessage<C>> {
    const msg = makeMessage(this.sessionId, 'shell', msgType, content);
    return this.track(msg, {}, timeoutMs) as Promise<JupyterMessage<C>>;
  }

  private track(
    msg: JupyterMessage,
    extra: Pick<Pending, 'handlers' | 'stdout'>,
    timeoutMs: number,
  ): Promise<JupyterMessage> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(msg.header.msg_id);
              reject(new Error(`内核没有响应（${msg.header.msg_type}）`));
            }, timeoutMs)
          : null;
      this.pending.set(msg.header.msg_id, {
        ...extra,
        idle: false,
        resolveReply: (m) => {
          if (timer) clearTimeout(timer);
          resolve(m);
        },
        rejectReply: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send(msg);
      } catch (err) {
        this.pending.delete(msg.header.msg_id);
        if (timer) clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async execute(code: string, handlers: ExecuteHandlers): Promise<ExecuteResult> {
    const msg = makeMessage(this.sessionId, 'shell', 'execute_request', {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    });
    const reply = await this.track(msg, { handlers }, 0);
    const c = reply.content as { status?: string; execution_count?: number };
    if (typeof c.execution_count === 'number') this.executionCount = c.execution_count;
    return {
      status: c.status === 'ok' ? 'ok' : c.status === 'aborted' ? 'aborted' : 'error',
      executionCount: c.execution_count ?? null,
    };
  }

  /** 静默执行，返回 stdout（不进历史、不改执行计数） */
  async runSilent(code: string, timeoutMs = 30_000): Promise<string> {
    const stdout: string[] = [];
    const msg = makeMessage(this.sessionId, 'shell', 'execute_request', {
      code,
      silent: false,
      store_history: false,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: false,
    });
    await this.track(msg, { stdout }, timeoutMs);
    return stdout.join('');
  }

  async complete(code: string, cursorPos: number) {
    const r = await this.request<{
      matches: string[];
      cursor_start: number;
      cursor_end: number;
      metadata?: Record<string, unknown>;
    }>('complete_request', { code, cursor_pos: cursorPos }, 10_000);
    return r.content;
  }

  async inspect(code: string, cursorPos: number, detailLevel = 0) {
    const r = await this.request<{ found: boolean; data: Record<string, unknown> }>(
      'inspect_request',
      { code, cursor_pos: cursorPos, detail_level: detailLevel },
      10_000,
    );
    return r.content;
  }

  close() {
    this.closedByUs = true;
    this.failAll(new Error('内核已关闭'));
    this.ws?.close();
    this.ws = null;
  }
}
