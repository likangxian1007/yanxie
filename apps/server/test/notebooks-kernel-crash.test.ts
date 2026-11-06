import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import * as Y from 'yjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActorRef, NbOutput, Notebook } from '@srh/shared';
import { withLiveDocument } from '../src/realtime/collab';
import { findCell, readNotebook } from '../src/modules/notebooks/nbformat';
import { setKernelManager } from '../src/modules/notebooks';
import { KernelGatewayClient, type JupyterMessage } from '../src/modules/notebooks/kernel/gateway';
import type { KernelContainer, KernelHost } from '../src/modules/notebooks/kernel/host';
import { KernelManager } from '../src/modules/notebooks/kernel/manager';
import { defaultExecutionRunners } from '../src/modules/research/execution-runners';
import { STDIN_HINT } from '../src/modules/notebooks/kernel/session';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

/**
 * 内核崩溃（OOM 等）后的恢复：用假的 Kernel Gateway（REST + WS 都在内存里）模拟内核在执行中死掉。
 *
 * 假内核认识这些“代码”：
 *   print(X)  输出 X
 *   BOOM      内存超限：容器 OOM 计数 +1，iopub 发 restarting，执行请求永远没有回复
 *   HANG      一直执行（网关状态 busy），不回复
 *   LOST      不回复，但网关状态一直是 idle（请求在内核重启时丢了）
 *   input()   ipykernel 在 allow_stdin=false 时抛 StdinNotImplementedError
 *   ASK       内核发 stdin input_request（老内核），被中断后报 KeyboardInterrupt
 */
const SYSTEM: ActorRef = { kind: 'system', id: null, name: '研协' };

class FakeWs extends EventEmitter {
  closed = false;
  constructor(
    private readonly gw: FakeGateway,
    readonly kernelId: string,
  ) {
    super();
    setImmediate(() => this.emit('open'));
  }
  send(raw: string) {
    const msg = JSON.parse(raw) as JupyterMessage;
    setImmediate(() => this.gw.handle(this, msg));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => this.emit('close'));
  }
  push(channel: JupyterMessage['channel'], type: string, parent: string | null, content: object) {
    if (this.closed) return;
    const msg: JupyterMessage = {
      header: {
        msg_id: randomUUID(),
        msg_type: type,
        session: 'k',
        username: 'k',
        date: new Date().toISOString(),
        version: '5.3',
      },
      parent_header: parent ? { msg_id: parent } : {},
      metadata: {},
      content: content as Record<string, unknown>,
      channel,
    };
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

class FakeGateway extends KernelGatewayClient {
  started = 0;
  readonly states = new Map<string, string | null>();
  readonly shutdowns: string[] = [];
  readonly interrupts: string[] = [];
  readonly sockets = new Map<string, FakeWs>();
  private readonly counts = new Map<string, number>();
  /** 等 ASK 被中断的执行：kernelId → parent msg_id */
  private readonly asking = new Map<string, string>();
  onOom: () => void = () => undefined;

  constructor() {
    super({ baseUrl: 'http://fake-gateway', token: '' });
  }
  override async startKernel(): Promise<string> {
    this.started += 1;
    const id = `k${this.started}`;
    this.states.set(id, 'idle');
    return id;
  }
  override async kernelState(id: string): Promise<string | null> {
    return this.states.has(id) ? this.states.get(id)! : null;
  }
  override async shutdown(id: string) {
    this.shutdowns.push(id);
    this.states.delete(id);
  }
  override async interrupt(id: string) {
    this.interrupts.push(id);
    const parent = this.asking.get(id);
    const ws = this.sockets.get(id);
    if (parent && ws) {
      this.asking.delete(id);
      setImmediate(() => {
        ws.push('iopub', 'error', parent, {
          ename: 'KeyboardInterrupt',
          evalue: '',
          traceback: ['KeyboardInterrupt'],
        });
        this.finish(ws, parent, 'error');
      });
    }
    return undefined;
  }
  override connect(id: string): WebSocket {
    const ws = new FakeWs(this, id);
    this.sockets.set(id, ws);
    return ws as unknown as WebSocket;
  }

  private finish(ws: FakeWs, parent: string, status: 'ok' | 'error', count?: number) {
    ws.push('shell', 'execute_reply', parent, {
      status,
      ...(count !== undefined ? { execution_count: count } : {}),
    });
    ws.push('iopub', 'status', parent, { execution_state: 'idle' });
    if (this.states.has(ws.kernelId)) this.states.set(ws.kernelId, 'idle');
  }

  handle(ws: FakeWs, msg: JupyterMessage) {
    const id = ws.kernelId;
    const parent = msg.header.msg_id;
    const type = msg.header.msg_type;
    if (type === 'kernel_info_request') {
      ws.push('shell', 'kernel_info_reply', parent, { status: 'ok' });
      return;
    }
    if (type !== 'execute_request') {
      ws.push('shell', `${type.replace(/_request$/, '')}_reply`, parent, { status: 'ok' });
      return;
    }
    const c = msg.content as { code: string; store_history: boolean };
    ws.push('iopub', 'status', parent, { execution_state: 'busy' });
    if (!c.store_history) {
      // 启动代码 / 变量查看器
      this.finish(ws, parent, 'ok');
      return;
    }
    const code = c.code.trim();
    const n = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, n);
    ws.push('iopub', 'execute_input', parent, { code, execution_count: n });
    if (code === 'BOOM') {
      this.states.set(id, 'restarting');
      this.onOom();
      setTimeout(() => ws.push('iopub', 'status', null, { execution_state: 'restarting' }), 20);
      return;
    }
    if (code === 'HANG') {
      this.states.set(id, 'busy');
      return;
    }
    if (code === 'LOST') return; // 状态保持 idle
    if (code === 'input()') {
      ws.push('iopub', 'error', parent, {
        ename: 'StdinNotImplementedError',
        evalue: 'raw_input was called, but this frontend does not support input requests.',
        traceback: ['StdinNotImplementedError: raw_input was called'],
      });
      this.finish(ws, parent, 'error', n);
      return;
    }
    if (code === 'ASK') {
      this.asking.set(id, parent);
      ws.push('stdin', 'input_request', parent, { prompt: '名字？', password: false });
      return;
    }
    const m = /^print\((.*)\)$/.exec(code);
    if (m) ws.push('iopub', 'stream', parent, { name: 'stdout', text: `${m[1]}\n` });
    this.finish(ws, parent, 'ok', n);
  }
}

interface FakeHost extends KernelHost {
  kills: number;
  removed: string[];
  containers: KernelContainer[];
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    mode: 'docker',
    kills: 0,
    removed: [],
    containers: [],
    endpoint: async () => ({ baseUrl: 'http://fake-gateway', token: '' }),
    release: async () => undefined,
    oomState: async () => ({ kills: host.kills, oomKilled: host.kills > 0 }),
    remove: async (projectId) => {
      host.removed.push(projectId);
    },
    list: async () => host.containers,
  };
  return host;
}

describe('notebooks: kernel crash recovery', () => {
  let t: TestApp;
  let owner: Session;
  let pid: string;
  let actor: ActorRef;
  const managers: KernelManager[] = [];

  beforeAll(async () => {
    t = await makeApp({ KERNEL_MEMORY_MB: '2048' });
    const s = await setupProject(t.app, []);
    owner = s.owner;
    pid = s.project.id;
    actor = { kind: 'user', id: owner.user.id, name: owner.user.name };
  }, 60_000);
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.close();
  });
  afterAll(() => t.close(), 60_000);

  const setup = async (sources: string[], watchdogMs = 0) => {
    const gw = new FakeGateway();
    const host = fakeHost();
    gw.onOom = () => {
      host.kills += 1;
    };
    const mgr = new KernelManager(t.app.ctx, host, { clientFactory: () => gw, watchdogMs });
    managers.push(mgr);
    const ids = sources.map((_, i) => `c${i}`);
    const nb = (
      await owner.req('POST', `/projects/${pid}/notebooks`, {
        title: 'crash',
        ipynb: {
          cells: sources.map((source, i) => ({ id: ids[i], cell_type: 'code', source })),
        },
      })
    ).json<Notebook>();
    return { gw, host, mgr, nb, ids };
  };

  const state = (nbId: string) =>
    withLiveDocument(t.app.ctx, nbId, SYSTEM, (doc) => ({
      outputs: Object.fromEntries(readNotebook(doc).cells.map((c) => [c.id, c.outputs])) as Record<
        string,
        NbOutput[]
      >,
      runs: doc.getMap('runs').toJSON() as Record<string, unknown>,
      kernel: doc.getMap('kernel').toJSON() as { status?: string; error?: string | null },
    }));

  const until = async (pred: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('等待超时');
      await sleep(20);
    }
  };

  const textOf = (outs: NbOutput[] | undefined) =>
    (outs ?? []).map((o) => (o.output_type === 'stream' ? o.text : '')).join('');
  const errorOf = (outs: NbOutput[] | undefined) => {
    const e = (outs ?? []).find((o) => o.output_type === 'error');
    return e && e.output_type === 'error' ? e : null;
  };

  it('frozen execution uses the queued source even if the snapshot notebook is edited', async () => {
    const { host, mgr, nb, ids } = await setup(['print(1)']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.endpoint = async () => {
      await gate;
      return { baseUrl: 'http://fake-gateway', token: '' };
    };
    await mgr.enqueueFrozen(nb.id, pid, [{ id: ids[0]!, source: 'print(1)' }], actor);
    await withLiveDocument(t.app.ctx, nb.id, actor, (doc) => {
      const source = findCell(doc, ids[0]!)?.cell.get('source');
      if (!(source instanceof Y.Text)) throw new Error('缺少单元格正文');
      source.delete(0, source.length);
      source.insert(0, 'print(2)');
    });
    release();
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    expect(textOf((await state(nb.id)).outputs.c0)).toBe('1\n');
  });

  it('research execution uses its own notebook and returns actual kernel output', async () => {
    const { mgr, nb, ids } = await setup(['print(999)']);
    setKernelManager(t.app.ctx, mgr);
    let copyId = '';
    const result = await defaultExecutionRunners.notebook(
      t.app.ctx,
      actor,
      pid,
      {
        definition: {
          itemId: 'action',
          itemVersion: 1,
          title: '计算',
          dependsOn: [],
          action: {
            kind: 'notebook',
            instructions: '',
            inputItemIds: [],
            notebookId: nb.id,
            cellIds: ids,
            model: null,
            effort: null,
            profile: null,
          },
          notebook: {
            notebookId: nb.id,
            cells: [{ id: ids[0]!, source: 'print(1)' }],
            hash: 'frozen',
          },
        },
        inputs: [],
        upstream: [],
      },
      new AbortController().signal,
      async (id) => {
        copyId = id;
      },
    );
    expect(copyId).not.toBe(nb.id);
    expect(result.outputs[0]?.origin).toBe('computation');
    expect(result.outputs[0]?.content).toContain('1\\n');
    expect((await state(nb.id)).outputs.c0).toEqual([]);
  });

  it('OOM mid-run: running cell errors, queued cells fail, kernel auto-restarts', async () => {
    const { gw, mgr, nb, ids } = await setup(['print(1)', 'BOOM', 'print(3)', 'print(4)']);
    await mgr.enqueue(nb.id, pid, ids, actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);

    const s = await state(nb.id);
    expect(textOf(s.outputs.c0)).toBe('1\n');
    const crash = errorOf(s.outputs.c1);
    expect(crash?.evalue).toBe(
      '内核已崩溃（内存超过上限 2048 MB），已自动重启，之前的变量已清空。',
    );
    for (const id of ['c2', 'c3']) {
      const e = errorOf(s.outputs[id]);
      expect(e?.ename).toBe('DeadKernelError');
      expect(e?.evalue).toContain('没有运行');
      expect(e?.evalue).toContain('内存超过上限 2048 MB');
    }
    // 没有单元格还挂在队列里
    expect(s.runs).toEqual({});

    // 自动重启：旧内核被关掉，新内核就绪，状态广播到 Y.Doc
    await until(() => mgr.kernelStatus(nb.id) === 'idle');
    expect(gw.started).toBe(2);
    expect(gw.shutdowns).toContain('k1');
    const after = await state(nb.id);
    expect(after.kernel.status).toBe('idle');
    expect(after.kernel.error).toContain('内存超过上限 2048 MB');

    // 之后的运行正常
    await mgr.enqueue(nb.id, pid, ['c2'], actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    const again = await state(nb.id);
    expect(textOf(again.outputs.c2)).toBe('3\n');
    expect(errorOf(again.outputs.c2)).toBeNull();
    expect(again.kernel.error).toBeNull();
  }, 30_000);

  it('watchdog notices a dead kernel without iopub status (generic message)', async () => {
    const { gw, mgr, nb, ids } = await setup(['HANG', 'print(2)'], 30);
    await mgr.enqueue(nb.id, pid, ids, actor);
    await until(() => gw.states.get('k1') === 'busy');
    gw.states.set('k1', 'dead');
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    const s = await state(nb.id);
    expect(errorOf(s.outputs.c0)?.evalue).toBe('内核意外退出，已自动重启，之前的变量已清空。');
    expect(errorOf(s.outputs.c1)?.ename).toBe('DeadKernelError');
    expect(s.runs).toEqual({});
    await until(() => mgr.kernelStatus(nb.id) === 'idle');
    await mgr.enqueue(nb.id, pid, ['c1'], actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    expect(textOf((await state(nb.id)).outputs.c1)).toBe('2\n');
  }, 30_000);

  it('watchdog: gateway idle while our request never returns = lost', async () => {
    const { mgr, nb, ids } = await setup(['LOST'], 20);
    await mgr.enqueue(nb.id, pid, ids, actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    const s = await state(nb.id);
    expect(errorOf(s.outputs.c0)?.ename).toBe('DeadKernelError');
    await until(() => mgr.kernelStatus(nb.id) === 'idle');
  }, 30_000);

  it('interrupt on a restarting kernel restarts it instead of pretending', async () => {
    const { gw, mgr, nb, ids } = await setup(['HANG', 'print(2)']);
    await mgr.enqueue(nb.id, pid, ids, actor);
    await until(() => gw.states.get('k1') === 'busy');
    gw.states.set('k1', 'restarting'); // iopub 消息丢了，只有网关知道
    await mgr.interrupt(nb.id);
    expect(gw.interrupts).toEqual([]);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    const s = await state(nb.id);
    expect(errorOf(s.outputs.c0)?.ename).toBe('DeadKernelError');
    expect(errorOf(s.outputs.c1)?.ename).toBe('DeadKernelError');
    await until(() => mgr.kernelStatus(nb.id) === 'idle');
    expect(gw.started).toBe(2);
  }, 30_000);

  it('input() shows a Chinese hint instead of StdinNotImplementedError', async () => {
    const { gw, mgr, nb, ids } = await setup(['input()', 'ASK']);
    await mgr.enqueue(nb.id, pid, [ids[0]!], actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    let s = await state(nb.id);
    expect(s.outputs.c0).toHaveLength(1);
    expect(errorOf(s.outputs.c0)?.evalue).toBe(STDIN_HINT);

    // 老内核真的发来 input_request：提示 + 中断，不显示 KeyboardInterrupt，也不会卡住
    await mgr.enqueue(nb.id, pid, [ids[1]!], actor);
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    s = await state(nb.id);
    expect(gw.interrupts).toEqual(['k1']);
    expect(s.outputs.c1).toHaveLength(1);
    expect(errorOf(s.outputs.c1)?.evalue).toBe(STDIN_HINT);
    expect(mgr.kernelStatus(nb.id)).toBe('idle');
  }, 30_000);
});

describe('notebooks: kernel containers of archived projects', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeApp();
  }, 60_000);
  afterAll(() => t.close(), 60_000);

  it('archiving a project shuts its kernels down and removes the container', async () => {
    const { owner, project } = await setupProject(t.app, []);
    const gw = new FakeGateway();
    const host = fakeHost();
    const mgr = new KernelManager(t.app.ctx, host, { clientFactory: () => gw, watchdogMs: 0 });
    setKernelManager(t.app.ctx, mgr); // 归档钩子用的是本进程的调度器
    const nb = (
      await owner.req('POST', `/projects/${project.id}/notebooks`, {
        title: 'a',
        ipynb: { cells: [{ id: 'x', cell_type: 'code', source: 'print(1)' }] },
      })
    ).json<Notebook>();
    await mgr.enqueue(nb.id, project.id, ['x'], {
      kind: 'user',
      id: owner.user.id,
      name: owner.user.name,
    });
    expect(await mgr.waitIdle(nb.id, 10_000)).toBe(true);
    expect(mgr.kernelStatus(nb.id)).toBe('idle');

    expect((await owner.req('DELETE', `/projects/${project.id}`)).statusCode).toBe(204);
    const deadline = Date.now() + 5000;
    while (!host.removed.includes(project.id) && Date.now() < deadline) await sleep(20);
    expect(host.removed).toEqual([project.id]);
    expect(gw.shutdowns).toContain('k1');
    expect(mgr.kernelStatus(nb.id)).toBe('none');
  }, 30_000);

  it('periodic sweep removes containers of archived / missing projects only', async () => {
    const live = await setupProject(t.app, []);
    const gone = await setupProject(t.app, []);
    expect((await gone.owner.req('DELETE', `/projects/${gone.project.id}`)).statusCode).toBe(204);
    const host = fakeHost();
    host.containers = [
      { name: `srh-kernel-${live.project.id}`, projectId: live.project.id, running: true },
      { name: `srh-kernel-${gone.project.id}`, projectId: gone.project.id, running: true },
      { name: 'srh-kernel-p_deleted', projectId: 'p_deleted', running: false },
      { name: 'srh-kernel-unknown', projectId: null, running: true },
    ];
    const mgr = new KernelManager(t.app.ctx, host, { watchdogMs: 0 });
    try {
      const removed = await mgr.sweepOrphanContainers();
      expect(removed.sort()).toEqual([gone.project.id, 'p_deleted'].sort());
      expect(host.removed.sort()).toEqual([gone.project.id, 'p_deleted'].sort());
    } finally {
      await mgr.close();
    }
  }, 30_000);
});
