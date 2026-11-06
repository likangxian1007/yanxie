import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResearchSnapshot, ResearchSource } from '@srh/shared';
import { researchApi } from '../data';
import { ResearchSourcePage } from './ResearchSourcePage';

vi.mock('@/lib/project', () => ({
  useProjectId: () => 'prj_a',
  useMyRole: () => 'owner',
  canWrite: () => true,
}));
vi.mock('@/lib/realtime', () => ({ useProjectEvent: () => undefined }));

const actor = { kind: 'user' as const, id: 'usr_a', name: '研究者' };
const source: ResearchSource = {
  id: 'rsr_a',
  projectId: 'prj_a',
  recordId: null,
  kind: 'file',
  resourceId: 'fil_a',
  title: '原件 A',
  citation: '',
  url: null,
  originalSourceId: null,
  archivedAt: null,
  version: 1,
  needsReview: false,
  createdBy: actor,
  updatedBy: actor,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const snapshot: ResearchSnapshot = {
  id: 'rss_a',
  projectId: 'prj_a',
  sourceId: source.id,
  version: 1,
  sourceVersion: source.version,
  sourceMetadata: source,
  coverage: 'complete',
  sha256: null,
  byteLength: 42,
  mime: 'text/plain',
  originalName: '原件 A.txt',
  text: null,
  createdBy: actor,
  createdAt: '2026-01-02T00:00:00.000Z',
};

function mount(item: ResearchSource, saved: ResearchSnapshot[]) {
  vi.spyOn(researchApi, 'sources').mockResolvedValue([item]);
  vi.spyOn(researchApi, 'records').mockResolvedValue([]);
  vi.spyOn(researchApi, 'snapshots').mockResolvedValue(saved);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/p/prj_a/research-sources/${item.id}`]}>
        <Routes>
          <Route path="/p/:projectId/research-sources/:sourceId" element={<ResearchSourcePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

it('原件丢失后仍可下载已固定的完整快照', async () => {
  vi.spyOn(researchApi, 'availability').mockResolvedValue({
    available: false,
    reason: 'missing',
    resourceKind: 'file',
    resourceId: 'fil_a',
    experimentId: null,
  });
  mount({ ...source, title: '改名后的原件', citation: '新版书目', version: 2 }, [
    { ...snapshot, sourceMetadata: { ...source, citation: '旧版书目' } },
  ]);
  expect(await screen.findByText(/原件已缺失或不可访问/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '下载历史版本' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: '打开项目原件' })).toBeNull();
  expect(screen.getByText(/快照时来源：原件 A · 第 1 版 · 旧版书目/)).toBeTruthy();
});

it('仅外部链接的快照显示元数据，不提供无效下载', async () => {
  vi.spyOn(researchApi, 'availability').mockResolvedValue({
    available: false,
    reason: 'external',
    resourceKind: 'url',
    resourceId: null,
    experimentId: null,
  });
  mount({ ...source, kind: 'url', resourceId: null, url: 'https://example.org/study' }, [
    { ...snapshot, coverage: 'external', byteLength: 0, sha256: null },
  ]);
  expect(await screen.findByText('仅存来源元数据，无原件下载')).toBeTruthy();
  expect(screen.getByRole('link', { name: '打开来源网址' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: '下载历史版本' })).toBeNull();
});

it('项目论文可打开原件并建立完整快照', async () => {
  vi.spyOn(researchApi, 'availability').mockResolvedValue({
    available: true,
    reason: 'available',
    resourceKind: 'paper',
    resourceId: 'pap_a',
    experimentId: null,
  });
  mount({ ...source, kind: 'paper', resourceId: 'pap_a' }, []);
  const link = await screen.findByRole('link', { name: '打开项目原件' });
  expect(link.getAttribute('href')).toBe('/p/prj_a/library/pap_a');
  expect(screen.getByRole('option', { name: '完整原件' })).toBeTruthy();
});
