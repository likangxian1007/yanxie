import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { AuthLayout } from './AuthLayout';
import { FormField } from './FormField';
import { splitApiErrors } from './form-errors';
import { tr } from '@/lib/i18n';

/** 找回密码：填邮箱 → 不管账号是否存在都显示同一个确认页 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const value = email.trim();
    let fe: string | undefined;
    if (!value) fe = tr('请填写邮箱');
    else if (!/^\S+@\S+\.\S+$/u.test(value)) fe = tr('邮箱格式不对，应类似 you@lab.edu.cn');
    setEmailError(fe);
    if (fe) return;
    setPending(true);
    setFormError(null);
    try {
      await api.post('/auth/password/request-reset', { email: value });
      setSentTo(value);
    } catch (err) {
      const split = splitApiErrors(err, ['email'] as const, tr('发送失败，请稍后再试。'));
      setEmailError(split.fields.email);
      setFormError(split.form);
    } finally {
      setPending(false);
    }
  };

  const footer = (
    <>
      {tr('想起密码了？')}
      <Link to="/login" className="font-medium text-accent-text hover:underline">
        {tr('登录')}
      </Link>
    </>
  );

  if (sentTo) {
    return (
      <AuthLayout
        title={tr('查收邮件')}
        description={tr('按邮件里的链接设置新密码。')}
        footer={footer}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-md bg-success-soft px-3 py-3 text-small text-success">
            <MailCheck size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <p role="status" className="break-words">
              {tr('如果 {email} 注册过研协，你会收到一封重置密码的邮件，链接 30 分钟内有效。', {
                email: sentTo,
              })}
            </p>
          </div>
          <p className="text-small text-fg-muted">
            {tr('没收到？看看垃圾邮件，或确认邮箱写对了再试一次。')}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            fullWidth
            onClick={() => setSentTo(null)}
          >
            {tr('换个邮箱再试')}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={tr('找回密码')}
      description={tr('填写注册时用的邮箱，我们会发一个重置密码的链接给你。')}
      footer={footer}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField
          label={tr('邮箱')}
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@lab.edu.cn"
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.target.value)}
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
          {tr('发送重置链接')}
        </Button>
      </form>
    </AuthLayout>
  );
}
