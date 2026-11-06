import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProfile,
  AgentSession,
  AgentStopResult,
  HarnessSummary,
  SlashCommand,
} from '@srh/shared';
import { useToastStore } from '@/components/ui/toast-store';
import { api } from '@/lib/api';
import { harnessKeys } from '@/lib/harness';
import { qk } from '@/lib/query-keys';
import { stopResultTitle } from '../stop';
import { HarnessComposer } from './HarnessComposer';

const cmd = (name: string, kind: SlashCommand['kind'], argumentHint = ''): SlashCommand => ({
  id: `builtin:${name}`,
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  name,
  description: `${name} 说明`,
  argumentHint,
  kind,
  template: '',
  updatedAt: null,
});

const SUMMARY: HarnessSummary = {
  catalog: { defaultModel: 'ds/pro', defaultEffort: 'high', providers: [] },
  commands: [
    cmd('help', 'client'),
    cmd('clear', 'session'),
    cmd('goal', 'prompt', '<目标>'),
    cmd('forward', 'client'),
  ],
  skills: [],
  profiles: [],
};

const AGENT: AgentSession = {
  id: 'agt_1',
  projectId: 'prj_1',
  threadId: 'thr_1',
  role: 'thread',
  status: 'idle',
  model: 'ds/pro',
  activity: null,
  workingForUserId: null,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  effort: null,
  profile: null,
  goal: null,
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

const PROFILE: AgentProfile = {
  id: 'role',
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  slug: 'review',
  name: '论文审阅',
  description: '检查论证',
  icon: 'book',
  prompt: '',
  skills: [],
  starters: [],
  effort: 'high',
  updatedAt: null,
};

const SETTINGS_SUMMARY: HarnessSummary = {
  ...SUMMARY,
  catalog: {
    defaultModel: 'ds/pro',
    defaultEffort: 'high',
    providers: [
      {
        id: 'ds',
        projectId: null,
        source: 'env',
        name: '模型',
        baseUrl: '',
        thinkingFormat: 'openai',
        hasApiKey: true,
        enabled: true,
        createdAt: null,
        models: [
          {
            id: 'ds/pro',
            providerId: 'ds',
            model: 'pro',
            name: 'Pro',
            description: null,
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
          {
            id: 'ds/other',
            providerId: 'ds',
            model: 'other',
            name: 'Other',
            description: null,
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'low',
          },
        ],
      },
    ],
  },
  profiles: [PROFILE],
};

function Harness({
  onSubmit,
  onStop,
  projectId = 'prj_1',
}: {
  onSubmit: (b: string) => void;
  onStop?: () => void;
  projectId?: string;
}) {
  const [value, setValue] = useState('');
  return (
    <HarnessComposer
      projectId={projectId}
      threadId="thr_1"
      agent={AGENT}
      writable
      value={value}
      onChange={setValue}
      onSubmit={(m) => onSubmit(m.body)}
      onStop={onStop}
    />
  );
}

function setup(summary: HarnessSummary = SUMMARY, onStop?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(harnessKeys.summary('prj_1'), summary);
  qc.setQueryData<AgentSession[]>(qk.agents('prj_1'), [AGENT]);
  const onSubmit = vi.fn();
  const rendered = render(
    <QueryClientProvider client={qc}>
      <Harness onSubmit={onSubmit} onStop={onStop} />
    </QueryClientProvider>,
  );
  return {
    qc,
    onSubmit,
    input: screen.getByRole('combobox') as HTMLTextAreaElement,
    unmount: rendered.unmount,
  };
}

describe('HarnessComposer 斜杠菜单', () => {
  it('输入 / 弹出菜单（项目线程里没有 /forward），过滤后 Enter 插入 prompt 类指令', () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('/help'),
      expect.stringContaining('/clear'),
      expect.stringContaining('/goal'),
    ]);
    expect(input).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(input, { target: { value: '/go' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/goal ');
    expect(onSubmit).not.toHaveBeenCalled();
    // 敲了空格之后菜单关闭，Enter 正常发送
    // 退场动画期间节点还在，看组合框状态
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('↓ 移动高亮，Esc 关闭且同一段输入不再弹出', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // 上移回绕到最后一项
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Escape' });
    // 退场动画期间节点还在，看组合框状态
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(input, { target: { value: '/c' } });
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  it('输入法组合中的 Enter 不选菜单项', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(input.value).toBe('/');
  });

  it('未知指令和普通文字照常发送', () => {
    const { input, onSubmit } = setup();
    fireEvent.change(input, { target: { value: '/xyz 你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('/xyz 你好');
  });
});

describe('HarnessComposer /stop', () => {
  const WITH_STOP: HarnessSummary = {
    ...SUMMARY,
    commands: [...SUMMARY.commands, cmd('stop', 'client')],
  };

  beforeEach(() => {
    useToastStore.setState({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastToast = () => useToastStore.getState().items.at(-1);

  it('agent 看起来空闲也调 stop：取消了排队的一轮就照实说，并更新缓存', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ ...AGENT, status: 'stopped', stopped: 'queued' } as AgentStopResult);
    const { input, onSubmit, qc } = setup(WITH_STOP);
    fireEvent.change(input, { target: { value: '/stop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(lastToast()?.title).toBe('已取消排队中的这一轮'));
    expect(post).toHaveBeenCalledWith('/projects/prj_1/agents/agt_1/stop');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(qc.getQueryData<AgentSession[]>(qk.agents('prj_1'))?.[0]?.status).toBe('stopped');
  });

  it('确实没东西可停：说 agent 现在没在回复', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ ...AGENT, stopped: 'none' } as AgentStopResult);
    const { input } = setup(WITH_STOP);
    fireEvent.change(input, { target: { value: '/stop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(lastToast()?.title).toBe('agent 现在没在回复'));
  });

  it('页面给了停止回调（正在回复）就交给页面', () => {
    const post = vi.spyOn(api, 'post');
    const onStop = vi.fn();
    const { input } = setup(WITH_STOP, onStop);
    fireEvent.change(input, { target: { value: '/stop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('HarnessComposer 会话配置', () => {
  afterEach(() => vi.restoreAllMocks());

  it('串行保存连续选择，旧请求完成时继续显示并发送最新意图', async () => {
    let resolveFirst!: (value: AgentSession) => void;
    const first = new Promise<AgentSession>((resolve) => {
      resolveFirst = resolve;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, effort: 'max', profile: 'review' });
    setup(SETTINGS_SUMMARY);
    const trigger = screen.getByRole('button', { name: /模型与推理强度/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：最高' }));
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    fireEvent.click(screen.getByRole('radio', { name: '论文审阅' }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveAttribute('aria-label', expect.stringContaining('Pro · 最高'));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    resolveFirst({ ...AGENT, model: 'ds/other' });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_1/agents/agt_1/settings', {
      model: 'ds/pro',
      effort: 'max',
      profile: 'review',
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute('aria-label', expect.stringContaining('论文审阅')),
    );
    expect(trigger).toHaveAttribute('aria-label', expect.stringContaining('Pro · 最高'));
  });

  it('失败时保留选择和草稿，面板内可重试最新设置', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<AgentSession>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'high' });
    const { input } = setup(SETTINGS_SUMMARY);
    fireEvent.change(input, { target: { value: '还没有发送的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：最高' }));
    rejectFirst(new Error('网络错误'));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
    expect(input).toHaveValue('还没有发送的草稿');
    expect(screen.getByRole('button', { name: /模型与推理强度/ })).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Other'),
    );
    fireEvent.click(screen.getByRole('button', { name: '推理强度：高' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_1/agents/agt_1/settings', {
      model: 'ds/other',
      effort: 'high',
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(input).toHaveValue('还没有发送的草稿');
  });

  it('切换页面后仍完成已排队的最后一次选择', async () => {
    let resolveFirst!: (value: AgentSession) => void;
    const first = new Promise<AgentSession>((resolve) => {
      resolveFirst = resolve;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'max' });
    const { unmount } = setup(SETTINGS_SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：最高' }));
    unmount();
    resolveFirst({ ...AGENT, model: 'ds/other' });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_1/agents/agt_1/settings', {
      effort: 'max',
    });
  });

  it('旧请求未完成时重新进入同一会话，仍串行保存新的选择', async () => {
    let resolveFirst!: (value: AgentSession) => void;
    const first = new Promise<AgentSession>((resolve) => {
      resolveFirst = resolve;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'low' });
    const { unmount, qc } = setup(SETTINGS_SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：最高' }));
    unmount();
    render(
      <QueryClientProvider client={qc}>
        <Harness onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    expect(screen.getByRole('slider', { name: '推理强度' })).toHaveAttribute(
      'aria-valuetext',
      '最高',
    );
    fireEvent.click(screen.getByRole('button', { name: '推理强度：低' }));
    expect(patch).toHaveBeenCalledTimes(1);
    resolveFirst({ ...AGENT, model: 'ds/other' });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_1/agents/agt_1/settings', {
      effort: 'low',
    });
  });

  it('离开时保存失败，回到原会话仍能看到错误并重试', async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<AgentSession>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other' });
    const { unmount, qc } = setup(SETTINGS_SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    unmount();
    rejectFirst(new Error('网络错误'));
    await waitFor(() =>
      expect(useToastStore.getState().items.at(-1)?.title).toBe('没能修改会话设置'),
    );
    render(
      <QueryClientProvider client={qc}>
        <Harness onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('网络错误');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_1/agents/agt_1/settings', {
      model: 'ds/other',
    });
  });

  it('切换项目后旧队列仍只写入原项目和会话', async () => {
    let resolveFirst!: (value: AgentSession) => void;
    const first = new Promise<AgentSession>((resolve) => {
      resolveFirst = resolve;
    });
    const patch = vi
      .spyOn(api, 'patch')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...AGENT, projectId: 'prj_2', model: 'ds/other' })
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'max' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(harnessKeys.summary('prj_1'), SETTINGS_SUMMARY);
    qc.setQueryData(harnessKeys.summary('prj_2'), SETTINGS_SUMMARY);
    const rendered = render(
      <QueryClientProvider client={qc}>
        <Harness onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：最高' }));
    rendered.rerender(
      <QueryClientProvider client={qc}>
        <Harness projectId="prj_2" onSubmit={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(2, '/projects/prj_2/agents/agt_1/settings', {
      model: 'ds/other',
    });
    resolveFirst({ ...AGENT, model: 'ds/other' });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(3));
    expect(patch).toHaveBeenNthCalledWith(3, '/projects/prj_1/agents/agt_1/settings', {
      effort: 'max',
    });
  });

  it('带参数的斜杠指令仍可修改模型、强度与角色', async () => {
    const patch = vi
      .spyOn(api, 'patch')
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other' })
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'max' })
      .mockResolvedValueOnce({ ...AGENT, model: 'ds/other', effort: 'max', profile: 'review' });
    const { input } = setup({
      ...SETTINGS_SUMMARY,
      commands: [
        ...SUMMARY.commands,
        cmd('model', 'client'),
        cmd('effort', 'client'),
        cmd('profile', 'client'),
      ],
    });
    for (const [command, expected] of [
      ['/model Other', { model: 'ds/other' }],
      ['/effort 最高', { effort: 'max' }],
      ['/profile 论文审阅', { profile: 'review' }],
    ] as const) {
      fireEvent.change(input, { target: { value: command } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith('/projects/prj_1/agents/agt_1/settings', expected),
      );
    }
  });
});

describe('stopResultTitle', () => {
  it('按 stopped 给文案；旧服务端没有 stopped 时按状态猜', () => {
    expect(stopResultTitle({ status: 'stopped', stopped: 'turn' })).toBe('已停下');
    expect(stopResultTitle({ status: 'stopped', stopped: 'queued' })).toBe('已取消排队中的这一轮');
    expect(stopResultTitle({ status: 'idle', stopped: 'none' })).toBe('agent 现在没在回复');
    expect(stopResultTitle({ status: 'stopped' })).toBe('已停下');
    expect(stopResultTitle({ status: 'idle' })).toBe('agent 现在没在回复');
  });
});
