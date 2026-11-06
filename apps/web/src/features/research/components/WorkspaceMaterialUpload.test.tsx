import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { FileObject, ResearchSnapshot, ResearchSource } from '@srh/shared';
import * as uploads from '@/features/docs/import/api';
import { api } from '@/lib/api';
import { researchApi } from '../data';
import { WorkspaceMaterialUpload } from './WorkspaceMaterialUpload';

afterEach(() => vi.restoreAllMocks());
function mount(onUploaded = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceMaterialUpload pid="prj_a" onUploaded={onUploaded} />
    </QueryClientProvider>,
  );
  return onUploaded;
}
it('先保存项目原件和完整快照，再把同一原件交给研究引用', async () => {
  const original = { id: 'fil_a', path: 'research-materials/example/input.csv' } as FileObject;
  vi.spyOn(uploads, 'uploadProjectFile').mockResolvedValue(original);
  const source = vi
    .spyOn(researchApi, 'createSource')
    .mockResolvedValue({ id: 'rsr_a' } as ResearchSource);
  const snapshot = vi
    .spyOn(researchApi, 'createSnapshot')
    .mockResolvedValue({ id: 'rss_a' } as ResearchSnapshot);
  const uploaded = mount();
  fireEvent.change(screen.getByLabelText('上传研究材料文件'), {
    target: { files: [new File(['value,unit\n1,mm'], 'input.csv', { type: 'text/csv' })] },
  });
  await waitFor(() => expect(uploaded).toHaveBeenCalledWith(original));
  expect(source).toHaveBeenCalledWith(
    'prj_a',
    expect.objectContaining({ kind: 'file', resourceId: 'fil_a', title: 'input.csv' }),
  );
  expect(snapshot).toHaveBeenCalledWith(
    'prj_a',
    'rsr_a',
    expect.objectContaining({ coverage: 'complete' }),
  );
});
it('快照失败后的重试复用上传路径和证据幂等键，不重复已有文件', async () => {
  let path = '';
  vi.spyOn(uploads, 'uploadProjectFile').mockImplementation(async (_pid, next) => {
    path = next;
    throw new Error('响应丢失');
  });
  vi.spyOn(api, 'get').mockImplementation(async () => [{ id: 'fil_a', path }] as never);
  const source = vi
    .spyOn(researchApi, 'createSource')
    .mockResolvedValue({ id: 'rsr_a' } as ResearchSource);
  vi.spyOn(researchApi, 'createSnapshot')
    .mockRejectedValueOnce(new Error('快照暂时失败'))
    .mockResolvedValueOnce({ id: 'rss_a' } as ResearchSnapshot);
  const uploaded = mount();
  fireEvent.change(screen.getByLabelText('上传研究材料文件'), {
    target: { files: [new File(['public text'], 'source.txt', { type: 'text/plain' })] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('快照暂时失败');
  expect(uploaded).not.toHaveBeenCalled();
  const firstKey = (source.mock.calls[0]![1] as { idempotencyKey: string }).idempotencyKey;
  const firstPath = path;
  fireEvent.click(screen.getByRole('button', { name: '重试上传' }));
  await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
  expect(path).toBe(firstPath);
  expect((source.mock.calls[1]![1] as { idempotencyKey: string }).idempotencyKey).toBe(firstKey);
});
