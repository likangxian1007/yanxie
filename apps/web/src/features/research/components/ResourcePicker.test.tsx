import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ResourcePicker } from './ResourcePicker';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['document', 'docs'],
  ['paper', 'library/papers'],
] as const)('研究资源仅请求团队空间的 %s', async (kind, path) => {
  const get = vi.spyOn(api, 'get').mockResolvedValue([{ id: 'resource_team', title: '团队材料' }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ResourcePicker pid="prj_team" fixedKind={kind} value={null} onChange={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole('option', { name: '团队材料' })).toBeInTheDocument());
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith(`/projects/prj_team/${path}?space=team`, {
    signal: expect.any(AbortSignal),
  });
  client.clear();
});

it('添加图像时可直接上传文件', () => {
  vi.spyOn(api, 'get').mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container, unmount } = render(
    <QueryClientProvider client={client}>
      <ResourcePicker
        pid="prj_team"
        fixedKind="file"
        allowUpload
        value={null}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(container.querySelector('input[type="file"]')).not.toBeNull();
  unmount();
  client.clear();
});
