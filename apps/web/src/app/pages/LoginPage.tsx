import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@srh/shared';
import { Button } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { safeNext } from '@/lib/session';
import { AuthLayout } from './AuthLayout';
import { FormField } from './FormField';
import { splitApiErrors } from './form-errors';
import { tr } from '@/lib/i18n';

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);
  const next = safeNext(params.get('next'));
  const invite = params.get('invite');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: { email?: string; password?: string } = {};
    if (!email.trim()) fe.email = tr('请填写邮箱');
    else if (!/^\S+@\S+\.\S+$/u.test(email.trim()))
      fe.email = tr('邮箱格式不对，应类似 you@lab.edu.cn');
    if (!password) fe.password = tr('请填写密码');
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) {
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post<User>('/auth/login', { email: email.trim(), password });
      await qc.invalidateQueries({ queryKey: qk.me });
      navigate(invite ? `/invite/${invite}` : next, { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setError(tr('邮箱或密码不对，请再试一次。'));
      } else {
        const split = splitApiErrors(
          err,
          ['email', 'password'] as const,
          tr('登录失败，请稍后再试。'),
        );
        setFieldErrors(split.fields);
        setError(split.form);
      }
    } finally {
      setPending(false);
    }
  };

  const registerHref = `/register${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`;

  return (
    <AuthLayout
      title={tr('登录研协')}
      description={
        invite
          ? tr('登录后自动加入邀请你的课题。')
          : tr('和课题组一起，让 agent 并行推进你们的研究。')
      }
      footer={
        <>
          {tr('还没有账号？')}
          <Link to={registerHref} className="font-medium text-accent-text hover:underline">
            {tr('注册')}
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField
          label={tr('邮箱')}
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@lab.edu.cn"
          value={email}
          error={fieldErrors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FormField
          label={tr('密码')}
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder={tr('输入密码')}
          value={password}
          error={fieldErrors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="-mt-2 flex justify-end">
          <Link
            to="/forgot-password"
            className="inline-flex min-h-11 items-center text-small font-medium text-accent-text hover:underline"
          >
            {tr('忘记密码？')}
          </Link>
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-small text-danger">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={pending}
          className="mt-2"
        >
          {tr('登录')}
        </Button>
      </form>
    </AuthLayout>
  );
}
