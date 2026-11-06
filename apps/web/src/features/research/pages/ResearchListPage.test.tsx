import { webcrypto } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResearchListItem } from '@srh/shared';
import { researchApi } from '../data';
import { workspaceApi } from '../workspace-data';
import { ResearchListPage } from './ResearchListPage';

vi.mock('@/lib/project', () => ({
  useProjectId: () => 'prj_a',
  useMyRole: () => 'owner',
  canWrite: () => true,
}));
vi.mock('@/lib/realtime', () => ({ useProjectEvent: () => undefined }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('HTTP 环境没有 randomUUID 时，只填研究问题也能创建', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  vi.spyOn(researchApi, 'list').mockResolvedValue([]);
  const create = vi
    .spyOn(workspaceApi, 'create')
    .mockResolvedValue({ id: 'rrc_a' } as Awaited<ReturnType<typeof workspaceApi.create>>);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/prj_a/research']}>
        <Routes>
          <Route path="/p/:projectId/research" element={<ResearchListPage />} />
          <Route path="/p/:projectId/research/:recordId" element={<p>研究工作区</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText('还没有研究空间');
  fireEvent.click(screen.getAllByRole('button', { name: '新建研究' })[0]!);
  expect(screen.queryByRole('link', { name: '管理模板' })).toBeNull();
  expect(screen.queryByLabelText('按方法筛选')).toBeNull();
  expect(screen.queryByLabelText('方法模板')).toBeNull();
  fireEvent.change(screen.getByLabelText('研究问题'), {
    target: { value: '如何改善社区健康服务？' },
  });
  fireEvent.click(screen.getByRole('button', { name: '创建研究' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      'prj_a',
      expect.objectContaining({ question: '如何改善社区健康服务？' }),
    ),
  );
  expect(await screen.findByText('研究工作区')).toBeTruthy();
});

it('只有旧实验时显示研究空状态，不重复列实验或提供模板入口', async () => {
  vi.spyOn(researchApi, 'list').mockResolvedValue([
    {
      kind: 'experiment',
      id: 'exp_old',
      title: '旧实验案例',
      status: 'running',
      method: null,
      projectId: 'prj_a',
      updatedAt: '2026-10-28T00:00:00Z',
      href: '',
    },
  ] satisfies ResearchListItem[]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/prj_a/research']}>
        <ResearchListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('还没有研究空间')).toBeTruthy();
  expect(screen.queryByText('旧实验案例')).toBeNull();
  expect(screen.queryByText('管理模板')).toBeNull();
  expect(screen.queryByLabelText('按方法筛选')).toBeNull();
  expect(screen.queryByText('没有符合条件的研究')).toBeNull();
});
