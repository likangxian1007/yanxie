import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Popover } from './Popover';

function Harness() {
  const [tall, setTall] = useState(false);
  return (
    <Popover open side="top" label="配置" trigger={<button type="button">打开</button>}>
      {tall ? (
        <div data-h="400">长内容</div>
      ) : (
        <div data-h="200">
          <button type="button" onClick={() => setTall(true)}>
            换页
          </button>
        </div>
      )}
    </Popover>
  );
}

describe('Popover 定位', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 728,
      left: 100,
      right: 200,
      width: 100,
      height: 28,
      x: 100,
      y: 700,
      toJSON: () => ({}),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const h = this.querySelector<HTMLElement>('[data-h]')?.dataset.h;
        return h ? Number(h) : 0;
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it('向上弹出的面板换成更高的内容后重新定位，底边仍贴着触发按钮', async () => {
    render(<Harness />);
    const panel = screen.getByRole('dialog', { name: '配置' });
    // 700(触发点顶部) - 6(间距) - 200(内容高)
    expect(panel.style.top).toBe('494px');
    fireEvent.click(screen.getByRole('button', { name: '换页' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(panel.style.top).toBe('294px');
  });
});
