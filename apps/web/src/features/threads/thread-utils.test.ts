import { describe, expect, it } from 'vitest';
import type { AgentStep, Message, OutputRef, Review, Thread } from '@srh/shared';
import {
  changeTarget,
  collectChanges,
  collectOutputs,
  countByBucket,
  flattenSteps,
  formatTokens,
  groupStepsByTurn,
  isChangeStep,
  reviewsForThread,
  sortThreads,
  threadsInBucket,
} from './thread-utils';

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'prj_1',
    kind: 'project',
    rootMessageId: `msg_${id}`,
    title: `线程 ${id}`,
    label: null,
    ownerUserId: null,
    statusBucket: 'working',
    statusText: '',
    resolved: false,
    replyCount: 0,
    forwardedAt: null,
    agentSessionId: null,
    lastActivityAt: '2026-10-26T08:00:00Z',
    createdAt: '2026-10-26T07:00:00Z',
    ...extra,
  };
}

function step(id: string, extra: Partial<AgentStep> = {}): AgentStep {
  return {
    id,
    sessionId: 'ses_1',
    turnId: 't1',
    index: 0,
    kind: 'text',
    name: null,
    content: '',
    data: {},
    createdAt: '2026-10-26T08:00:00Z',
    ...extra,
  };
}

function message(id: string, outputs: OutputRef[], createdAt: string): Message {
  return {
    id,
    projectId: 'prj_1',
    threadId: 'thr_1',
    author: { kind: 'agent', id: 'ses_1', name: '线程 agent' },
    kind: 'text',
    body: '',
    meta: {},
    agentVisible: true,
    reactions: [],
    outputs,
    rootOfThreadId: null,
    editedAt: null,
    createdAt,
  };
}

describe('threadsInBucket / countByBucket', () => {
  const list = [
    thread('a', { statusBucket: 'working', title: '调研扩散模型' }),
    thread('b', { statusBucket: 'completed', resolved: true, label: '实验' }),
    thread('c', { statusBucket: 'blocked' }),
    thread('p', { kind: 'personal' }),
  ];

  it('默认隐藏已解决，但“已完成”里照样显示', () => {
    const f = { query: '', showResolved: false };
    expect(threadsInBucket(list, 'all', f).map((t) => t.id)).toEqual(['a', 'c']);
    expect(threadsInBucket(list, 'completed', f).map((t) => t.id)).toEqual(['b']);
    expect(threadsInBucket(list, 'all', { ...f, showResolved: true })).toHaveLength(3);
  });

  it('按标题或标签搜索，个人会话永远不出现', () => {
    expect(
      threadsInBucket(list, 'all', { query: '扩散', showResolved: true }).map((t) => t.id),
    ).toEqual(['a']);
    expect(
      threadsInBucket(list, 'all', { query: '实验', showResolved: true }).map((t) => t.id),
    ).toEqual(['b']);
  });

  it('各分组计数', () => {
    const counts = countByBucket(list, { query: '', showResolved: false });
    expect(counts).toMatchObject({ all: 2, working: 1, blocked: 1, completed: 1, failed: 0 });
  });
});

describe('sortThreads', () => {
  it('置顶在前（按置顶顺序），其余按最近活动新到旧', () => {
    const list = [
      thread('old', { lastActivityAt: '2026-10-20T00:00:00Z' }),
      thread('new', { lastActivityAt: '2026-10-26T00:00:00Z' }),
      thread('pin', { lastActivityAt: '2026-10-01T00:00:00Z' }),
    ];
    expect(sortThreads(list, ['pin']).map((t) => t.id)).toEqual(['pin', 'new', 'old']);
  });
});

describe('agent 步骤', () => {
  it('分页（每页新→旧）展开成旧→新并去重', () => {
    const s1 = step('s1', { createdAt: '2026-10-26T08:00:00Z' });
    const s2 = step('s2', { createdAt: '2026-10-26T08:01:00Z' });
    const s3 = step('s3', { createdAt: '2026-10-26T08:02:00Z' });
    const pages = [
      { items: [s3, s2], nextCursor: 'c' },
      { items: [s2, s1], nextCursor: null },
    ];
    expect(flattenSteps(pages).map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('按 turnId 连续分组并编号', () => {
    const turns = groupStepsByTurn([
      step('a', { turnId: 't1' }),
      step('b', { turnId: 't1' }),
      step('c', { turnId: 't2' }),
    ]);
    expect(turns.map((t) => [t.ordinal, t.steps.length])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it('识别写入类工具调用并找出目标', () => {
    const write = step('w', {
      kind: 'tool_call',
      name: 'write_file',
      content: 'write_file({"path":"configs/exp_c.yaml"})',
    });
    const read = step('r', { kind: 'tool_call', name: 'read_file' });
    expect(isChangeStep(write)).toBe(true);
    expect(isChangeStep(read)).toBe(false);
    expect(changeTarget(write)).toBe('configs/exp_c.yaml');
    expect(
      changeTarget(
        step('x', { kind: 'tool_call', name: 'edit_document', data: { args: { title: '草稿' } } }),
      ),
    ).toBe('草稿');
    expect(
      changeTarget(step('y', { kind: 'tool_call', name: 'commit', data: { ref: 'main' } })),
    ).toBe('main');
  });

  it('改动配上同一轮紧随其后的结果，新→旧排列', () => {
    const steps = [
      step('c1', { kind: 'tool_call', name: 'write_file', createdAt: '2026-10-26T08:00:00Z' }),
      step('r1', {
        kind: 'tool_result',
        name: 'write_file',
        data: { ok: true },
        createdAt: '2026-10-26T08:00:01Z',
      }),
      step('c2', {
        kind: 'tool_call',
        name: 'edit_document',
        turnId: 't2',
        createdAt: '2026-10-26T09:00:00Z',
      }),
    ];
    const changes = collectChanges(steps);
    expect(changes.map((c) => c.step.id)).toEqual(['c2', 'c1']);
    expect(changes[1]?.result?.id).toBe('r1');
    expect(changes[0]?.result).toBeNull();
  });
});

describe('collectOutputs', () => {
  it('新→旧，同一对象只留一次', () => {
    const doc: OutputRef = { id: 'o1', kind: 'document', ref: 'doc_1', title: '草稿' };
    const file: OutputRef = { id: 'o2', kind: 'file', ref: 'file_1', title: 'a.csv' };
    const out = collectOutputs([
      message('m1', [doc], '2026-10-26T08:00:00Z'),
      message('m2', [file, { ...doc, id: 'o3' }], '2026-10-26T09:00:00Z'),
    ]);
    expect(out.map((o) => [o.output.id, o.message.id])).toEqual([
      ['o2', 'm2'],
      ['o3', 'm2'],
    ]);
  });
});

describe('reviewsForThread', () => {
  const r = (id: string, targetId: string, createdAt: string): Review => ({
    id,
    projectId: 'prj_1',
    targetKind: 'thread',
    targetId,
    title: id,
    summary: '',
    requestedBy: { kind: 'user', id: 'u1', name: 'kk' },
    status: 'open',
    reviewers: [],
    threadId: null,
    snapshot: null,
    commentCount: 0,
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
  });

  it('兼容数组和 Page，只留指向本线程的，新→旧', () => {
    const list = [
      r('a', 'thr_1', '2026-10-01T00:00:00Z'),
      r('b', 'thr_2', '2026-10-02T00:00:00Z'),
      r('c', 'thr_1', '2026-10-03T00:00:00Z'),
    ];
    expect(reviewsForThread(list, 'thr_1').map((x) => x.id)).toEqual(['c', 'a']);
    expect(reviewsForThread({ items: list, nextCursor: null }, 'thr_1')).toHaveLength(2);
    expect(reviewsForThread(undefined, 'thr_1')).toEqual([]);
  });
});

describe('formatTokens', () => {
  it('万以上换成“万”', () => {
    expect(formatTokens(8400)).toBe('8,400');
    expect(formatTokens(96_300)).toBe('9.6 万');
    expect(formatTokens(2_000_000)).toBe('200 万');
  });
});
