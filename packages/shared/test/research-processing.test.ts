import { expect, it } from 'vitest';
import {
  ResearchAction,
  ResearchExecutionSettings,
  ResearchProcessingExecution,
  ResearchRunAnswerInput,
} from '../src';

it('新增自动处理配置不会把旧步骤静默升级，旧具名输出保持兼容', () => {
  const old = ResearchAction.parse({
    kind: 'ai',
    operation: 'extract_table',
    outputs: [{ key: 'result', kind: 'table' }],
  });
  expect(old.processing).toBeUndefined();
  expect(old.outputs).toEqual([{ key: 'result', kind: 'table' }]);
  expect(ResearchExecutionSettings.parse({})).toEqual({ model: null, effort: null, profile: null });
});

it('同一自动处理步骤可以要求笔记、表格与真实数据图，锁定配置不丢失', () => {
  const action = ResearchAction.parse({
    kind: 'ai',
    processing: {
      mode: 'auto',
      expectedOutputs: ['note', 'table', 'figure'],
      locks: {
        transform: {
          groupBy: ['category'],
          aggregates: [{ columnId: 'mass', op: 'sum', as: '总质量' }],
        },
        chart: { kind: 'bar', xColumn: 'category', yColumns: ['total'], missing: 'error' },
      },
    },
  });
  expect(action.processing?.locks?.chart?.missing).toBe('error');
  expect(action.processing?.expectedOutputs).toEqual(['note', 'table', 'figure']);
});

it('澄清保留实际成员回答和执行版本，不把等待当作人工批准', () => {
  const state = ResearchProcessingExecution.parse({
    version: 3,
    phase: 'waiting',
    fingerprint: 'same-structure',
    reused: false,
    plan: null,
    steps: [],
    question: { questionId: 'q2', question: '需要哪一列？', reason: 'ambiguous' },
    answers: [
      {
        questionId: 'q1',
        question: '保留缺失吗？',
        answer: '保留为空',
        actor: { kind: 'user', id: 'u1', name: '研究者' },
        answeredAt: '2026-11-01T00:00:00Z',
        idempotencyKey: 'answer_001',
      },
    ],
  });
  expect(state.answers[0]?.actor.kind).toBe('user');
  expect(state.intermediates).toEqual([]);
  expect(
    ResearchRunAnswerInput.parse({
      questionId: 'q2',
      answer: '质量',
      baseVersion: state.version,
      idempotencyKey: 'answer_002',
    }).baseVersion,
  ).toBe(3);
  expect(
    ResearchRunAnswerInput.safeParse({
      questionId: 'q2',
      answer: ' ',
      baseVersion: 3,
      idempotencyKey: 'answer_002',
    }).success,
  ).toBe(false);
});
