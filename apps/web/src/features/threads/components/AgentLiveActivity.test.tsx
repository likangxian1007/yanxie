import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentStep, Message } from '@srh/shared';
import { AgentLiveActivityView } from './AgentLiveActivity';
import { IDLE_HINT_MS, LIVE_OPEN_KEY, deriveLiveState } from '../live-activity';

let n = 0;
const step = (kind: AgentStep['kind'], over: Partial<AgentStep> = {}): AgentStep => {
  n += 1;
  return {
    id: `st_${n}`,
    sessionId: 'agt_1',
    turnId: 't1',
    index: n,
    kind,
    name: null,
    content: '',
    data: {},
    createdAt: '2026-10-26T08:00:00Z',
    ...over,
  };
};

const T0 = new Date('2026-10-26T08:00:00Z').getTime();

const agent = (over: Partial<AgentSession> = {}): AgentSession =>
  ({
    id: 'agt_1',
    projectId: 'prj_1',
    threadId: null,
    role: 'coordinator',
    status: 'running',
    model: 'm',
    activity: null,
    lastActivityAt: '2026-10-26T08:00:00Z',
    createdAt: '2026-10-26T07:00:00Z',
    tokenUsage: null,
    ...over,
  }) as unknown as AgentSession;

const BUSY_STEPS: AgentStep[] = [
  step('thinking', { content: '先看看开题报告里写了什么' }),
  step('tool_call', {
    name: 'create_experiment',
    content: '{"title":"消融：去掉增强"}',
    data: { callId: 'c1' },
    createdAt: '2026-10-26T08:00:05Z',
  }),
  step('tool_result', {
    name: 'create_experiment',
    content: '{"ok":true,"experiment_id":"exp_1","version":1}',
    data: { callId: 'c1', ok: true },
    createdAt: '2026-10-26T08:00:06Z',
  }),
];

function renderView(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
});

describe('AgentLiveActivity', () => {
  it('工作中：显示动画状态、计时和工作过程（默认展开）', () => {
    const now = T0 + 12_000;
    const state = deriveLiveState({
      agent: agent({ activity: '正在读文档' }),
      steps: BUSY_STEPS,
      messages: [],
      sentAt: null,
      now,
    });
    expect(state.live).toBe(true);
    renderView(<AgentLiveActivityView state={state} now={now} />);
    expect(screen.getByRole('status').textContent).toContain('正在读文档');
    expect(screen.getByText('12s')).toBeTruthy();
    const toggle = screen.getByRole('button', { expanded: true });
    expect(toggle).toBeTruthy();
    expect(screen.getByText(/先看看开题报告/u)).toBeTruthy();
    expect(screen.getByText('新建了实验记录「消融：去掉增强」')).toBeTruthy();
    expect(document.body.textContent).not.toContain('create_experiment');
  });

  it('发出后还没回复：显示等待；超过 20s 提示还没开始处理', () => {
    const sentAt = T0 + 60_000;
    const early = deriveLiveState({
      agent: agent({ status: 'idle' }),
      steps: BUSY_STEPS,
      messages: [],
      sentAt,
      now: sentAt + 3000,
    });
    expect(early.live).toBe(true);
    expect(early.label).toContain('已发送');
    expect(early.turnSteps).toHaveLength(0);
    expect(early.error).toBeNull();
    const late = deriveLiveState({
      agent: agent({ status: 'idle' }),
      steps: BUSY_STEPS,
      messages: [],
      sentAt,
      now: sentAt + IDLE_HINT_MS + 1000,
    });
    expect(late.error?.title).toBe('协调者还没开始处理');
  });

  it('折叠后记住选择；结束后收成「已完成 · N 步 · 用时」并可再展开', () => {
    const now = T0 + 5000;
    const live = deriveLiveState({
      agent: agent(),
      steps: BUSY_STEPS,
      messages: [],
      sentAt: null,
      now,
    });
    const { unmount } = renderView(<AgentLiveActivityView state={live} now={now} />);
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
    expect(localStorage.getItem(LIVE_OPEN_KEY)).toBe('0');
    expect(screen.queryByText(/先看看开题报告/u)).toBeNull();
    unmount();

    const reply: Message = {
      id: 'msg_1',
      author: { kind: 'agent', id: 'agt_1', name: '研协' },
      createdAt: '2026-10-26T08:00:07Z',
    } as unknown as Message;
    const done = deriveLiveState({
      agent: agent({ status: 'idle' }),
      steps: BUSY_STEPS,
      messages: [reply],
      sentAt: T0 - 1000,
      now: T0 + 30_000,
    });
    expect(done.live).toBe(false);
    expect(done.error).toBeNull();
    renderView(<AgentLiveActivityView state={done} now={T0 + 30_000} />);
    const summary = screen.getByRole('button', { expanded: false });
    expect(summary.textContent).toContain('已完成');
    expect(summary.textContent).toContain('2 步');
    expect(summary.textContent).toContain('用时 6s');
    fireEvent.click(summary);
    expect(screen.getByText(/先看看开题报告/u)).toBeTruthy();
  });

  it('出错停下：红字说明原因，点「重试」让它接着做', () => {
    const steps = [
      ...BUSY_STEPS,
      step('note', {
        name: 'error',
        content: '出错：模型接口超时',
        createdAt: '2026-10-26T08:00:09Z',
      }),
    ];
    const state = deriveLiveState({
      agent: agent({ status: 'failed' }),
      steps,
      messages: [],
      sentAt: null,
      now: T0 + 20_000,
    });
    const onRetry = vi.fn();
    renderView(<AgentLiveActivityView state={state} now={T0 + 20_000} onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('这一轮出错停下了');
    expect(alert.textContent).toContain('模型接口超时');
    fireEvent.click(screen.getByRole('button', { name: /重试/u }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('工具调用失败、一轮结束没回复都给出说明', () => {
    const failed = deriveLiveState({
      agent: agent(),
      steps: [
        step('tool_call', { name: 'edit_document', content: '{}', data: { callId: 'c9' } }),
        step('tool_result', {
          name: 'edit_document',
          content: '{"error":"文档里找不到这段原文"}',
          data: { callId: 'c9', ok: false },
        }),
      ],
      messages: [],
      sentAt: null,
      now: T0 + 1000,
    });
    expect(failed.error?.kind).toBe('step');
    expect(failed.error?.reason).toBe('文档里找不到这段原文');

    const noReply = deriveLiveState({
      agent: agent({ status: 'idle' }),
      steps: BUSY_STEPS,
      messages: [],
      sentAt: T0 - 1000,
      now: T0 + 30_000,
    });
    expect(noReply.error?.kind).toBe('noReply');
  });

  it('出错已由页面横幅处理时不重复「重试」按钮', () => {
    const state = deriveLiveState({
      agent: agent({ status: 'stopped' }),
      steps: BUSY_STEPS,
      messages: [],
      sentAt: null,
      now: T0 + 20_000,
    });
    renderView(
      <AgentLiveActivityView
        state={state}
        now={T0 + 20_000}
        onRetry={() => undefined}
        haltedHandled
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('已被停止');
    expect(screen.queryByRole('button', { name: /重试/u })).toBeNull();
  });
});
