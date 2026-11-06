import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError,
  type AnyProjectEvent,
  type ResearchItem,
  type ResearchRecipe,
  type ResearchRecord,
  type ResearchRun,
} from '@srh/shared';
import { researchRuns } from '../src/db/schema/research-execution';
import { events } from '../src/db/schema';
import { confirmStep } from '../src/modules/research/execution';
import { interruptUnfinishedRuns } from '../src/modules/research/execution-store';
import {
  defaultExecutionRunners,
  setExecutionModel,
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import type { ChatRequest } from '../src/agents/llm/complete';
import { makeApp, setupProject, sleep, signup, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let guest: Session;
let outsider: Session;
let base: string;
let projectId: string;
let recordId: string;
const calls: { title: string; inputs: string[]; upstream: string[] }[] = [];
const executionEvents: AnyProjectEvent[] = [];
const failOnce = new Set<string>();
let hold: { started: string[]; promise: Promise<void>; release: () => void } | null = null;
let stopped: {
  started: boolean;
  aborted: boolean;
  promise: Promise<void>;
  release: () => void;
} | null = null;
let kernelAvailable = true;
const runners: ExecutionRunners = {
  async selectModel(_ctx, _projectId, _userId, requested) {
    if (requested.model === 'missing') throw new ApiError('llm_unavailable', '模型不可用');
    return {
      model: requested.model ?? 'mock/model',
      effort: requested.effort ?? 'high',
      profile: requested.profile,
      profilePrompt: requested.profile ? '固定的 profile 内容' : null,
    };
  },
  async checkNotebook() {
    if (!kernelAvailable) throw new ApiError('not_implemented', '内核不可用');
  },
  async ai(_ctx, _projectId, _selection, input, signal) {
    const title = input.definition.title;
    calls.push({
      title,
      inputs: input.inputs.map((i) => i.content),
      upstream: input.upstream.map((o) => o.content),
    });
    if (hold && title.startsWith('并发')) {
      hold.started.push(title);
      await hold.promise;
    }
    if (stopped && title === '停止用行动') {
      stopped.started = true;
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      stopped.aborted = true;
      await stopped.promise;
      throw new Error('已停止');
    }
    if (failOnce.delete(title)) throw new Error('模拟一次失败');
    return {
      outputs: [
        {
          title: `${title}产物`,
          content: `这是${title}生成的可阅读研究草稿。`,
          origin: 'ai_draft',
        },
      ],
      logs: ['本地测试模型'],
    };
  },
  async notebook(_ctx, _actor, _projectId, input) {
    return {
      outputs: [
        {
          title: '模拟计算输出',
          content: `真实测试运行器输出：${input.definition.notebook?.cells[0]?.source}`,
          origin: 'computation',
        },
      ],
      logs: ['本地测试运行器'],
    };
  },
};

async function createItem(input: Record<string, unknown>): Promise<ResearchItem> {
  const res = await owner.req('POST', `${base}/items`, input);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<ResearchItem>();
}
async function action(title: string, inputIds: string[] = [], kind: 'ai' | 'human' = 'ai') {
  return createItem({
    kind: 'action',
    title,
    action: { kind, instructions: `${title}的研究操作`, inputItemIds: inputIds },
  });
}
async function run(
  steps: { itemId: string; dependsOn?: string[] }[],
  key: string,
  extra: Record<string, unknown> = {},
) {
  return owner.req('POST', `${base}/runs`, { steps, idempotencyKey: key, ...extra });
}
async function waitRun(id: string, statuses: string[], timeout = 12000): Promise<ResearchRun> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const res = await owner.req('GET', `${base}/runs/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const value = res.json<ResearchRun>();
    if (statuses.includes(value.status)) return value;
    await sleep(20);
  }
  throw new Error('运行没有到达期望状态');
}

beforeAll(async () => {
  t = await makeApp();
  const project = await setupProject(t.app, ['guest']);
  owner = project.owner;
  guest = project.others[0]!;
  outsider = await signup(t.app, '项目外成员');
  projectId = project.project.id;
  const record = await owner.req('POST', `/projects/${projectId}/research/workspaces`, {
    title: '局部运行',
  });
  expect(record.statusCode, record.body).toBe(201);
  recordId = record.json<ResearchRecord>().id;
  base = `/projects/${projectId}/research/records/${recordId}`;
  setExecutionRunners(t.app.ctx, runners);
  t.app.ctx.bus.onEvent((event) => {
    if (event.type.startsWith('research.run.') || event.type === 'research.recipe.published')
      executionEvents.push(event);
  });
}, 60000);
afterAll(async () => {
  hold?.release();
  stopped?.release();
  await t.close();
}, 60000);

describe('研究空间局部执行', () => {
  it('并行分支汇合、冻结输入与用户检查；AI 不能代签', async () => {
    const note = await createItem({
      kind: 'note',
      title: '原始材料',
      body: '这是运行启动时的原始材料。',
    });
    const a = await action('并发一', [note.id]);
    const b = await action('并发二', [note.id]);
    const c = await action('汇合');
    const human = await action('人工核对', [], 'human');
    const d = await action('最终整理');
    let release!: () => void;
    hold = {
      started: [],
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    const response = await run(
      [
        { itemId: a.id },
        { itemId: b.id },
        { itemId: c.id, dependsOn: [a.id, b.id] },
        { itemId: human.id, dependsOn: [c.id] },
        { itemId: d.id, dependsOn: [human.id] },
      ],
      'parallel_001',
      { model: 'chosen/model', effort: 'max', profile: 'selected-profile' },
    );
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json<ResearchRun>().id;
    const deadline = Date.now() + 5000;
    while (hold.started.length < 2 && Date.now() < deadline) await sleep(20);
    expect(hold.started.sort()).toEqual(['并发一', '并发二']);
    const edit = await owner.req('PATCH', `${base}/items/${note.id}`, {
      baseVersion: note.version,
      body: '材料后来被修改了。',
    });
    expect(edit.statusCode, edit.body).toBe(200);
    hold.release();
    hold = null;
    const waiting = await waitRun(id, ['waiting']);
    expect(waiting.inputSnapshots[0]?.content).toBe('这是运行启动时的原始材料。');
    expect(waiting.steps.find((s) => s.definition.itemId === a.id)?.selection).toMatchObject({
      model: 'chosen/model',
      effort: 'max',
      profile: 'selected-profile',
    });
    expect(calls.find((call) => call.title === '汇合')?.upstream).toHaveLength(2);
    await expect(
      confirmStep(
        t.app.ctx,
        { kind: 'agent', id: 'agent_a', name: '研协' },
        projectId,
        recordId,
        id,
        human.id,
        { note: '代签' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const confirmed = await owner.req('POST', `${base}/runs/${id}/steps/${human.id}/confirm`, {
      note: '我已核对结果，并记录人工意见。',
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const done = await waitRun(id, ['succeeded']);
    expect(done.steps.every((s) => s.status === 'succeeded')).toBe(true);
    expect(done.steps.find((s) => s.definition.itemId === human.id)?.confirmedBy?.id).toBe(
      owner.user.id,
    );
    const created = executionEvents.filter(
      (event) => event.type === 'research.run.created' && event.payload.id === id,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.actor.id).toBe(owner.user.id);
    expect(created[0]!.payload).not.toHaveProperty('inputSnapshots');
    expect(JSON.stringify(created[0]!.payload).length).toBeLessThan(1000);
    const storedEvents = await t.db.db.select().from(events).where(eq(events.projectId, projectId));
    expect(storedEvents).toContainEqual(
      expect.objectContaining({
        type: 'research.run.updated',
        actor: expect.objectContaining({ id: owner.user.id }),
        payload: expect.objectContaining({ id }),
      }),
    );
    const output = done.steps[0]!.attempts[0]!.outputs[0]!;
    const saved = await owner.req('GET', `${base}/items/${output.itemId}`);
    expect(saved.json<ResearchItem>().body).toBe(output.content);
    const stale = await owner.req('GET', `${base}/runs/${id}/staleness`);
    expect(stale.json()).toMatchObject({
      stale: true,
      inputs: [{ itemId: note.id, state: 'changed' }],
    });
  });

  it('依赖缺失、循环、不可用模型和内核均在启动前拒绝，项目权限不越界', async () => {
    const a = await action('校验一');
    const b = await action('校验二');
    const cycle = await run(
      [
        { itemId: a.id, dependsOn: [b.id] },
        { itemId: b.id, dependsOn: [a.id] },
      ],
      'cycle_key_01',
    );
    expect(cycle.statusCode).toBe(422);
    const missing = await run([{ itemId: a.id, dependsOn: ['absent'] }], 'missing_dep_01');
    expect(missing.statusCode).toBe(422);
    const unavailable = await run([{ itemId: a.id }], 'model_missing_01', { model: 'missing' });
    expect(unavailable.statusCode).toBe(503);
    const notebookRes = await owner.req('POST', `/projects/${projectId}/notebooks`, {
      title: '计算',
      ipynb: { cells: [{ id: 'n1', cell_type: 'code', source: 'print(1)' }] },
    });
    expect(notebookRes.statusCode, notebookRes.body).toBe(201);
    const nb = notebookRes.json<{ id: string }>();
    const n = await createItem({
      kind: 'action',
      title: '缺少内核',
      action: { kind: 'notebook', notebookId: nb.id, cellIds: ['n1'] },
    });
    kernelAvailable = false;
    const kernel = await run([{ itemId: n.id }], 'kernel_missing_01');
    kernelAvailable = true;
    expect(kernel.statusCode).toBe(501);
    expect(
      (
        await guest.req('POST', `${base}/runs`, {
          steps: [{ itemId: a.id }],
          idempotencyKey: 'guest_key_01',
        })
      ).statusCode,
    ).toBe(403);
    expect([403, 404]).toContain((await outsider.req('GET', `${base}/runs`)).statusCode);
    const other = await setupProject(t.app, []);
    const crossed = await owner.req(
      'POST',
      `/projects/${other.project.id}/research/records/${recordId}/runs`,
      { steps: [{ itemId: a.id }], idempotencyKey: 'cross_key_01' },
    );
    expect([403, 404]).toContain(crossed.statusCode);
  });

  it('并发重复启动只产生一次运行；同键不同请求冲突', async () => {
    const a = await action('幂等行动');
    const request = { steps: [{ itemId: a.id }], idempotencyKey: 'idem_parallel_01' };
    const [x, y] = await Promise.all([
      owner.req('POST', `${base}/runs`, request),
      owner.req('POST', `${base}/runs`, request),
    ]);
    expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
    expect(x.json<ResearchRun>().id).toBe(y.json<ResearchRun>().id);
    await waitRun(x.json<ResearchRun>().id, ['succeeded']);
    expect(calls.filter((call) => call.title === '幂等行动')).toHaveLength(1);
    expect((await run([{ itemId: a.id }], 'idem_parallel_01', { effort: 'low' })).statusCode).toBe(
      409,
    );
  });

  it('本地模型响应必须包含可读取产物，并保留选定模型及冻结输入', async () => {
    const material = await createItem({
      kind: 'note',
      title: '模型材料',
      body: '这是需要分析的真实材料。',
    });
    const node = await action('模型验证行动', [material.id]);
    const requests: ChatRequest[] = [];
    let content = JSON.stringify({
      outputs: [{ title: '分析草稿', content: '这是根据所给材料形成的具体分析草稿。' }],
    });
    setExecutionModel(t.app.ctx, {
      name: 'scripted',
      async chat(req) {
        requests.push(req);
        return {
          content,
          reasoning: '',
          toolCalls: [],
          usage: { input: 10, output: 5, cached: 0 },
          model: 'chosen/model',
          effort: 'max',
        };
      },
    });
    setExecutionRunners(t.app.ctx, { ...runners, ai: defaultExecutionRunners.ai });
    try {
      const ok = await run([{ itemId: node.id }], 'model_result_good_01', {
        model: 'chosen/model',
        effort: 'max',
      });
      const success = await waitRun(ok.json<ResearchRun>().id, ['succeeded']);
      expect(requests[0]?.route).toMatchObject({ modelId: 'chosen/model', effort: 'max' });
      expect(requests[0]?.messages[1]?.content).toContain('这是需要分析的真实材料。');
      expect(success.steps[0]?.attempts[0]?.outputs[0]).toMatchObject({ origin: 'ai_draft' });
      content = JSON.stringify({ outputs: [{ title: '空完成', content: '已完成' }] });
      const bad = await run([{ itemId: node.id }], 'model_result_bad_01');
      const failed = await waitRun(bad.json<ResearchRun>().id, ['failed']);
      expect(failed.steps[0]?.attempts[0]?.outputs).toEqual([]);
      expect(failed.steps[0]?.attempts[0]?.error).toContain('实际产物');
    } finally {
      setExecutionRunners(t.app.ctx, runners);
    }
  });

  it('失败后保留成功产物，只重试失败步骤；输入变化后禁止重试', async () => {
    const note = await createItem({
      kind: 'note',
      title: '重试材料',
      body: '用于重试的固定材料。',
    });
    const a = await action('先成功', [note.id]);
    const b = await action('失败一次');
    failOnce.add('失败一次');
    const response = await run(
      [{ itemId: a.id }, { itemId: b.id, dependsOn: [a.id] }],
      'retry_case_01',
    );
    const id = response.json<ResearchRun>().id;
    const failed = await waitRun(id, ['failed']);
    expect(failed.steps[0]?.attempts[0]?.outputs).toHaveLength(1);
    const retry = await owner.req('POST', `${base}/runs/${id}/retry`);
    expect(retry.statusCode, retry.body).toBe(200);
    const done = await waitRun(id, ['succeeded']);
    expect(done.steps[0]?.attempts).toHaveLength(1);
    expect(done.steps[1]?.attempts).toHaveLength(2);
    expect(calls.filter((call) => call.title === '先成功')).toHaveLength(1);
    expect(done.steps[0]?.attempts[0]?.outputs).toEqual(failed.steps[0]?.attempts[0]?.outputs);
    failOnce.add('失败一次');
    const other = await run(
      [{ itemId: a.id }, { itemId: b.id, dependsOn: [a.id] }],
      'retry_changed_01',
    );
    const otherId = other.json<ResearchRun>().id;
    await waitRun(otherId, ['failed']);
    await owner.req('PATCH', `${base}/items/${note.id}`, {
      baseVersion: note.version,
      body: '材料已更改，不可沿用原运行。',
    });
    expect((await owner.req('POST', `${base}/runs/${otherId}/retry`)).statusCode).toBe(409);
  });

  it('停止保持待停止，直到运行器真正退出', async () => {
    const a = await action('停止用行动');
    let release!: () => void;
    stopped = {
      started: false,
      aborted: false,
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    const response = await run([{ itemId: a.id }], 'cancel_case_01');
    const id = response.json<ResearchRun>().id;
    const deadline = Date.now() + 5000;
    while (!stopped.started && Date.now() < deadline) await sleep(20);
    expect(stopped.started).toBe(true);
    const stop = await owner.req('POST', `${base}/runs/${id}/cancel`);
    expect(stop.json<ResearchRun>()).toMatchObject({ cancelRequested: true, status: 'running' });
    while (!stopped.aborted && Date.now() < deadline) await sleep(20);
    expect(stopped.aborted).toBe(true);
    expect((await owner.req('GET', `${base}/runs/${id}`)).json<ResearchRun>().status).toBe(
      'running',
    );
    stopped.release();
    stopped = null;
    expect((await waitRun(id, ['cancelled'])).status).toBe('cancelled');
  });

  it('方案版本固定内容，替换输入后创建新运行并保留历史；重启不自动重复', async () => {
    const old = await createItem({ kind: 'note', title: '旧输入', body: '这是方案原始输入内容。' });
    const replacement = await createItem({
      kind: 'note',
      title: '新输入',
      body: '这是实例替换后的输入内容。',
    });
    const a = await action('方案行动', [old.id]);
    const published = await owner.req('POST', `${base}/recipes`, {
      title: '可复用片段',
      steps: [{ itemId: a.id }],
    });
    expect(published.statusCode, published.body).toBe(201);
    const recipe = published.json<ResearchRecipe>();
    const updated = await owner.req('PATCH', `${base}/items/${a.id}`, {
      baseVersion: a.version,
      action: { ...a.action!, instructions: '后来修改的行动' },
    });
    expect(updated.statusCode).toBe(200);
    const v2 = await owner.req('POST', `${base}/recipes`, {
      recipeId: recipe.id,
      title: '可复用片段',
      steps: [{ itemId: a.id }],
    });
    expect(v2.json<ResearchRecipe>().version).toBe(2);
    const inst = await owner.req('POST', `${base}/recipes/${recipe.id}/instantiate`, {
      version: 1,
      bindings: { [old.id]: replacement.id },
      idempotencyKey: 'recipe_case_01',
    });
    expect(inst.statusCode, inst.body).toBe(201);
    const id = inst.json<ResearchRun>().id;
    const done = await waitRun(id, ['succeeded']);
    expect(done.recipeVersion).toBe(1);
    expect(done.steps[0]?.definition.action.instructions).toBe('方案行动的研究操作');
    expect(done.inputSnapshots[0]?.content).toBe('这是实例替换后的输入内容。');
    const unfinished = structuredClone(done);
    unfinished.status = 'running';
    unfinished.steps[0]!.status = 'running';
    unfinished.steps[0]!.attempts.push({
      number: 2,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      logs: [],
      notebookId: null,
      error: null,
      outputs: [],
    });
    await t.db.db.update(researchRuns).set({ data: unfinished }).where(eq(researchRuns.id, id));
    const count = calls.length;
    await interruptUnfinishedRuns(t.app.ctx);
    const recovered = (await owner.req('GET', `${base}/runs/${id}`)).json<ResearchRun>();
    expect(recovered.status).toBe('interrupted');
    expect(recovered.steps[0]?.attempts[1]?.status).toBe('interrupted');
    await sleep(50);
    expect(calls).toHaveLength(count);
  });
});
