import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from './Sheet';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        更多
      </button>
      <Sheet open={open} onOpenChange={setOpen} side="bottom" title="更多">
        <p>内容</p>
      </Sheet>
    </>
  );
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Sheet focus', () => {
  it('Esc 关闭后焦点回到打开它的按钮', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '更多' });
    trigger.focus();
    fireEvent.click(trigger);
    await flush();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('点按钮没有获得焦点（Safari / 手机）时，也还给 aria-expanded 的触发按钮', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '更多' });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(trigger);
    await flush();
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('输入法组字时的 Esc 不关闭', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    await flush();
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    await flush();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
