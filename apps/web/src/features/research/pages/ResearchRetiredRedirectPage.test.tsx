import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ResearchRetiredRedirectPage } from './ResearchRetiredRedirectPage';

vi.mock('@/lib/project', () => ({ useProjectId: () => 'p1' }));
it('旧模板地址回到研究空间列表', async () => {
  render(
    <MemoryRouter initialEntries={['/p/p1/research-templates']}>
      <Routes>
        <Route path="/p/:projectId/research-templates" element={<ResearchRetiredRedirectPage />} />
        <Route path="/p/:projectId/research" element={<p>研究空间列表</p>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('研究空间列表')).toBeTruthy();
  expect(screen.queryByText('发布模板')).toBeNull();
});
