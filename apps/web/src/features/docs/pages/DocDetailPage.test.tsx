import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { DocDetailPage } from './DocDetailPage';

const state = vi.hoisted(() => ({
  collab: { ready: true, synced: true, sync: 'synced', unsynced: 0, peers: [], doc: {} },
}));

vi.mock('@/lib/session', () => ({ useMeUser: () => ({ id: 'me' }) }));
vi.mock('@/lib/project', () => ({ useMyRole: () => 'owner', canWrite: () => true }));
vi.mock('../collab/useCollabDoc', () => ({ useCollabDoc: () => state.collab }));
vi.mock('../detail/api', () => ({
  useDocMeta: () => ({
    data: { id: 'doc', title: '研究计划', kind: 'doc', archivedAt: null },
    isPending: false,
    isError: false,
  }),
  usePatchDoc: () => ({ mutate: vi.fn() }),
  fetchDocMarkdown: vi.fn(),
}));
vi.mock('../detail/toolbarFade', () => ({ useToolbarScrollFade: () => {} }));
vi.mock('../detail/DocClaims', () => ({ DocClaims: () => null }));
vi.mock('../import/BlankDocImport', () => ({ BlankDocImport: () => null }));
vi.mock('@/features/versioning/components/ProposalBanner', () => ({ ProposalBanner: () => null }));
vi.mock('@/features/versioning/components/VersionHistorySheet', () => ({
  VersionHistorySheet: () => null,
}));
vi.mock('@/features/reviews', () => ({ RequestReviewDialog: () => null }));
vi.mock('../editors/rich', () => ({ RichTextEditor: () => <textarea aria-label="编辑器" /> }));
vi.mock('@/features/sharing/api', async (orig) => ({
  ...(await orig<object>()),
  useShareEvents: () => {},
}));
vi.mock('@/features/sharing/SharePanel', () => ({ SharePanel: () => null }));

function App() {
  return (
    <MemoryRouter initialEntries={['/p/p/docs/doc']}>
      <Routes>
        <Route path="/p/:projectId/docs/:docId" element={<DocDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

it('返回、同步状态和文档操作共用工具栏，状态变化不重建编辑器', async () => {
  const { rerender } = render(<App />);
  const editor = await screen.findByRole('textbox', { name: '编辑器' });
  const back = screen.getByRole('link', { name: '全部文档' });
  const toolbar = back.parentElement!;
  expect(within(toolbar).getByText('已同步')).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '版本历史' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: '更多操作' })).toBeInTheDocument();

  fireEvent.change(editor, { target: { value: '尚未同步的草稿' } });
  state.collab.sync = 'offline';
  state.collab.unsynced = 1;
  rerender(<App />);
  expect(within(toolbar).getByText('离线 · 有未同步的修改')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '编辑器' })).toBe(editor);
  expect(editor).toHaveValue('尚未同步的草稿');
});
