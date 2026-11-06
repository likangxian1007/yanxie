import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResearchItem, ResearchRecord, ResearchRun } from '@srh/shared';
import {
  setExecutionModel,
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import { captureWorkspaceArchive } from '../src/modules/research/workspace-archive';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let outsider: Session;
let base: string;
let projectId: string;
let planningCalls = 0;
let downstreamCalls = 0;
let cancellationStarted = false;
const runners: ExecutionRunners = {
  async selectModel(_ctx, _projectId, _userId, requested) {
    return {
      model: requested.model ?? 'test/model',
      effort: requested.effort ?? 'high',
      profile: null,
      profilePrompt: null,
    };
  },
  async checkNotebook() {},
  async ai(_ctx, _projectId, _selection, input, signal) {
    if (input.definition.title === '失败内部') throw new Error('模拟内部失败');
    if (input.definition.title === '停止内部') {
      cancellationStarted = true;
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      throw new Error('运行已停止');
    }
    if (input.definition.title === '不应运行的下游') downstreamCalls++;
    return {
      outputs: [
        {
          title: input.definition.title,
          content: '根据固定材料整理得到的具体内容。',
          origin: 'ai_draft',
        },
      ],
      logs: [],
    };
  },
  async notebook() {
    throw new Error('不应执行 Notebook');
  },
};
async function item(body: unknown) {
  const res = await owner.req('POST', `${base}/items`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<ResearchItem>();
}
async function waitRun(id: string, statuses: string[]) {
  for (let i = 0; i < 600; i++) {
    const response = await owner.req('GET', `${base}/runs/${id}`);
    const run = response.json<ResearchRun>();
    if (statuses.includes(run.status)) return run;
    await sleep(20);
  }
  throw new Error('运行未到达期望状态');
}
beforeAll(async () => {
  t = await makeApp();
  const project = await setupProject(t.app, []);
  owner = project.owner;
  outsider = await signup(t.app, '项目外成员');
  projectId = project.project.id;
  const created = await owner.req('POST', `/projects/${projectId}/research/workspaces`, {
    title: '统一处理集成',
  });
  base = `/projects/${projectId}/research/records/${created.json<ResearchRecord>().id}`;
  setExecutionRunners(t.app.ctx, runners);
  setExecutionModel(t.app.ctx, {
    name: 'scripted',
    async chat() {
      planningCalls++;
      const content =
        planningCalls === 1
          ? { question: { questionId: 'q1', question: '希望如何整理？', reason: 'ambiguous' } }
          : {
              plan: {
                summary: '整理材料',
                steps: [
                  {
                    id: 'organize',
                    title: '整理',
                    operation: 'organize',
                    inputKeys: ['input:1'],
                    instructions: '归纳',
                  },
                ],
                outputs: [{ key: 'result', kind: 'note', stepId: 'organize' }],
              },
            };
      return {
        content: JSON.stringify(content),
        reasoning: '',
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
        model: 'test/model',
        effort: 'high',
      };
    },
  });
}, 60000);
afterAll(async () => {
  await t.close();
}, 60000);

describe('自动处理执行集成', () => {
  it('澄清回答受权限、版本与幂等保护，并在原尝试中恢复及复用方案', async () => {
    const source = await item({ kind: 'note', title: '材料', body: '固定的原始材料。' });
    const action = await item({
      kind: 'action',
      title: '自动整理',
      action: {
        kind: 'ai',
        instructions: '整理',
        inputItemIds: [source.id],
        processing: { mode: 'auto', expectedOutputs: ['note'] },
      },
    });
    const start = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }],
      idempotencyKey: 'processing_start_1',
    });
    expect(start.statusCode, start.body).toBe(201);
    const waiting = await waitRun(start.json<ResearchRun>().id, ['waiting']);
    const step = waiting.steps[0]!;
    const processing = step.attempts[0]!.processing!;
    expect(step.waitingFor).toMatchObject({ kind: 'clarification', questionId: 'q1' });
    const url = `${base}/runs/${waiting.id}/steps/${action.id}/answer`;
    const answer = {
      questionId: 'q1',
      answer: '按主题整理',
      baseVersion: processing.version,
      idempotencyKey: 'answer_key_1',
    };
    expect((await outsider.req('POST', url, answer)).statusCode).toBeGreaterThanOrEqual(403);
    expect(
      (await owner.req('POST', url, { ...answer, baseVersion: processing.version + 1 })).statusCode,
    ).toBe(409);
    expect((await owner.req('POST', url, { ...answer, answer: '' })).statusCode).toBe(422);
    const saved = await owner.req('POST', url, answer);
    expect(saved.statusCode, saved.body).toBe(200);
    const duplicate = await owner.req('POST', url, answer);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect((await owner.req('POST', url, { ...answer, answer: '另一种回答' })).statusCode).toBe(
      409,
    );
    const done = await waitRun(waiting.id, ['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.steps[0]!.attempts).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.processing?.answers).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.outputs[0]?.outputKey).toBe('result');
    const savedAction = await owner.req('GET', `${base}/items/${action.id}`);
    expect(savedAction.json<ResearchItem>().action?.outputs).toEqual([
      { key: 'result', kind: 'note' },
    ]);
    const connected = await item({
      kind: 'action',
      title: '连接实际输出',
      action: {
        kind: 'ai',
        instructions: '整理',
        inputs: [
          { name: '材料', source: { kind: 'output', stepId: action.id, outputKey: 'result' } },
        ],
      },
    });
    expect(connected.action?.inputs?.[0]?.source).toMatchObject({ outputKey: 'result' });
    const rerun = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }],
      idempotencyKey: 'processing_start_2',
    });
    const reused = await waitRun(rerun.json<ResearchRun>().id, ['succeeded', 'failed']);
    expect(reused.status).toBe('succeeded');
    expect(reused.steps[0]!.attempts[0]!.processing?.reused).toBe(true);
    expect(planningCalls).toBe(2);
    const replanned = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }],
      idempotencyKey: 'processing_replan_1',
      replan: true,
    });
    const replanDone = await waitRun(replanned.json<ResearchRun>().id, ['succeeded', 'failed']);
    expect(replanDone.status).toBe('succeeded');
    expect(replanDone.steps[0]!.attempts[0]!.outputs[0]?.outputKey).toBe('result');
  });
  it('一个节点发布表格、实际图表和笔记，审阅归档保留固定中间表依据', async () => {
    const table = await item({
      kind: 'table',
      title: '测量',
      table: {
        columns: [
          { id: 'label', name: '组别', type: 'text' },
          { id: 'value', name: '数值', type: 'number' },
        ],
        rows: [
          ['甲', 2],
          ['乙', 4],
        ],
      },
    });
    if (table.payload?.kind !== 'table' || !table.payload.columns) throw new Error('缺少表格列');
    const [labelColumn, valueColumn] = table.payload.columns.map((column) => column.id);
    const note = await item({ kind: 'note', title: '说明', body: '测量背景。' });
    const action = await item({
      kind: 'action',
      title: '综合处理',
      action: {
        kind: 'ai',
        instructions: '整理表、绘图并记下背景',
        inputItemIds: [table.id, note.id],
        outputs: [
          { key: 'data', kind: 'table' },
          { key: 'plot', kind: 'figure' },
          { key: 'notes', kind: 'note' },
        ],
        processing: { mode: 'auto', expectedOutputs: ['table', 'figure', 'note'] },
      },
    });
    setExecutionModel(t.app.ctx, {
      name: 'multi',
      async chat() {
        return {
          content: JSON.stringify({
            plan: {
              summary: '固定数据、绘图与整理',
              steps: [
                {
                  id: 'clean',
                  title: '处理表',
                  operation: 'transform_table',
                  inputKeys: ['input:1'],
                  transform: {},
                },
                {
                  id: 'plot',
                  title: '图',
                  operation: 'chart',
                  inputKeys: ['clean'],
                  chart: {
                    kind: 'bar',
                    xColumn: '组别',
                    yColumns: ['数值'],
                    missing: 'omit',
                  },
                },
                { id: 'notes', title: '背景', operation: 'organize', inputKeys: ['input:2'] },
              ],
              outputs: [
                { key: 'data', kind: 'table', stepId: 'clean' },
                { key: 'plot', kind: 'figure', stepId: 'plot' },
                { key: 'notes', kind: 'note', stepId: 'notes' },
              ],
            },
          }),
          reasoning: '',
          toolCalls: [],
          usage: { input: 1, output: 1, cached: 0 },
          model: 'test/model',
          effort: 'high',
        };
      },
    });
    const start = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }],
      idempotencyKey: 'processing_multi_1',
    });
    const run = await waitRun(start.json<ResearchRun>().id, ['succeeded', 'failed']);
    expect(run.status, run.steps[0]?.attempts[0]?.error ?? '').toBe('succeeded');
    const attempt = run.steps[0]!.attempts[0]!;
    expect(attempt.outputs.map((output) => output.outputKey)).toEqual(['data', 'plot', 'notes']);
    const figure = attempt.outputs.find((output) => output.outputKey === 'plot')!.artifact!;
    expect(figure.kind).toBe('figure');
    const expectedChart = {
      kind: 'bar',
      xColumn: labelColumn,
      yColumns: [valueColumn],
      missing: 'omit',
    };
    const figureItem = await owner.req('GET', `${base}/items/${figure.itemId}`);
    expect(figureItem.json<ResearchItem>().payload).toMatchObject({
      kind: 'figure',
      chart: expectedChart,
    });
    const metadata = await owner.req(
      'GET',
      `/projects/${projectId}/research/artifacts/${figure.id}`,
    );
    const figureRecord = metadata.json<{
      inputs: string[];
      metadata: { chart: unknown; rendering: unknown; pngArtifactId: string };
    }>();
    expect(figureRecord.metadata.chart).toEqual(expectedChart);
    expect(figureRecord.metadata.rendering).toMatchObject({
      omittedRows: 0,
      plottedRows: expect.any(Array),
    });
    const png = await t.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/research/artifacts/${figureRecord.metadata.pngArtifactId}/download`,
      headers: { cookie: owner.cookie },
    });
    expect(png.statusCode).toBe(200);
    expect(png.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const figureInputs = figureRecord.inputs;
    const intermediate = attempt.processing!.intermediates.find((ref) =>
      figureInputs.includes(ref.id),
    );
    expect(intermediate?.kind).toBe('table');
    const archive = await captureWorkspaceArchive(t.app.ctx, projectId, base.split('/').at(-1)!);
    expect(archive.artifacts?.some((artifact) => artifact.id === intermediate?.id)).toBe(true);
    const download = await owner.req(
      'GET',
      `/projects/${projectId}/research/artifacts/${intermediate!.id}/download`,
    );
    expect(download.statusCode).toBe(200);
    expect(JSON.parse(download.body).totalRows).toBe(2);
  }, 30000);
  it('内部步骤失败时不发布产物，也不执行下游', async () => {
    const source = await item({ kind: 'note', title: '失败输入', body: '固定输入。' });
    const action = await item({
      kind: 'action',
      title: '失败内部',
      action: {
        kind: 'ai',
        inputItemIds: [source.id],
        instructions: '整理',
        processing: { mode: 'auto', expectedOutputs: ['note'] },
      },
    });
    const downstream = await item({
      kind: 'action',
      title: '不应运行的下游',
      action: {
        kind: 'ai',
        instructions: '接收结果',
        inputItemIds: [],
      },
    });
    setExecutionModel(t.app.ctx, {
      name: 'failure',
      async chat() {
        return {
          content: JSON.stringify({
            plan: {
              summary: '整理',
              steps: [{ id: 'one', title: '整理', operation: 'organize', inputKeys: ['input:1'] }],
              outputs: [{ key: 'result', kind: 'note', stepId: 'one' }],
            },
          }),
          reasoning: '',
          toolCalls: [],
          usage: { input: 1, output: 1, cached: 0 },
          model: 'test/model',
          effort: 'high',
        };
      },
    });
    const started = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }, { itemId: downstream.id, dependsOn: [action.id] }],
      idempotencyKey: 'processing_failure_1',
    });
    const run = await waitRun(started.json<ResearchRun>().id, ['failed']);
    expect(run.steps[0]!.attempts[0]!.outputs).toEqual([]);
    expect(run.steps[1]!.attempts).toEqual([]);
    expect(downstreamCalls).toBe(0);
  });
  it('停止内部执行后不发布产物，也不启动下游', async () => {
    const source = await item({ kind: 'note', title: '停止输入', body: '固定输入。' });
    const action = await item({
      kind: 'action',
      title: '停止内部',
      action: {
        kind: 'ai',
        inputItemIds: [source.id],
        instructions: '整理',
        processing: { mode: 'auto', expectedOutputs: ['note'] },
      },
    });
    const downstream = await item({
      kind: 'action',
      title: '不应运行的下游',
      action: { kind: 'ai', instructions: '接收', inputItemIds: [] },
    });
    const started = await owner.req('POST', `${base}/runs`, {
      steps: [{ itemId: action.id }, { itemId: downstream.id, dependsOn: [action.id] }],
      idempotencyKey: 'processing_cancel_1',
    });
    const id = started.json<ResearchRun>().id;
    for (let i = 0; i < 600 && !cancellationStarted; i++) await sleep(20);
    expect(cancellationStarted).toBe(true);
    expect((await owner.req('POST', `${base}/runs/${id}/cancel`)).statusCode).toBe(200);
    const run = await waitRun(id, ['cancelled']);
    expect(run.steps[0]!.attempts[0]!.outputs).toEqual([]);
    expect(run.steps[1]!.attempts).toEqual([]);
    expect(downstreamCalls).toBe(0);
  });
});
