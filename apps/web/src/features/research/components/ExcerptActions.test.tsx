import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResearchFinding } from '@srh/shared';
import { researchApi } from '../data';
import { ExcerptActions } from './ExcerptActions';

afterEach(() => vi.restoreAllMocks());
it('聚焦摘录可作为反例加入已有结论，保留既有依据与版本检查', async () => {
  const finding = {
    id: 'f1',
    statement: '初步结论',
    supportingExcerptIds: ['e0'],
    counterExcerptIds: [],
    contextExcerptIds: [],
    version: 3,
  } as unknown as ResearchFinding;
  vi.spyOn(researchApi, 'findings').mockResolvedValue([finding]);
  const update = vi.spyOn(researchApi, 'updateFinding').mockResolvedValue(finding);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ExcerptActions pid="p1" recordId="r1" excerptId="e1" writable />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '用于结论' }));
  await screen.findByRole('option', { name: '初步结论' });
  fireEvent.change(screen.getByLabelText('选择结论'), { target: { value: 'f1' } });
  fireEvent.change(screen.getByLabelText('依据角色'), { target: { value: 'counterExcerptIds' } });
  fireEvent.click(screen.getByRole('button', { name: '保存依据' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith('p1', 'f1', { baseVersion: 3, counterExcerptIds: ['e1'] }),
  );
  expect(await screen.findByText('已加入结论依据；结论仍需人工判断。')).toBeTruthy();
});
