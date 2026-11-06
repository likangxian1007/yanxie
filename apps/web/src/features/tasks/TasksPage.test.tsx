import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
vi.mock('@/features/board/pages/BoardPage', () => ({ BoardPage: () => <p>看板内容</p> }));
vi.mock('@/features/todos/pages/TodosPage', () => ({ TodosPage: () => <p>待办内容</p> }));
it('默认看板，切换待办保留查询条件', () => {
  render(
    <MemoryRouter initialEntries={['/p/p/tasks?q=研究']}>
      <TasksPage />
    </MemoryRouter>,
  );
  expect(screen.getByText('看板内容')).toBeInTheDocument();
  const link = screen.getByRole('link', { name: '待办' });
  expect(link.getAttribute('href')).toContain('view=todos');
  expect(link.getAttribute('href')).toContain('q=');
  fireEvent.click(link);
  expect(screen.getByText('待办内容')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '待办' })).toHaveAttribute('aria-current', 'page');
});
