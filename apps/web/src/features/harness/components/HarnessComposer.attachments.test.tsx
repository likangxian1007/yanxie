import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AgentSession, HarnessSummary, SlashCommand } from '@srh/shared';
import type { ComposerSubmit } from '@/components/chat/Composer';
import { useToastStore } from '@/components/ui/toast-store';
import { billingKeys } from '@/features/billing/api';
import { harnessKeys } from '@/lib/harness';
import { qk } from '@/lib/query-keys';
import { HarnessComposer } from './HarnessComposer';

const command = (name: string, kind: SlashCommand['kind']): SlashCommand => ({
  id: `builtin:${name}`,
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  name,
  description: '',
  argumentHint: '',
  kind,
  template: '',
  updatedAt: null,
});

const summary: HarnessSummary = {
  catalog: { defaultModel: 'ds/pro', defaultEffort: 'high', providers: [] },
  commands: [command('stop', 'client'), command('goal', 'prompt')],
  skills: [],
  profiles: [],
};

const agent: AgentSession = {
  id: 'agent',
  projectId: 'attachment-project',
  threadId: 'attachment-thread',
  role: 'thread',
  status: 'idle',
  model: 'ds/pro',
  activity: null,
  workingForUserId: null,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  effort: null,
  profile: null,
  goal: null,
  lastActivityAt: '2026-10-27T00:00:00.000Z',
  createdAt: '2026-10-27T00:00:00.000Z',
};

function fileResponse(id: string) {
  return {
    ok: true,
    json: async () => ({
      id,
      projectId: 'attachment-project',
      name: '数据.csv',
      path: 'uploads/数据.csv',
      mime: 'text/csv',
      size: 1,
      uploadedBy: { kind: 'user', id: 'u', name: '成员' },
      createdAt: '2026-10-27T00:00:00.000Z',
    }),
  } as Response;
}

function setup(userId: string, onSubmit: (message: ComposerSubmit) => void, onStop?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(harnessKeys.summary('attachment-project'), summary);
  // 积分提示的请求不要占用下面打桩的 fetch
  client.setQueryData(billingKeys.me, { enabled: false, exempt: false, balance: 0 });
  client.setQueryData(billingKeys.project('attachment-project'), {
    enabled: false,
    exempt: false,
  });
  client.setQueryData(qk.me, {
    user: {
      id: userId,
      name: '成员',
      email: 'member@example.test',
      avatarColor: 0,
      avatarUrl: null,
    },
    projects: [],
  });
  function Subject() {
    const [value, setValue] = useState('');
    return (
      <HarnessComposer
        projectId="attachment-project"
        threadId="attachment-thread"
        agent={agent}
        writable
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        onStop={onStop}
      />
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <Subject />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  useToastStore.setState({ items: [] });
});

describe('HarnessComposer 附件', () => {
  it('尚未建立的个人会话不显示附件入口', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(harnessKeys.summary('attachment-project'), summary);
    client.setQueryData(qk.me, {
      user: { id: 'u-new-session', name: '成员', email: 'member@example.test', avatarColor: 0 },
      projects: [],
    });
    render(
      <QueryClientProvider client={client}>
        <HarnessComposer
          projectId="attachment-project"
          threadId={null}
          agent={null}
          personal
          writable
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          newSessionSettings={{ value: {}, onChange: vi.fn() }}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: '添加课题共享文件' })).not.toBeInTheDocument();
  });

  it('选择前说明共享范围，上传中阻止发送，完成后连同消息发送', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      ),
    );
    const submit = vi.fn();
    setup('u-harness-submit', submit);
    expect(screen.getByRole('button', { name: '添加课题共享文件' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('选择课题共享文件'), {
      target: { files: [new File(['a'], '数据.csv')] },
    });
    expect(screen.getByText('文件上传到课题共享文件夹，课题成员可访问。')).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '/goal 分析数据' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    await act(async () => finish(fileResponse('uploaded')));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith({
      body: '/goal 分析数据',
      agentVisible: true,
      fileIds: ['uploaded'],
    });
    expect(screen.getByText('数据.csv')).toBeInTheDocument();
  });

  it('文件上传失败时阻止发送，重试成功后才允许发送', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(fileResponse('retried')),
    );
    const submit = vi.fn();
    setup('u-harness-error', submit);
    fireEvent.change(screen.getByLabelText('选择课题共享文件'), {
      target: { files: [new File(['a'], '数据.csv')] },
    });
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '请分析' } });
    expect(await screen.findByText('请重试或移除上传失败的文件后发送。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith({
      body: '请分析',
      agentVisible: true,
      fileIds: ['retried'],
    });
  });

  it('待发送的图片显示缩略图，读不出来时退回文件图标', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    const create = vi.fn(() => 'blob:preview');
    const revoke = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    setup('u-harness-image', vi.fn());
    fireEvent.change(screen.getByLabelText('选择课题共享文件'), {
      target: {
        files: [new File(['a'], '图.png', { type: 'image/png' }), new File(['b'], '数据.csv')],
      },
    });
    const previews = screen.getAllByTestId('pending-image-preview');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toHaveAttribute('src', 'blob:preview');
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.error(previews[0]!);
    await waitFor(() => expect(screen.queryByTestId('pending-image-preview')).toBeNull());
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    expect(screen.getByText('图.png')).toBeInTheDocument();
  });

  it('执行客户端斜杠命令时保留上传中的文件，并提示文件仍在草稿', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      ),
    );
    const submit = vi.fn();
    const stop = vi.fn();
    setup('u-harness-command', submit, stop);
    fireEvent.change(screen.getByLabelText('选择课题共享文件'), {
      target: { files: [new File(['a'], '数据.csv')] },
    });
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '/stop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText('数据.csv')).toBeInTheDocument();
    expect(useToastStore.getState().items.at(-1)?.title).toBe('附件留在草稿');
    await act(async () => finish(fileResponse('after-command')));
    fireEvent.change(input, { target: { value: '请分析' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledWith({
      body: '请分析',
      agentVisible: true,
      fileIds: ['after-command'],
    });
  });
});
