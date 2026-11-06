import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListToolbar } from './ListToolbar';

afterEach(() => vi.unstubAllGlobals());
function viewport(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}
describe('列表工具栏', () => {
  it('桌面内联展示筛选，只有一份控件', () => {
    viewport(false);
    render(
      <ListToolbar
        search={<input aria-label="搜索" />}
        filters={
          <select aria-label="状态">
            <option>全部</option>
          </select>
        }
        view={<button>表格</button>}
      />,
    );
    expect(screen.getAllByRole('combobox', { name: '状态' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /筛选/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '表格' })).toBeVisible();
  });
  it('手机显示有效条件数，筛选放抽屉并支持 Esc 返回触发器', async () => {
    viewport(true);
    render(
      <ListToolbar
        search={<input aria-label="搜索" />}
        filters={
          <select aria-label="状态">
            <option>全部</option>
          </select>
        }
        activeFilterCount={2}
      />,
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /筛选2/ });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: '筛选' });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
