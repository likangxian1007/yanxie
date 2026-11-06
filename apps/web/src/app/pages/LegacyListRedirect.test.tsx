import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { expect, it } from 'vitest';
import { LegacyListRedirect } from './LegacyListRedirect';
function Target() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}
it('旧任务链接进入对应视图，并保留筛选和定位', () => {
  render(
    <MemoryRouter initialEntries={['/p/p/todos?todo=tdo_x&q=abc#focus']}>
      <Routes>
        <Route path="/p/p/todos" element={<LegacyListRedirect path="tasks" view="todos" />} />
        <Route path="/p/p/tasks" element={<Target />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    '/p/p/tasks?todo=tdo_x&q=abc&view=todos#focus',
  );
});
