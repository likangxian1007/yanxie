import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('渲染文字并响应点击', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>新建线程</Button>);
    const button = screen.getByRole('button', { name: '新建线程' });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('禁用时不触发点击', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        发送
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading 时保留文字、标记忙碌且不可点', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        生成汇报
      </Button>,
    );
    const button = screen.getByRole('button', { name: '生成汇报' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('透传 ref 与自定义类名', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <Button ref={ref} className="mt-2">
        登录
      </Button>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toHaveClass('mt-2');
  });
});
