import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
import { MenuItem } from './Menu';
import { useContextMenu } from './use-context-menu';

function Row({ onRename }: { onRename: () => void }) {
  const ctx = useContextMenu();
  return (
    <>
      <a href="#x" onContextMenu={ctx.onContextMenu} onKeyDown={ctx.onKeyDown}>
        会话一
      </a>
      <ContextMenu at={ctx.at} onClose={ctx.close} label="会话操作">
        <MenuItem onSelect={onRename}>重命名</MenuItem>
        <MenuItem onSelect={() => {}}>置顶</MenuItem>
      </ContextMenu>
    </>
  );
}

describe('ContextMenu', () => {
  it('右键打开自己的菜单（不弹浏览器菜单），选中后关闭', async () => {
    const onRename = vi.fn();
    render(<Row onRename={onRename} />);
    const link = screen.getByText('会话一');
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 50,
    });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const item = await screen.findByRole('menuitem', { name: '重命名' });
    fireEvent.click(item);
    expect(onRename).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('Shift + 右键保留浏览器原生菜单', () => {
    render(<Row onRename={() => {}} />);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
    screen.getByText('会话一').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('菜单键 / Shift+F10 用键盘打开，Esc 关闭', async () => {
    render(<Row onRename={() => {}} />);
    const link = screen.getByText('会话一');
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
