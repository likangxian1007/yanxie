import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { PASSWORD_RULE_HINT, passwordProblem } from '@srh/shared';
import { Button } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { FormField } from './FormField';
import { splitApiErrors } from './form-errors';
import { tr } from '@/lib/i18n';

interface FieldErrors {
  password?: string;
  confirm?: string;
}

const linkClass = 'font-medium text-accent-text hover:underline';
const buttonLinkClass =
  'inline-flex min-h-11 w-full items-center justify-center rounded-md bg-accent-solid px-4 text-body font-medium text-accent-fg no-underline shadow-xs hover:bg-accent-solid-hover';

/** 邮件链接落地页：/reset-password?token=… → 设新密码 → 去登录 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid');

  const loginFooter = (
    <>
      {tr('想起密码了？')}
      <Link to="/login" className={linkClass}>
        {tr('登录')}
      </Link>
    </>
  );

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e: FieldErrors = {};
    const pw = passwordProblem(password);
    if (pw) e.password = pw;
    if (!confirm) e.confirm = tr('请再输入一次新密码');
    else if (confirm !== password) e.confirm = tr('两次输入的密码不一致');
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setPending(true);
    setFormError(null);
    try {
      await api.post('/auth/password/reset', { token, password });
      setState('done');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 400) {
        setState('invalid');
        return;
      }
      const split = splitApiErrors(err, ['password'] as const, tr('重置失败，请稍后再试。'));
      setErrors(split.fields);
      setFormError(split.form);
    } finally {
      setPending(false);
    }
  };

  if (state === 'done') {
    return (
      <AuthLayout
        title={tr('密码已更新')}
        description={tr('为了安全，所有设备都已退出登录。')}
        footer={loginFooter}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-md bg-success-soft px-3 py-3 text-small text-success">
            <CircleCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <p role="status">{tr('新密码已生效，用它登录就好。')}</p>
          </div>
          <Link to="/login" className={buttonLinkClass}>
            {tr('去登录')}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthLayout
        title={tr('链接已失效')}
        description={tr('重置链接 30 分钟内有效，并且只能用一次。')}
        footer={loginFooter}
      >
        <div className="flex flex-col gap-4">
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md bg-danger-soft px-3 py-3 text-small text-danger"
          >
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <p>{tr('重置链接无效或已过期')}</p>
          </div>
          <Link to="/forgot-password" className={buttonLinkClass}>
            {tr('重新发送重置邮件')}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={tr('设置新密码')}
      description={tr('设置好后需要用新密码重新登录。')}
      footer={loginFooter}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField
          label={tr('新密码')}
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
        <FormField
          label={tr('确认新密码')}
          type="password"
          name="confirm"
          autoComplete="new-password"
          placeholder={tr('再输入一次')}
          value={confirm}
          error={errors.confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            if (errors.confirm) setErrors((prev) => ({ ...prev, confirm: undefined }));
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
          {tr('更新密码')}
        </Button>
      </form>
    </AuthLayout>
  );
}
