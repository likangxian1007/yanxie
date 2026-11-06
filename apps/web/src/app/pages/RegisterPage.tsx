import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PASSWORD_RULE_HINT, passwordProblem, type User } from '@srh/shared';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { AuthLayout } from './AuthLayout';
import { FormField } from './FormField';
import { splitApiErrors } from './form-errors';
import { tr } from '@/lib/i18n';

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = params.get('invite');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const validate = (): FieldErrors => {
    const e: FieldErrors = {};
    if (!name.trim()) e.name = tr('请填写姓名');
    else if (name.trim().length > 40) e.name = tr('姓名最多 40 个字');
    if (!email.trim()) e.email = tr('请填写邮箱');
    else if (!/^\S+@\S+\.\S+$/u.test(email.trim()))
      e.email = tr('邮箱格式不对，应类似 you@lab.edu.cn');
    const pw = passwordProblem(password);
    if (pw) e.password = pw;
    return e;
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setPending(true);
    setFormError(null);
    try {
      await api.post<User>('/auth/register', {
        name: name.trim(),
        email: email.trim(),
        password,
        ...(invite ? { inviteToken: invite } : {}),
      });
      await qc.invalidateQueries({ queryKey: qk.me });
      navigate('/', { replace: true });
    } catch (err) {
      const split = splitApiErrors(
        err,
        ['name', 'email', 'password'] as const,
        tr('注册失败，请稍后再试。'),
      );
      setErrors(split.fields);
      setFormError(split.form);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      title={tr('创建账号')}
      description={
        invite
          ? tr('注册后会自动加入邀请你的课题。')
          : tr('注册后可以新建课题，或通过邀请链接加入课题组。')
      }
      footer={
        <>
          {tr('已有账号？')}
          <Link
            to={`/login${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`}
            className="font-medium text-accent-text hover:underline"
          >
            {tr('登录')}
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField
          label={tr('姓名')}
          name="name"
          autoComplete="name"
          placeholder={tr('组里大家怎么称呼你')}
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <FormField
          label={tr('邮箱')}
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@lab.edu.cn"
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <FormField
          label={tr('密码')}
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder={tr('设置密码')}
          hint={PASSWORD_RULE_HINT}
          value={password}
          error={errors.password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
          }}
        />
        {formError && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-small text-danger">
            {formError}
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
          {tr('创建账号')}
        </Button>
      </form>
    </AuthLayout>
  );
}
