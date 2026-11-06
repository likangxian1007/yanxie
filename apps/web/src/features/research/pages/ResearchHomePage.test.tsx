import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { ResearchHomePage } from './ResearchHomePage';
vi.mock('./ResearchListPage', () => ({ ResearchWorkspacesPage: () => <p>空间列表</p> }));
vi.mock('./ResearchSourcesPage', () => ({ ResearchSourcesPage: () => <p>资料列表</p> }));
it('研究资料纳入研究空间入口的独立标签', () => {
  render(
    <MemoryRouter>
      <ResearchHomePage />
    </MemoryRouter>,
  );
  expect(screen.getByText('空间列表')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: '研究资料' }));
  expect(screen.getByText('资料列表')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '研究资料' })).toHaveAttribute('aria-current', 'page');
});
