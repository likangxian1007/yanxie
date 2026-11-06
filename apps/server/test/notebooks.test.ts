import { inflateRawSync } from 'node:zlib';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Notebook } from '@srh/shared';
import { liveDocument } from '../src/realtime/collab';
import {
  exportNotebook,
  highlightPython,
  renderMarkdown,
  toMarkdown,
  toPy,
  zip,
} from '../src/modules/notebooks/export';
import { fixConsole } from '../src/modules/notebooks/kernel/output';
import {
  fromIpynb,
  readNotebook,
  replaceNotebook,
  toIpynb,
} from '../src/modules/notebooks/nbformat';
import { kernelManager } from '../src/modules/notebooks';
import { eq } from 'drizzle-orm';
import { agentSessions, projects, threads } from '../src/db/schema';
import { createProjectThread } from '../src/modules/threads/service';
import { createMessage } from '../src/modules/timeline/service';
import { toolsFor } from '../src/agents/tools/index';
import { notebookTools } from '../src/agents/tools/notebooks';
import type { ToolContext } from '../src/agents/tools/types';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const SAMPLE = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  cells: [
    { id: 'md1', cell_type: 'markdown', metadata: {}, source: ['# 标题\n', '公式 $a^2+b^2=c^2$'] },
    {
      id: 'c1',
      cell_type: 'code',
      metadata: { collapsed: false },
      execution_count: 3,
      source: ['import numpy as np\n', 'print("hi")\n', 'np.arange(3)'],
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
        {
          output_type: 'execute_result',
          execution_count: 3,
          metadata: {},
          data: { 'text/plain': ['array([0, 1, 2])'] },
        },
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG_1PX, 'text/plain': ['<Figure>'] },
        },
      ],
    },
    {
      id: 'c2',
      cell_type: 'code',
      metadata: {},
      execution_count: 4,
      source: '1/0',
      outputs: [
        {
          output_type: 'error',
          ename: 'ZeroDivisionError',
          evalue: 'division by zero',
          traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'],
        },
      ],
    },
    { id: 'r1', cell_type: 'raw', metadata: {}, source: 'raw text' },
  ],
};

describe('notebooks: nbformat', () => {
  it('round-trips .ipynb through the Y.Doc layout', () => {
    const nb = fromIpynb(SAMPLE);
    const doc = new Y.Doc();
    doc.transact(() => replaceNotebook(doc, nb));
    const back = toIpynb(readNotebook(doc)) as typeof SAMPLE;
    expect(back.cells.map((c) => c.id)).toEqual(['md1', 'c1', 'c2', 'r1']);
    expect(back.cells[1]).toMatchObject({
      execution_count: 3,
      source: ['import numpy as np\n', 'print("hi")\n', 'np.arange(3)'],
    });
    const outs = (back.cells[1] as { outputs: { output_type: string }[] }).outputs;
    expect(outs.map((o) => o.output_type)).toEqual(['stream', 'execute_result', 'display_data']);
    // 再导入一遍结果不变
    expect(toIpynb(fromIpynb(JSON.stringify(back)))).toEqual(back);
  });

  it('rejects invalid files with a readable message', () => {
    expect(() => fromIpynb('not json')).toThrow(/JSON/);
    expect(() => fromIpynb({ worksheets: [] })).toThrow(/nbformat 3/);
    expect(() => fromIpynb({})).toThrow(/cells/);
  });

  it('dedupes / regenerates bad cell ids', () => {
    const nb = fromIpynb({
      cells: [
        { id: 'x', cell_type: 'code', source: '' },
        { id: 'x', cell_type: 'code', source: '' },
        { id: 'bad id!', cell_type: 'code', source: '' },
      ],
    });
    const ids = nb.cells.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('x');
  });

  it('applies carriage-return semantics like a terminal', () => {
    expect(fixConsole('10%\r50%\r100%\ndone\n')).toBe('100%\ndone\n');
    expect(fixConsole('a\r\nb')).toBe('a\nb');
  });
});

describe('notebooks: export', () => {
  const nb = fromIpynb(SAMPLE);

  it('py uses percent format', () => {
    const py = toPy(nb, '实验');
    expect(py).toContain('# %% [markdown]\n# # 标题');
    expect(py).toContain('# %%\nimport numpy as np');
  });

  it('md embeds images and outputs', () => {
    const md = toMarkdown(nb, '实验');
    expect(md).toContain('```python\nimport numpy');
    expect(md).toContain('array([0, 1, 2])');
    expect(md).toContain('data:image/png;base64,');
    expect(md).toContain('ZeroDivisionError: division by zero');
    expect(md).not.toContain('\u001b');
  });

  it('html renders prompts, math, images and traceback', async () => {
    const file = await exportNotebook(nb, '实验', 'html');
    const html = file.body.toString('utf8');
    expect(html).toContain('In [3]:');
    expect(html).toContain('Out[3]:');
    expect(html).toContain('<math');
    expect(html).toContain('data:image/png;base64');
    expect(html).toContain('color:#c4302b');
    expect(highlightPython('def f(): return "x"  # c')).toContain('<span class="k">def</span>');
    expect(renderMarkdown('$$x$$')).toContain('display="block"');
  });

  it('zip bundles every format with images as files', async () => {
    const file = await exportNotebook(nb, '实验', 'zip', { chromiumPath: null });
    const names = listZip(file.body);
    expect(names).toEqual(
      expect.arrayContaining(['实验/实验.ipynb', '实验/实验.py', '实验/实验.md', '实验/实验.html']),
    );
    expect(names.some((n) => /^实验\/images\/cell-c1-1\.png$/.test(n))).toBe(true);
    const md = readZipEntry(file.body, '实验/实验.md');
    expect(md).toContain('](images/cell-c1-1.png)');
  });

  it('html export strips scripts and event handlers from outputs and markdown', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const evil = fromIpynb({
      cells: [
        {
          id: 'm',
          cell_type: 'markdown',
          source: `# 说明\n\n<a href="javascript:alert(3)">点我</a>${payload}`,
        },
        {
          id: 'h',
          cell_type: 'code',
          source: 'display(HTML(x))',
          execution_count: 1,
          outputs: [
            {
              output_type: 'display_data',
              metadata: {},
              data: {
                'text/html': [
                  `${payload}<table><tr><td style="color:red" title='a"onmouseover=alert(4)'>1</td></tr></table>`,
                  '<iframe srcdoc="<script>alert(5)</script>"></iframe><svg><style><img src=x onerror=alert(6)></style></svg>',
                  '<a href=" jav&#x09;ascript:alert(7)">x</a><img src="data:image/png;base64,AAAA">',
                ],
              },
            },
            {
              output_type: 'display_data',
              metadata: {},
              data: {
                'image/svg+xml':
                  '<svg onload="alert(8)"><a xlink:href="javascript:alert(9)">s</a></svg>',
              },
            },
          ],
        },
      ],
    });
    const html = (await exportNotebook(evil, 'xss', 'html')).body.toString('utf8');
    const body = html.slice(html.indexOf('<main>'));
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<iframe/i);
    expect(body).not.toMatch(/\son\w+\s*=/i);
    expect(body).not.toMatch(/javascript:/i);
    for (const n of [1, 2, 3, 5, 6, 7, 8, 9]) expect(body).not.toContain(`alert(${n})`);
    // 属性值里的引号被转义，不能借此注入新属性
    expect(body).toContain('title="a&quot;onmouseover=alert(4)"');
    // 正常内容保留
    expect(body).toContain('<td style="color:red"');
    expect(body).toContain('src="data:image/png;base64,AAAA"');
    expect(body).toContain('点我');
    expect(html).toContain('Content-Security-Policy');
  });

  it('writes valid zip entries', () => {
    const z = zip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }]);
    expect(readZipEntry(z, 'a.txt')).toBe('hello hello hello hello');
  });
});

function listZip(buf: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'));
    i += 30 + nameLen + extra + size;
  }
  return names;
}

function readZipEntry(buf: Buffer, name: string): string {
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const n = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const body = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    if (n === name) return (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    i += 30 + nameLen + extra + size;
  }
  throw new Error(`no entry ${name}`);
}

describe('notebooks: REST', () => {
  let t: TestApp;
  let owner: Session;
  let guest: Session;
  let pid: string;

  beforeAll(async () => {
    t = await makeApp();
    const s = await setupProject(t.app, ['guest']);
    owner = s.owner;
    guest = s.others[0]!;
    pid = s.project.id;
  }, 60_000);
  afterAll(() => t.close(), 60_000);

  it('creates, lists, imports, exports and deletes', async () => {
    const created = await owner.req('POST', `/projects/${pid}/notebooks`, { title: '训练曲线' });
    expect(created.statusCode).toBe(201);
    const nb = created.json<Notebook>();
    expect(nb).toMatchObject({ title: '训练曲线', cellCount: 1, language: 'python' });

    const list = await guest.req('GET', `/projects/${pid}/notebooks`);
    expect(list.json<Notebook[]>().map((n) => n.id)).toContain(nb.id);
    expect((await guest.req('POST', `/projects/${pid}/notebooks`, {})).statusCode).toBe(403);

    const imp = await owner.req('POST', `/projects/${pid}/notebooks/${nb.id}/import`, {
      ipynb: SAMPLE,
    });
    expect(imp.statusCode).toBe(200);
    expect(imp.json<Notebook>().cellCount).toBe(4);

    const exp = await guest.req('GET', `/projects/${pid}/notebooks/${nb.id}/export?format=ipynb`);
    expect(exp.statusCode).toBe(200);
    const back = JSON.parse(exp.body) as typeof SAMPLE;
    expect(back.cells.map((c) => c.id)).toEqual(['md1', 'c1', 'c2', 'r1']);

    const fromFile = await owner.req('POST', `/projects/${pid}/notebooks`, {
      title: '导入',
      ipynb: JSON.stringify(SAMPLE),
    });
    expect(fromFile.json<Notebook>().cellCount).toBe(4);

    const bad = await owner.req('POST', `/projects/${pid}/notebooks`, { ipynb: '{"x":1}' });
    expect(bad.statusCode).toBe(422);

    const run = await owner.req('POST', `/projects/${pid}/notebooks/${nb.id}/execute`, {});
    expect(run.statusCode).toBe(501); // 测试环境没有内核

    expect((await owner.req('DELETE', `/projects/${pid}/notebooks/${nb.id}`)).statusCode).toBe(204);
    expect((await owner.req('GET', `/projects/${pid}/notebooks/${nb.id}`)).statusCode).toBe(404);
  }, 60_000);
});

// ---------------------------------------------------------------- 真实内核（需要本地 Kernel Gateway）

const GATEWAY = process.env.SRH_TEST_KERNEL_GATEWAY ?? '';

describe.skipIf(!GATEWAY)('notebooks: live kernel', () => {
  let t: TestApp;
  let owner: Session;
  let pid: string;

  beforeAll(async () => {
    t = await makeApp({
      KERNEL_MODE: 'gateway',
      KERNEL_GATEWAY_URL: GATEWAY,
      KERNEL_IDLE_MINUTES: '0',
    });
    const s = await setupProject(t.app, []);
    owner = s.owner;
    pid = s.project.id;
  }, 60_000);
  afterAll(() => t.close(), 60_000);

  it('runs cells, streams outputs, records metrics, survives errors', async () => {
    const ipynb = {
      cells: [
        { id: 'a', cell_type: 'code', source: 'x = 41\nprint("hello")\nx + 1' },
        {
          id: 'b',
          cell_type: 'code',
          source:
            'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.show()\nimport srh\nsrh.log_param("lr", 0.001)\nsrh.log_metric("acc", 0.93)',
        },
        { id: 'c', cell_type: 'code', source: 'raise ValueError("boom")' },
        { id: 'd', cell_type: 'code', source: 'print("never")' },
      ],
    };
    const nb = (
      await owner.req('POST', `/projects/${pid}/notebooks`, {
        title: 'live',
        ipynb,
      })
    ).json<Notebook>();

    const run = await owner.req('POST', `/projects/${pid}/notebooks/${nb.id}/execute`, {
      cellIds: [],
    });
    expect(run.statusCode).toBe(200);
    expect(run.json<{ runs: unknown[] }>().runs).toHaveLength(4);
    expect(await kernelManager(t.app.ctx).waitIdle(nb.id, 120_000)).toBe(true);

    const md = (await owner.req('GET', `/projects/${pid}/notebooks/${nb.id}/export?format=ipynb`))
      .body;
    const cells = (
      JSON.parse(md) as {
        cells: {
          id: string;
          execution_count: number | null;
          outputs: {
            output_type: string;
            text?: string[];
            data?: Record<string, unknown>;
            ename?: string;
          }[];
        }[];
      }
    ).cells;
    const [a, b, c, d] = cells;
    expect(a!.execution_count).toBe(1);
    expect(a!.outputs[0]).toMatchObject({ output_type: 'stream', text: ['hello\n'] });
    expect(a!.outputs[1]!.data!['text/plain']).toEqual(['42']);
    expect(b!.outputs.some((o) => o.data?.['image/png'])).toBe(true);
    expect(c!.outputs[0]).toMatchObject({ output_type: 'error', ename: 'ValueError' });
    expect(d!.execution_count).toBeNull(); // 前一个出错，后面的被取消

    const vars = await owner.req('GET', `/projects/${pid}/notebooks/${nb.id}/variables`);
    expect(vars.json<{ variables: { name: string; summary: string }[] }>().variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'x', summary: '41' })]),
    );

    const exported = await owner.req(
      'GET',
      `/projects/${pid}/notebooks/${nb.id}/export?format=ipynb`,
    );
    expect(exported.body).toContain('0.93');
    expect(exported.body).toContain('0.001');

    const restart = await owner.req('POST', `/projects/${pid}/notebooks/${nb.id}/restart`, {
      clearOutputs: true,
    });
    expect(restart.statusCode).toBe(200);
    expect(liveDocument(t.app.ctx, nb.id)).toBeNull();
  }, 180_000);

  it('agent tools edit and run cells like a member', async () => {
    const ctx = t.app.ctx;
    const ownerRef = { kind: 'user' as const, id: owner.user.id, name: owner.user.name };
    const root = await createMessage(ctx, {
      projectId: pid,
      threadId: null,
      author: ownerRef,
      body: '帮我画一下 loss 曲线',
    });
    const { thread, sessionId } = await createProjectThread(ctx, {
      projectId: pid,
      rootMessageId: root.id,
      title: '画曲线',
      workingForUserId: owner.user.id,
      actor: ownerRef,
    });
    const [threadRow] = await t.db.db.select().from(threads).where(eq(threads.id, thread.id));
    const [sessionRow] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    const [projectRow] = await t.db.db.select().from(projects).where(eq(projects.id, pid));
    const tc: ToolContext = {
      ctx,
      session: sessionRow!,
      project: projectRow!,
      thread: threadRow!,
      turnId: 'turn_nb',
      actor: { kind: 'agent', id: sessionId, name: '研协' },
      requesterUserId: owner.user.id,
      visible: new Set(),
      setActivity: async () => {},
    };
    const call = (name: string, args: Record<string, unknown>) => {
      const def = notebookTools.find((d) => d.name === name)!;
      return def.run(tc, def.schema.parse(args)) as Promise<Record<string, unknown>>;
    };
    expect(toolsFor(ctx, 'thread').map((d) => d.name)).toContain('run_notebook_cells');

    const edit = await call('edit_notebook', {
      ops: [
        { op: 'insert', type: 'markdown', source: '# Loss 曲线' },
        {
          op: 'insert',
          source:
            'import matplotlib.pyplot as plt\nimport srh\nloss=[1.0,0.6,0.4]\nplt.plot(loss)\nplt.show()\nsrh.log_metric("final_loss", loss[-1])\nprint("done", len(loss))',
        },
      ],
    });
    expect(edit).toMatchObject({ ok: true, created: true });
    const nbId = edit.notebook_id as string;

    const read = await call('read_notebook', { notebook_id: nbId });
    const cells = read.cells as { id: string; type: string }[];
    expect(cells.map((c) => c.type)).toEqual(['markdown', 'code']);

    const run = await call('run_notebook_cells', { notebook_id: nbId });
    expect(run.finished).toBe(true);
    const out = (run.cells as { outputs: string[]; failed: boolean }[])[0]!;
    expect(out.failed).toBe(false);
    expect(out.outputs.join('\n')).toContain('done 3');
    expect(out.outputs.some((o) => o.startsWith('[图像'))).toBe(true);

    expect(out.outputs.join('\n')).toContain('final_loss');

    // 回放执行者：运行记录的 by 是 agent
    const replace = await call('edit_notebook', {
      notebook_id: nbId,
      ops: [{ op: 'replace', cell_id: cells[1]!.id, source: 'print(1/0)' }],
    });
    expect(replace.ok).toBe(true);
    const bad = await call('run_notebook_cells', { notebook_id: nbId, cell_ids: [cells[1]!.id] });
    expect((bad.cells as { failed: boolean; outputs: string[] }[])[0]).toMatchObject({
      failed: true,
    });
    expect(String((bad.cells as { outputs: string[] }[])[0]!.outputs[0])).toContain(
      'ZeroDivisionError',
    );
  }, 180_000);
});

describe.skipIf(!GATEWAY)('notebooks: kernel capacity', () => {
  let t: TestApp;
  let owner: Session;
  let pid: string;

  beforeAll(async () => {
    t = await makeApp({
      KERNEL_MODE: 'gateway',
      KERNEL_GATEWAY_URL: GATEWAY,
      KERNEL_IDLE_MINUTES: '0',
      KERNEL_MAX_RUNNING: '1',
    });
    const s = await setupProject(t.app, []);
    owner = s.owner;
    pid = s.project.id;
  }, 60_000);
  afterAll(() => t.close(), 60_000);

  const make = async (title: string, source: string) =>
    (
      await owner.req('POST', `/projects/${pid}/notebooks`, {
        title,
        ipynb: { cells: [{ id: 'a', cell_type: 'code', source }] },
      })
    ).json<Notebook>();
  const outputsOf = async (id: string) =>
    (
      JSON.parse(
        (await owner.req('GET', `/projects/${pid}/notebooks/${id}/export?format=ipynb`)).body,
      ) as { cells: { outputs: { output_type: string; evalue?: string; text?: string[] }[] }[] }
    ).cells[0]!.outputs;

  it('sleeps the least recently used kernel, refuses when every kernel is busy', async () => {
    const mgr = kernelManager(t.app.ctx);
    const one = await make('一', 'print("one")');
    await owner.req('POST', `/projects/${pid}/notebooks/${one.id}/execute`, {});
    expect(await mgr.waitIdle(one.id)).toBe(true);
    expect(mgr.kernelStatus(one.id)).toBe('idle');

    // 第二本启动时，空闲的第一本被休眠
    const two = await make('二', 'import time\ntime.sleep(4)\nprint("two")');
    await owner.req('POST', `/projects/${pid}/notebooks/${two.id}/execute`, {});
    await new Promise((r) => setTimeout(r, 1500));
    expect(mgr.kernelStatus(one.id)).toBe('none');
    expect(mgr.runningCount()).toBe(1);

    // 第二本还在执行，第三本拿不到名额
    const three = await make('三', 'print("three")');
    await owner.req('POST', `/projects/${pid}/notebooks/${three.id}/execute`, {});
    expect(await mgr.waitIdle(three.id)).toBe(true);
    const out3 = await outputsOf(three.id);
    expect(out3[0]).toMatchObject({ output_type: 'error' });
    expect(out3[0]!.evalue).toContain('资源不足');

    expect(await mgr.waitIdle(two.id)).toBe(true);
    expect((await outputsOf(two.id))[0]!.text).toEqual(['two\n']);
  }, 120_000);
});
