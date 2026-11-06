import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusableIn } from './focus-trap';
import { useLayoutStore } from './layout-store';
import { installFakeBackend, renderShell } from './shell-test-utils';

describe('移动端导航抽屉', () => {
  beforeEach(() => {
    useLayoutStore.setState({ paletteOpen: false, mobileNavOpen: false });
    installFakeBackend();
  });

  afterEach(() => {
    useLayoutStore.setState({ paletteOpen: false, mobileNavOpen: false });
    vi.unstubAllGlobals();
  });

  it('打开时焦点进抽屉，Tab 锁在抽屉里，Esc 关闭后焦点回到「打开导航」', async () => {
    renderShell();
    const trigger = await screen.findByRole('button', { name: '打开导航' });
    trigger.focus();
    fireEvent.click(trigger);

    const drawer = await screen.findByRole('dialog', { name: '导航' });
    const items = focusableIn(drawer);
    const first = items[0];
    const last = items[items.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;

    await waitFor(() => expect(first).toHaveFocus());

    // 最后一个往后 Tab → 回到第一个
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    // 第一个 Shift+Tab → 到最后一个
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    // 焦点被挪到抽屉外时，Tab 把它拉回来
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(drawer.contains(document.activeElement)).toBe(true);

    expect(within(drawer).getByRole('button', { name: '关闭导航' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? drawer, { key: 'Escape' });
    expect(useLayoutStore.getState().mobileNavOpen).toBe(false);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('点「关闭导航」也把焦点还给「打开导航」', async () => {
    renderShell();
    const trigger = await screen.findByRole('button', { name: '打开导航' });
    fireEvent.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: '导航' });
    const close = within(drawer).getByRole('button', { name: '关闭导航' });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
