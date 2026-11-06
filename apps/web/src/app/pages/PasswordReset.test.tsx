import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api';
import type * as ApiModule from '@/lib/api';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { LoginPage } from './LoginPage';
import { ResetPasswordPage } from './ResetPasswordPage';

const post = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const mod = await orig<typeof ApiModule>();
  return { ...mod, api: { ...mod.api, post: (...args: unknown[]) => post(...args) } };
});

function wrap(ui: ReactNode, url = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => post.mockReset());

describe('找回密码', () => {
  it('登录页有“忘记密码？”入口', () => {
    wrap(<LoginPage />);
    expect(screen.getByRole('link', { name: '忘记密码？' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('提交邮箱后显示确认页（不透露账号是否存在）', async () => {
    post.mockResolvedValueOnce({ ok: true });
    wrap(<ForgotPasswordPage />);
    fill('邮箱', ' a@lab.edu.cn ');
    fireEvent.click(screen.getByRole('button', { name: '发送重置链接' }));
    await waitFor(() => expect(screen.getByText('查收邮件')).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith('/auth/password/request-reset', { email: 'a@lab.edu.cn' });
    expect(screen.getByRole('status')).toHaveTextContent('a@lab.edu.cn');
  });

  it('邮箱格式不对时不提交', () => {
    wrap(<ForgotPasswordPage />);
    fill('邮箱', 'nope');
    fireEvent.click(screen.getByRole('button', { name: '发送重置链接' }));
    expect(screen.getByText('邮箱格式不对，应类似 you@lab.edu.cn')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('限流时显示服务端原因', async () => {
    post.mockRejectedValueOnce(
      new ApiRequestError({
        status: 429,
        code: 'rate_limited',
        message: '重置请求太频繁，请 15 分钟后再试',
      }),
    );
    wrap(<ForgotPasswordPage />);
    fill('邮箱', 'a@lab.edu.cn');
    fireEvent.click(screen.getByRole('button', { name: '发送重置链接' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('重置请求太频繁，请 15 分钟后再试'),
    );
  });
});

describe('重置密码', () => {
  it('没有 token 直接显示链接失效', () => {
    wrap(<ResetPasswordPage />, '/reset-password');
    expect(screen.getByText('链接已失效')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '重新发送重置邮件' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('两次密码不一致时不提交', () => {
    wrap(<ResetPasswordPage />, '/reset-password?token=abc');
    fill('新密码', 'n3w-passw0rd');
    fill('确认新密码', 'n3w-passw0rx');
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }));
    expect(screen.getByText('两次输入的密码不一致')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('弱密码按注册同样规则提示', () => {
    wrap(<ResetPasswordPage />, '/reset-password?token=abc');
    fill('新密码', '12345678');
    fill('确认新密码', '12345678');
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }));
    expect(screen.getByText('密码太简单：不能全是数字，请加上字母或符号')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('成功后给出登录入口', async () => {
    post.mockResolvedValueOnce({ ok: true });
    wrap(<ResetPasswordPage />, '/reset-password?token=abc');
    fill('新密码', 'n3w-passw0rd');
    fill('确认新密码', 'n3w-passw0rd');
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }));
    await waitFor(() => expect(screen.getByText('密码已更新')).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith('/auth/password/reset', {
      token: 'abc',
      password: 'n3w-passw0rd',
    });
    expect(screen.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/login');
  });

  it('令牌无效或过期显示失效页', async () => {
    post.mockRejectedValueOnce(
      new ApiRequestError({ status: 400, code: 'bad_request', message: '重置链接无效或已过期' }),
    );
    wrap(<ResetPasswordPage />, '/reset-password?token=old');
    fill('新密码', 'n3w-passw0rd');
    fill('确认新密码', 'n3w-passw0rd');
    fireEvent.click(screen.getByRole('button', { name: '更新密码' }));
    await waitFor(() => expect(screen.getByText('链接已失效')).toBeInTheDocument());
  });
});
