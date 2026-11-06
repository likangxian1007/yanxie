import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context';
import type { ChatRequest } from '../src/agents/llm/complete';
import type * as Composable from '../src/modules/research/composable';
import type {
  Draft,
  ExecutionContext,
  ModelSelection,
} from '../src/modules/research/execution-runners';
import {
  defaultExecutionRunners,
  setExecutionModel,
  setExecutionRunners,
} from '../src/modules/research/execution-runners';
import {
  executeProcessing,
  processingFingerprint,
  validateProcessingPlan,
} from '../src/modules/research/processing';
import type {
  ResearchProcessingExecution,
  ResearchProcessingPlan,
  ResearchRunOutput,
} from '@srh/shared';

vi.mock('../src/modules/research/composable', async (importOriginal) => ({
  ...(await importOriginal<typeof Composable>()),
  chartPng: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
}));
const selection: ModelSelection = {
  model: 'test',
  effort: 'high',
  profile: null,
  profilePrompt: null,
};
const table = {
  documentId: 'd',
  sheetId: 's',
  sourceVersion: '1',
  hash: 'hash',
  nextCursor: null,
  columns: [
    { id: 'group', name: '类别' },
    { id: 'weight', name: '质量', type: 'number', unit: 'kg' },
  ],
  rows: [
    { id: 'r1', cells: { group: '甲', weight: 2 } },
    { id: 'r2', cells: { group: '甲', weight: 3 } },
  ],
  totalRows: 2,
};
const input = {
  definition: {
    title: '处理',
    action: {
      instructions: '按类别求和并绘图',
      processing: { mode: 'auto', expectedOutputs: ['table', 'figure'] },
    },
  },
  inputs: [
    {
      item: { id: 'i', kind: 'table', title: '输入' },
      content: JSON.stringify(table),
      artifact: { id: 'original' },
    },
  ],
  upstream: [],
} as unknown as ExecutionContext;
const plan: ResearchProcessingPlan = {
  summary: '分组并绘图',
  steps: [
    {
      id: 'sum',
      title: '合计',
      operation: 'transform_table',
      inputKeys: ['input:1'],
      instructions: '',
      transform: {
        select: ['类别'],
        groupBy: ['类别'],
        aggregates: [{ op: 'sum', columnId: '质量', as: '合计' }],
      },
    },
    {
      id: 'chart',
      title: '图',
      operation: 'chart',
      inputKeys: ['sum'],
      instructions: '',
      chart: { kind: 'bar', xColumn: '类别', yColumns: ['合计'], missing: 'omit' },
    },
  ],
  outputs: [
    { key: 'table', kind: 'table', stepId: 'sum' },
    { key: 'figure', kind: 'figure', stepId: 'chart' },
  ],
};
function setup() {
  const ctx = {} as AppContext;
  const chat = vi.fn(async (_request: ChatRequest) => ({
    content: JSON.stringify({ plan }),
    reasoning: '',
    toolCalls: [],
    usage: { input: 1, output: 1, cached: 0 },
    model: 'test',
  }));
  setExecutionModel(ctx, { name: 'test', chat });
  const saved: Array<{ id: string; rows?: unknown; inputs: string[] }> = [];
  const options = {
    onState: vi.fn(async (_state: ResearchProcessingExecution) => {}),
    publishIntermediate: vi.fn(async (id: string, draft: Draft, inputs: string[]) => {
      id = id.split(':').at(-1)!;
      saved.push({ id, rows: draft.table?.rows, inputs });
      const seed = draft.table;
      const content = seed
        ? JSON.stringify({
            ...table,
            columns: seed.columns,
            rows: seed.rows.map((row, i) => ({
              id: `r${i + 1}`,
              cells: Object.fromEntries(seed.columns.map((column, c) => [column.id, row[c]])),
            })),
            totalRows: seed.rows.length,
          })
        : draft.content;
      return {
        itemId: id,
        title: draft.title,
        content,
        hash: 'h',
        version: 1,
        origin: draft.origin,
        artifact: { id: `artifact-${id}`, kind: draft.kind },
      } as ResearchRunOutput;
    }),
  };
  return { ctx, chat, saved, options };
}
describe('统一研究处理', () => {
  it('按计划实际聚合全部数据并以固定中间表绘图', async () => {
    const { ctx, saved, options, chat } = setup();
    const result = await executeProcessing(
      ctx,
      'project',
      selection,
      input,
      new AbortController().signal,
      options,
    );
    const request = JSON.parse(chat.mock.calls[0]![0].messages[1]!.content!);
    expect(JSON.stringify(request.responseSchemas.plan)).toContain('xColumn');
    expect(JSON.stringify(request.responseSchemas.plan)).toContain('aggregates');
    expect(JSON.stringify(request.responseSchemas.question)).toContain('questionId');
    expect(saved[0]).toMatchObject({ rows: [['甲', 5]], inputs: ['original'] });
    expect(saved[1]?.inputs).toEqual(['artifact-sum']);
    expect(result.outputs[1]?.figure?.dataArtifactId).toBe('artifact-sum');
    expect(result.outputs[0]?.origin).toBe('computation');
    expect(result.processing.phase).toBe('succeeded');
  });
  it('仅相同结构和指令复用成功方案', async () => {
    const { ctx, chat, options } = setup();
    const first = await executeProcessing(
      ctx,
      'project',
      selection,
      input,
      new AbortController().signal,
      options,
    );
    const savedSlots = structuredClone(input);
    savedSlots.definition.action.outputs = plan.outputs.map(({ key, kind }) => ({ key, kind }));
    const second = await executeProcessing(
      ctx,
      'project',
      selection,
      savedSlots,
      new AbortController().signal,
      { ...options, previous: first.processing },
    );
    expect(second.processing.reused).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    const answered = structuredClone(first.processing);
    answered.answers = [
      {
        questionId: 'q',
        question: '范围？',
        answer: '只看第一部分',
        actor: { kind: 'user', id: 'u', name: '成员' },
        answeredAt: '2026-01-01',
        idempotencyKey: 'abcdefgh',
      },
    ];
    const third = await executeProcessing(
      ctx,
      'project',
      selection,
      input,
      new AbortController().signal,
      { ...options, previous: first.processing, state: answered },
    );
    expect(third.processing.reused).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
    const changed = structuredClone(input);
    changed.definition.action.instructions = '另一个需求';
    expect(processingFingerprint(changed)).not.toBe(processingFingerprint(input));
  });
  it('拒绝无效引用和更改锁定配置', () => {
    const invalid = structuredClone(plan);
    invalid.steps[0]!.inputKeys = ['chart'];
    expect(() => validateProcessingPlan(invalid, input)).toThrow('不存在或尚未执行');
    const locked = structuredClone(input);
    locked.definition.action.processing!.locks = {
      chart: { kind: 'line', xColumn: '类别', yColumns: ['合计'], missing: 'omit' },
    };
    expect(() => validateProcessingPlan(plan, locked)).toThrow('锁定');
  });
  it('自动聚合方案不能在 select 引用新生成的聚合列', () => {
    const invalid = structuredClone(plan);
    invalid.steps[0]!.transform!.select = ['类别', '合计'];
    expect(() => validateProcessingPlan(invalid, input)).toThrow('不能包含新生成的聚合列');
  });
  it('未知输入引用失败时保留被拒方案并且不执行', async () => {
    const { ctx, chat, options } = setup();
    const rejected = structuredClone(plan);
    rejected.steps[0]!.inputKeys = ['input1'];
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ plan: rejected }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ plan: rejected }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    await expect(
      executeProcessing(ctx, 'project', selection, input, new AbortController().signal, options),
    ).rejects.toThrow('"input1"；当前可用 keys："input:1"');
    expect(options.onState.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: 'failed',
      plan: rejected,
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(options.publishIntermediate).not.toHaveBeenCalled();
  });
  it('方案引用无效后最多重新规划一次，并只执行校验通过的方案', async () => {
    const { ctx, chat, options } = setup();
    const rejected = structuredClone(plan);
    rejected.steps[0]!.inputKeys = ['input1'];
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ plan: rejected }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    const result = await executeProcessing(
      ctx,
      'project',
      selection,
      input,
      new AbortController().signal,
      options,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.logs).toContain('方案校验后重新整理一次');
    expect(result.processing.plan).toEqual(plan);
    expect(options.publishIntermediate).toHaveBeenCalledTimes(2);
    const repair = chat.mock.calls[1]![0].messages;
    expect(repair[2]).toMatchObject({
      role: 'assistant',
      content: JSON.stringify({ plan: rejected }),
    });
    expect(repair[3]!.content).toContain('input:1');
    expect(repair[3]!.content).toContain('input1');
  });
  it('保留已声明槽并允许新增请求类型，拒绝其他类型', () => {
    const declared = structuredClone(input);
    declared.definition.action.outputs = [{ key: 'table', kind: 'table' }];
    declared.definition.action.processing!.expectedOutputs = ['figure'];
    expect(validateProcessingPlan(plan, declared).outputs).toHaveLength(2);
    const missing = structuredClone(declared);
    missing.definition.action.outputs = [{ key: 'other', kind: 'table' }];
    expect(() => validateProcessingPlan(plan, missing)).toThrow('声明的输出');
    const disallowed = structuredClone(declared);
    disallowed.definition.action.outputs = [];
    expect(() => validateProcessingPlan(plan, disallowed)).toThrow('未要求');
  });
  it('非结构化材料变更时重新规划，结构表格仅数据变化仍可复用', () => {
    const resource = structuredClone(input);
    resource.inputs[0]!.item.kind = 'resource';
    resource.inputs[0]!.content = '类别,质量\n甲,2';
    const changedHeader = structuredClone(resource);
    changedHeader.inputs[0]!.content = '类别,长度\n甲,2';
    expect(processingFingerprint(resource)).not.toBe(processingFingerprint(changedHeader));
    const draft = structuredClone(resource);
    draft.inputs[0]!.item.kind = 'draft';
    draft.inputs[0]!.content = JSON.stringify({
      kind: 'draft',
      blocks: [{ kind: 'text', text: 'A,B\n1,2' }],
    });
    const changedDraft = structuredClone(draft);
    changedDraft.inputs[0]!.content = JSON.stringify({
      kind: 'draft',
      blocks: [{ kind: 'text', text: 'A,C\n1,2' }],
    });
    expect(processingFingerprint(draft)).not.toBe(processingFingerprint(changedDraft));
    const changedRows = structuredClone(input);
    changedRows.inputs[0]!.content = JSON.stringify({
      ...table,
      rows: [{ id: 'r1', cells: { group: '乙', weight: 9 } }],
      totalRows: 1,
    });
    expect(processingFingerprint(changedRows)).toBe(processingFingerprint(input));
  });
  it('同一尝试续答后重复的问题标识会更新', async () => {
    const { ctx, chat, options } = setup();
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        question: { questionId: 'q1', question: '还有什么要求？', reason: 'ambiguous' },
      }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    const state: ResearchProcessingExecution = {
      version: 1,
      phase: 'planning',
      fingerprint: '',
      reused: false,
      plan: null,
      steps: [],
      intermediates: [],
      answers: [
        {
          questionId: 'q1',
          question: '范围？',
          answer: '只看第一部分',
          actor: { kind: 'user', id: 'u', name: '成员' },
          answeredAt: '2026-01-01',
          idempotencyKey: 'abcdefgh',
        },
      ],
    };
    const result = await executeProcessing(
      ctx,
      'project',
      selection,
      input,
      new AbortController().signal,
      { ...options, state },
    );
    expect(result.processing.phase).toBe('waiting');
    expect(result.processing.question?.questionId).toBeTruthy();
    expect(result.processing.question?.questionId).not.toBe('q1');
    expect(options.publishIntermediate).not.toHaveBeenCalled();
  });
  it('组织步骤保留原始目标和成员澄清', async () => {
    const { ctx, chat, options } = setup();
    const notePlan = {
      summary: '整理',
      steps: [
        {
          id: 'note',
          title: '笔记',
          operation: 'organize',
          inputKeys: ['input:1'],
          instructions: '提炼观点',
        },
      ],
      outputs: [{ key: 'result', kind: 'note', stepId: 'note' }],
    };
    chat.mockResolvedValueOnce({
      content: JSON.stringify({ plan: notePlan }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    const ai = vi.fn(
      async (
        _ctx: AppContext,
        _projectId: string,
        _selection: ModelSelection,
        _input: ExecutionContext,
        _signal: AbortSignal,
      ) => ({
        outputs: [
          {
            kind: 'note' as const,
            title: '笔记',
            outputKey: 'result',
            content: '实际整理结果',
            origin: 'ai_draft' as const,
          },
        ],
        logs: [],
      }),
    );
    setExecutionRunners(ctx, { ...defaultExecutionRunners, ai });
    const source = structuredClone(input);
    source.definition.action.instructions = '保留证据和不确定性';
    source.definition.action.processing!.expectedOutputs = ['note'];
    const state: ResearchProcessingExecution = {
      version: 1,
      phase: 'planning',
      fingerprint: '',
      reused: false,
      plan: null,
      steps: [],
      intermediates: [],
      answers: [
        {
          questionId: 'q',
          question: '范围？',
          answer: '只整理第一部分',
          actor: { kind: 'user', id: 'u', name: '成员' },
          answeredAt: '2026-01-01',
          idempotencyKey: 'abcdefgh',
        },
      ],
    };
    await executeProcessing(ctx, 'project', selection, source, new AbortController().signal, {
      ...options,
      state,
    });
    const instruction = ai.mock.calls[0]![3].definition.action.instructions;
    expect(instruction).toContain('保留证据和不确定性');
    expect(instruction).toContain('只整理第一部分');
    expect(instruction).toContain('提炼观点');
    expect(instruction).toContain('只返回声明的单份产物');
    expect(ai.mock.calls[0]![3].definition.action.processing).toBeUndefined();
    expect(ai.mock.calls[0]![3].definition.action.outputs).toEqual([
      { key: 'result', kind: 'note' },
    ]);
  });
  it('计算失败时记录失败，不生成成功结果', async () => {
    const { ctx, options } = setup();
    const broken = structuredClone(input);
    broken.inputs[0]!.content = JSON.stringify({
      ...table,
      rows: [{ id: 'r1', cells: { group: '甲', weight: '错误' } }],
      totalRows: 1,
    });
    await expect(
      executeProcessing(ctx, 'project', selection, broken, new AbortController().signal, options),
    ).rejects.toThrow('非数值');
    expect(options.publishIntermediate).not.toHaveBeenCalled();
    expect(options.onState.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'failed' });
  });
  it('AI 提取请求提供真实产物 schema，校验失败仅报告有限字段诊断', async () => {
    const { ctx, chat } = setup();
    chat.mockResolvedValueOnce({
      content: JSON.stringify({
        outputs: [
          {
            kind: 'table',
            title: '表',
            table: {
              columns: [{ id: 'x', name: '列', type: '模型私有内容' }],
              rows: [[{ secret: '模型私有内容' }]],
              lineage: [{ rowId: 'r1', columnId: 'x', verification: '无效' }],
            },
          },
        ],
      }),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    let message = '';
    try {
      await defaultExecutionRunners.ai(
        ctx,
        'project',
        selection,
        input,
        new AbortController().signal,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('outputs.0.table.columns.0.type');
    expect(message).toContain('outputs.0.table.rows.0.0');
    expect(message).not.toContain('模型私有内容');
    expect(message.split('；').length).toBeLessThanOrEqual(3);
    const payload = JSON.parse(chat.mock.calls[0]![0].messages[1]!.content!);
    expect(JSON.stringify(payload.responseSchema)).toContain('verification');
    expect(JSON.stringify(payload.responseSchema)).toContain('columns');
  });
  it('声明表格但模型先返回笔记时只修正一次协议，兼容单产物省略 key', async () => {
    const { ctx, chat } = setup();
    const expected = structuredClone(input);
    expected.definition.action.outputs = [{ key: 'result', kind: 'table' }];
    const response = (content: unknown) => ({
      content: JSON.stringify(content),
      reasoning: '',
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
      model: 'test',
    });
    chat.mockResolvedValueOnce(
      response({
        outputs: [{ key: 'result', kind: 'note', title: '笔记', content: '这是实际笔记内容。' }],
      }),
    );
    chat.mockResolvedValueOnce(
      response({
        outputs: [
          {
            kind: 'table',
            title: '表',
            table: { columns: [{ id: 'x', name: '数值', type: 'number' }], rows: [[2]] },
          },
        ],
      }),
    );
    const result = await defaultExecutionRunners.ai(
      ctx,
      'project',
      selection,
      expected,
      new AbortController().signal,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.outputs).toMatchObject([
      { kind: 'table', outputKey: 'result', table: { rows: [[2]] } },
    ]);
    expect(chat.mock.calls[1]![0].messages.at(-1)?.content).toContain('严格按声明');
  });
});
