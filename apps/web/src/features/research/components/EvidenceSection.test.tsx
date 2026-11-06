import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  EvidenceExcerpt,
  ResearchRecordDetail,
  ResearchSnapshot,
  ResearchSource,
} from '@srh/shared';
import { researchApi } from '../data';
import { EvidenceSection } from './EvidenceSection';

const actor = { kind: 'user' as const, id: 'usr_a', name: '研究者' };
const oldSource: ResearchSource = {
  id: 'rsr_a',
  projectId: 'prj_a',
  recordId: null,
  kind: 'bibliography',
  resourceId: null,
  title: '旧题名',
  citation: '旧书目',
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
  sourceId: oldSource.id,
  version: 1,
  sourceVersion: 1,
  sourceMetadata: oldSource,
  coverage: 'excerpt',
  sha256: null,
  byteLength: 9,
  mime: 'text/plain',
  originalName: '摘录',
  text: '固定的原文',
  createdBy: actor,
  createdAt: '2026-01-02T00:00:00.000Z',
};
const excerpt: EvidenceExcerpt = {
  id: 'rex_a',
  projectId: 'prj_a',
  recordId: 'rrc_a',
  version: 1,
  sourceId: oldSource.id,
  snapshotId: snapshot.id,
  quote: '固定的原文',
  locator: { kind: 'manual', note: '第 2 节' },
  origin: 'manual',
  verification: 'unverified',
  createdBy: actor,
  createdAt: '2026-01-03T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

it('资料从记录解除关联且改名后，旧摘录仍显示固定书目并能下载原快照', async () => {
  vi.spyOn(researchApi, 'record').mockResolvedValue({
    record: { sourceIds: [] },
    template: {},
    logs: [],
    sources: [],
  } as unknown as ResearchRecordDetail);
  vi.spyOn(researchApi, 'sources').mockResolvedValue([
    { ...oldSource, title: '新题名', citation: '新书目', version: 2 },
  ]);
  vi.spyOn(researchApi, 'excerpts').mockResolvedValue([excerpt]);
  const snapshots = vi.spyOn(researchApi, 'snapshots').mockResolvedValue([snapshot]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EvidenceSection pid="prj_a" recordId="rrc_a" writable={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('link', { name: '旧题名' })).toBeTruthy();
  expect(screen.getByText(/来源第 1 版 · 旧书目/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '查看引用版本' })).toBeTruthy();
  expect(snapshots).toHaveBeenCalledWith('prj_a', oldSource.id, expect.any(AbortSignal));
});
