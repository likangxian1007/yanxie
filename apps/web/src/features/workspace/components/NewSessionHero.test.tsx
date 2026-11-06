import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, HarnessSummary, Thread } from '@srh/shared';
import { api } from '@/lib/api';
import { harnessKeys } from '@/lib/harness';
import { NewSessionHero } from './NewSessionHero';

const PROFILE: AgentProfile = {
  id: 'builtin:idea-brainstorm',
  projectId: null,
  scope: 'builtin',
  ownerUserId: null,
  slug: 'idea-brainstorm',
  name: '选题与 Idea 头脑风暴',
  description: '发散再收敛',
  icon: 'lightbulb',
  prompt: '',
  skills: [],
  starters: [],
  effort: 'max',
  updatedAt: null,
};

const SUMMARY: HarnessSummary = {
  catalog: {
    defaultModel: 'ds/pro',
    defaultEffort: 'high',
    providers: [
      {
        id: 'ds',
        projectId: null,
        source: 'env',
        name: '测试模型',
        baseUrl: '',
        thinkingFormat: 'none',
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
  commands: [],
  skills: [],
  profiles: [PROFILE],
};

const THREAD = {
  id: 'thr_new',
  projectId: 'prj_1',
  kind: 'personal',
  agentSessionId: 'ags_1',
} as Thread;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(harnessKeys.summary('prj_1'), SUMMARY);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NewSessionHero
          projectId="prj_1"
          autoFocus={false}
          firstTime={false}
          showBack={false}
          writable
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('combobox') as HTMLTextAreaElement;
}

describe('NewSessionHero', () => {
  afterEach(() => vi.restoreAllMocks());

  it('选了模型、强度与角色：随建会话一起发出，不再事后 PATCH 会话设置', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(THREAD);
    const patch = vi.spyOn(api, 'patch');
    const input = setup();
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    fireEvent.click(screen.getByRole('button', { name: '推理强度：高' }));
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    fireEvent.click(screen.getByRole('radio', { name: /选题与 Idea 头脑风暴/u }));
    fireEvent.change(input, { target: { value: '帮我想几个选题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/projects/prj_1/threads', {
        body: '帮我想几个选题',
        profile: 'idea-brainstorm',
        model: 'ds/other',
        effort: 'high',
      }),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it('只选角色时不覆盖角色推荐强度，新建失败保留草稿', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('网络错误'));
    const input = setup();
    fireEvent.click(screen.getByRole('button', { name: /模型与推理强度/ }));
    fireEvent.click(screen.getByRole('button', { name: /科研角色.*通用/ }));
    fireEvent.click(screen.getByRole('radio', { name: /选题与 Idea 头脑风暴/u }));
    expect(screen.getByRole('slider', { name: '推理强度' })).toHaveAttribute(
      'aria-valuetext',
      '最高',
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    fireEvent.change(input, { target: { value: '保留这段文字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/projects/prj_1/threads', {
        body: '保留这段文字',
        profile: 'idea-brainstorm',
      }),
    );
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(input).toHaveValue('保留这段文字');
  });

  it('没选 profile：不带 profile 字段', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(THREAD);
    const input = setup();
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/projects/prj_1/threads', { body: '你好' }),
    );
  });
});
