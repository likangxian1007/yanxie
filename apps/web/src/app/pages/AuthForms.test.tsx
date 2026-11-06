import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api';
import type * as ApiModule from '@/lib/api';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { splitApiErrors } from './form-errors';

const post = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const mod = await orig<typeof ApiModule>();
  return { ...mod, api: { ...mod.api, post: (...args: unknown[]) => post(...args) } };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const validation = (issues: { path: string; message: string }[]) =>
  new ApiRequestError({
    status: 422,
    code: 'validation_failed',
    message: '提交的内容不符合要求',
    details: { issues },
  });

beforeEach(() => post.mockReset());

describe('注册表单', () => {
  it('提前写明密码规则', () => {
    wrap(<RegisterPage />);
    expect(screen.getByText('至少 8 位，不能全是数字或同一个字符')).toBeInTheDocument();
  });

  it('全数字密码在提交前就在密码框下说明原因，韩文姓名不报错', () => {
    wrap(<RegisterPage />);
    fill('姓名', '이강현');
    fill('邮箱', 'alice@example.com');
    fill('密码', '12345678');
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
    expect(screen.getByText('密码太简单：不能全是数字，请加上字母或符号')).toBeInTheDocument();
    expect(screen.queryByText('请填写姓名')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('服务端逐字段原因显示在对应输入框下，而不是一句笼统提示', async () => {
    post.mockRejectedValueOnce(
      validation([{ path: 'email', message: '邮箱格式不对，应类似 you@lab.edu.cn' }]),
    );
    wrap(<RegisterPage />);
    fill('姓名', '이강현');
    fill('邮箱', 'a@b.c');
    fill('密码', 'abcd1234');
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
    await waitFor(() =>
      expect(screen.getByText('邮箱格式不对，应类似 you@lab.edu.cn')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('提交的内容不符合要求')).toBeNull();
  });

  it('邮箱已注册等非字段错误显示服务端原因', async () => {
    post.mockRejectedValueOnce(
      new ApiRequestError({ status: 409, code: 'conflict', message: '这个邮箱已经注册过了' }),
    );
    wrap(<RegisterPage />);
    fill('姓名', 'Kang');
    fill('邮箱', 'k@lab.edu.cn');
    fill('密码', 'abcd1234');
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('这个邮箱已经注册过了'),
    );
  });
});

describe('登录表单', () => {
  it('空字段逐个提示', () => {
    wrap(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByText('请填写邮箱')).toBeInTheDocument();
    expect(screen.getByText('请填写密码')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('限流时显示要等多久', async () => {
    post.mockRejectedValueOnce(
      new ApiRequestError({
        status: 429,
        code: 'rate_limited',
        message: '登录尝试过多，请 3 分钟后再试',
      }),
    );
    wrap(<LoginPage />);
    fill('邮箱', 'k@lab.edu.cn');
    fill('密码', 'whatever');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('登录尝试过多，请 3 分钟后再试'),
    );
  });
});

describe('splitApiErrors', () => {
  it('对应不到输入框的原因进总提示', () => {
    const r = splitApiErrors(
      validation([
        { path: 'password', message: '密码至少 8 位（现在 3 位）' },
        { path: 'inviteToken', message: '邀请链接无效' },
      ]),
      ['name', 'email', 'password'] as const,
      'x',
    );
    expect(r.fields).toEqual({ password: '密码至少 8 位（现在 3 位）' });
    expect(r.form).toBe('邀请链接无效');
  });

  it('网络断开给出中文说明', () => {
    const r = splitApiErrors(
      new ApiRequestError({ status: 0, code: 'network_error', message: 'Failed to fetch' }),
      ['email'] as const,
      'x',
    );
    expect(r.form).toBe('连不上服务器，请检查网络后再试。');
  });
});
