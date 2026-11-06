import { describe, expect, it } from 'vitest';
import type { AgentSession, Thread } from '@srh/shared';
import { threadDisplay } from './status';

const thread = (patch: Partial<Thread> = {}): Thread => ({
  id: 'thr_1',
  projectId: 'prj_1',
  kind: 'project',
  rootMessageId: 'msg_1',
  title: '调研',
  label: null,
  ownerUserId: 'usr_1',
  statusBucket: 'review_ready',
  statusText: ['调研', '✓ 检索', '✱ 写文档', '○ 送审'].join('\n'),
  resolved: false,
  replyCount: 1,
  forwardedAt: null,
  agentSessionId: 'agt_1',
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...patch,
});

const agent = (status: AgentSession['status']): AgentSession => ({
  id: 'agt_1',
  projectId: 'prj_1',
  threadId: 'thr_1',
  role: 'thread',
  status,
  model: 'deepseek-chat',
  activity: null,
  workingForUserId: null,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  effort: null,
  profile: null,
  goal: null,
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

describe('threadDisplay', () => {
  it('agent 出错或步数用完：显示已停下，不是待验收', () => {
    const d = threadDisplay(thread(), agent('failed'));
    expect(d).toMatchObject({ kind: 'halted', label: '已停下', dot: 'failed', needsResume: true });
  });

  it('桶为 failed 也显示已停下', () => {
    expect(threadDisplay(thread({ statusBucket: 'failed' }), agent('idle')).kind).toBe('halted');
  });

  it('被停止', () => {
    expect(threadDisplay(thread(), agent('stopped'))).toMatchObject({
      kind: 'stopped',
      label: '已停止',
    });
  });

  it('agent 空闲但清单还有 ✱：等你回复，不是待验收，也不弹停工提示', () => {
    expect(threadDisplay(thread(), agent('idle'))).toMatchObject({
      kind: 'awaiting',
      label: '等你回复',
      needsResume: false,
    });
  });

  it('清单走完的待验收保持待验收', () => {
    const t = thread({ statusText: ['调研', '✓ 检索', '✓ 写文档'].join('\n') });
    expect(threadDisplay(t, agent('idle'))).toMatchObject({
      kind: 'review_ready',
      label: '待验收',
    });
  });

  it('agent 在跑时一律进行中', () => {
    expect(threadDisplay(thread({ statusBucket: 'failed' }), agent('running')).kind).toBe(
      'working',
    );
  });

  it('已解决的线程按桶显示', () => {
    expect(
      threadDisplay(thread({ resolved: true, statusBucket: 'completed' }), agent('failed')).kind,
    ).toBe('completed');
  });
});
