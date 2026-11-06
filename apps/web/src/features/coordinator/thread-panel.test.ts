import { describe, expect, it } from 'vitest';
import type { AgentSession, PresenceState, Thread, ThreadSummary } from '@srh/shared';
import {
  buildPanelThreads,
  filterByLabel,
  flatList,
  groupByLabel,
  labelChips,
  statusText,
  waitingOnMeCount,
} from './thread-panel';

const ME = 'usr_me';
const ZHANG = 'usr_zhang';
let seq = 0;

const thread = (patch: Partial<Thread> = {}): Thread => {
  seq += 1;
  return {
    id: `thr_${seq}`,
    projectId: 'prj_1',
    kind: 'project',
    rootMessageId: `msg_${seq}`,
    title: `线程${seq}`,
    label: null,
    ownerUserId: ME,
    statusBucket: 'idle',
    statusText: '',
    resolved: false,
    replyCount: 0,
    forwardedAt: null,
    agentSessionId: `agt_${seq}`,
    lastActivityAt: `2026-10-26T10:${String(seq).padStart(2, '0')}:00.000Z`,
    createdAt: '2026-10-26T09:00:00.000Z',
    ...patch,
  };
};

const agentFor = (t: Thread, patch: Partial<AgentSession> = {}): AgentSession => ({
  id: t.agentSessionId ?? 'agt_x',
  projectId: 'prj_1',
  threadId: t.id,
  role: 'thread',
  status: 'idle',
  model: 'deepseek-chat',
  effort: null,
  profile: null,
  goal: null,
  activity: null,
  workingForUserId: t.ownerUserId,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  lastActivityAt: t.lastActivityAt,
  createdAt: t.createdAt,
  ...patch,
});

describe('buildPanelThreads', () => {
  it('状态、进度、当前一步；个人会话不进面板', () => {
    const running = thread({
      statusBucket: 'working',
      statusText: ['目标', '✓ 一', '✓ 二', '✱ 写综述', '○ 送审'].join('\n'),
    });
    const halted = thread({ statusBucket: 'failed' });
    const personal = thread({ kind: 'personal' });
    const rows = buildPanelThreads({
      threads: [running, halted, personal],
      agents: [
        agentFor(running, { status: 'running', activity: '正在检索 arXiv' }),
        agentFor(halted, { status: 'failed' }),
      ],
      meId: ME,
    });
    expect(rows).toHaveLength(2);
    const [r0, r1] = rows;
    expect(r0).toMatchObject({
      status: { kind: 'running', label: '在跑' },
      progress: { done: 2, total: 4 },
      // 在跑时优先写 agent 的一句话动态
      current: '正在检索 arXiv',
    });
    expect(r1?.status).toMatchObject({ kind: 'halted', label: '已停下' });
  });

  it('agent 空闲但清单还有 ✱：等你回复，当前一步取 ✱ 行', () => {
    const t = thread({
      statusBucket: 'review_ready',
      statusText: ['目标', '✓ 检索', '✱ 等 kk 提供 PDF', '○ 写总结'].join('\n'),
    });
    const [row] = buildPanelThreads({ threads: [t], agents: [agentFor(t)], meId: ME });
    expect(row?.status.kind).toBe('waiting');
    expect(row?.current).toBe('等 kk 提供 PDF');
    // 没有服务端汇总：等 agent 为之工作的成员
    expect(row?.waitingOn).toEqual([ME]);
    expect(row?.waitingOnMe).toBe(true);
  });

  it('服务端汇总优先：在等别人、产出和未答决策；谁在看', () => {
    const t = thread({ statusBucket: 'blocked' });
    const summaries: ThreadSummary[] = [
      {
        threadId: t.id,
        outputs: 3,
        openDecisions: 1,
        waitingOn: [
          { userId: ZHANG, kind: 'decision', since: '2026-10-26T10:00:00.000Z' },
          { userId: ZHANG, kind: 'mention', since: '2026-10-26T10:01:00.000Z' },
        ],
      },
    ];
    const presence: PresenceState[] = [
      {
        userId: ZHANG,
        name: '张三',
        avatarColor: 2,
        view: 'thread',
        objectId: t.id,
        activity: 'typing',
        lastSeenAt: '2026-10-26T10:00:00.000Z',
      },
      // 自己不算“谁在看”
      {
        userId: ME,
        name: 'kk',
        avatarColor: 1,
        view: 'thread',
        objectId: t.id,
        activity: 'viewing',
        lastSeenAt: '2026-10-26T10:00:00.000Z',
      },
    ];
    const [row] = buildPanelThreads({
      threads: [t],
      agents: [agentFor(t)],
      summaries,
      presence,
      meId: ME,
    });
    expect(row).toMatchObject({
      outputs: 3,
      openDecisions: 1,
      waitingOn: [ZHANG],
      waitingOnMe: false,
    });
    expect(row?.viewers).toEqual([{ userId: ZHANG, name: '张三', color: 2, typing: true }]);
    expect(statusText(row!, (id) => (id === ZHANG ? '张三' : undefined))).toBe('等 张三');
  });

  it('agent 空闲但有成员没处理 @：状态写成等那个人', () => {
    const t = thread({ statusBucket: 'idle' });
    const [row] = buildPanelThreads({
      threads: [t],
      agents: [agentFor(t)],
      summaries: [
        {
          threadId: t.id,
          outputs: 0,
          openDecisions: 0,
          waitingOn: [{ userId: ZHANG, kind: 'mention', since: '2026-10-26T10:00:00.000Z' }],
        },
      ],
      meId: ME,
    });
    expect(row?.status.kind).toBe('waiting');
    expect(statusText(row!, () => '张三')).toBe('等 张三');
  });

  it('只剩已解决线程的组排在后面', () => {
    const done = thread({ label: '甲', resolved: true, statusBucket: 'completed' });
    const live = thread({ label: '乙' });
    const groups = groupByLabel(buildPanelThreads({ threads: [done, live], agents: [], meId: ME }));
    expect(groups.map((g) => g.label)).toEqual(['乙', '甲']);
  });

  it('已解决的线程不在等任何人', () => {
    const t = thread({ resolved: true, statusBucket: 'completed' });
    const [row] = buildPanelThreads({
      threads: [t],
      agents: [],
      summaries: [
        {
          threadId: t.id,
          outputs: 0,
          openDecisions: 0,
          waitingOn: [{ userId: ME, kind: 'mention', since: '2026-10-26T10:00:00.000Z' }],
        },
      ],
      meId: ME,
    });
    expect(row?.waitingOn).toEqual([]);
    expect(row?.current).toBeNull();
  });
});

describe('筛选与分组', () => {
  const a1 = thread({ label: '文献', statusBucket: 'working' });
  const a2 = thread({ label: ' 文献 ', resolved: true, statusBucket: 'completed' });
  const b1 = thread({ label: '实验', statusBucket: 'idle' });
  const b2 = thread({
    label: '实验',
    statusBucket: 'review_ready',
    statusText: ['目标', '✱ 等你确认'].join('\n'),
  });
  const n1 = thread({ label: null });
  const rows = buildPanelThreads({
    threads: [a1, a2, b1, b2, n1],
    agents: [agentFor(a1, { status: 'running' }), agentFor(b1), agentFor(b2)],
    meId: ME,
  });

  it('标签筛选条：标签去空白后合并；计数只算未解决；未分类在最后', () => {
    expect(labelChips(rows)).toEqual([
      { label: '实验', count: 2, waitingOnMe: 1 },
      { label: '文献', count: 1, waitingOnMe: 0 },
      { label: '', count: 1, waitingOnMe: 0 },
    ]);
  });

  it('按标签筛选：null 是全部，空串是未分类', () => {
    expect(filterByLabel(rows, null)).toHaveLength(5);
    expect(filterByLabel(rows, '文献').map((r) => r.thread.id)).toEqual([a1.id, a2.id]);
    expect(filterByLabel(rows, '').map((r) => r.thread.id)).toEqual([n1.id]);
  });

  it('分组：已解决的单独收起；等你的排在最前；组头小结', () => {
    const groups = groupByLabel(rows);
    expect(groups.map((g) => g.label)).toEqual(['实验', '文献', '']);
    const exp = groups[0]!;
    expect(exp.active.map((r) => r.thread.id)).toEqual([b2.id, b1.id]);
    expect(exp.tally).toEqual([
      { kind: 'waiting', label: '等你', count: 1 },
      { kind: 'idle', label: '空闲', count: 1 },
    ]);
    const lit = groups[1]!;
    expect(lit.active.map((r) => r.thread.id)).toEqual([a1.id]);
    expect(lit.resolved.map((r) => r.thread.id)).toEqual([a2.id]);
  });

  it('平铺：未解决按“等你 → 在跑 → 其余”，已解决另列；等你计数', () => {
    const flat = flatList(rows);
    expect(flat.active.map((r) => r.thread.id)).toEqual([b2.id, a1.id, n1.id, b1.id]);
    expect(flat.resolved.map((r) => r.thread.id)).toEqual([a2.id]);
    expect(waitingOnMeCount(rows)).toBe(1);
  });
});
