import { useId, useState } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Lock, Mail, Send } from 'lucide-react';
import type { Invite } from '@srh/shared';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  RelativeTime,
  Select,
  toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { canManage, ROLE_LABEL, useMyRole } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import {
  errorMessage,
  INVITE_ROLES,
  inviteLink,
  isEmail,
  isExpired,
  type InviteRole,
} from '../lib';
import { useInvites } from '../queries';
import { ErrorCard, Field, InlineError, SectionSkeleton, SettingsCard, When } from './parts';
import { tr } from '@/lib/i18n';

async function copyLink(token: string) {
  try {
    await navigator.clipboard.writeText(inviteLink(token));
    toast.success(tr('已复制邀请链接'));
  } catch {
    toast.error(tr('没能复制链接'), tr('浏览器不允许访问剪贴板，请手动选中链接复制。'));
  }
}

export function InvitesSection({ pid }: { pid: string }) {
  const role = useMyRole(pid);
  if (!canManage(role)) {
    return (
      <EmptyState
        framed
        icon={Lock}
        title={tr('只有负责人和导师可以邀请成员')}
        description={tr('需要拉人进项目时，请联系项目负责人或导师生成邀请链接。')}
      />
    );
  }
  return <InvitesManager pid={pid} />;
}

function InvitesManager({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const invites = useInvites(pid);
  const ids = useId();
  const { variants, stagger } = useMotionPreset();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<Invite | null>(null);

  const trimmed = email.trim();
  const emailError =
    trimmed && !isEmail(trimmed) ? tr('邮箱格式不对，可以留空生成通用链接') : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.post<Invite>(`/projects/${pid}/invites`, {
        role,
        ...(trimmed ? { email: trimmed } : {}),
      }),
    onSuccess: (inv) => {
      qc.setQueryData<Invite[]>(qk.invites(pid), (list) =>
        list ? [inv, ...list.filter((x) => x.id !== inv.id)] : list,
      );
      setCreated(inv);
      setEmail('');
      setTouched(false);
      toast.success(tr('已生成邀请链接'));
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!emailError) create.mutate();
        }}
      >
        <SettingsCard
          title={tr('邀请成员')}
          description={tr(
            '生成一个邀请链接发给对方，打开链接注册或登录后即可加入项目。链接过期后需要重新生成。',
          )}
          footer={
            <>
              {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
              <Button
                type="submit"
                variant="primary"
                loading={create.isPending}
                leftIcon={<Send strokeWidth={1.75} aria-hidden />}
              >
                {tr('生成邀请链接')}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <Field
              label={tr('邮箱（可选）')}
              htmlFor={`${ids}-email`}
              hint={tr('填写后只有这个邮箱能用这条链接')}
            >
              <Input
                id={`${ids}-email`}
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="name@example.com"
                leading={<Mail strokeWidth={1.75} aria-hidden />}
                value={email}
                error={touched ? emailError : undefined}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouched(true)}
              />
            </Field>
            <Field label={tr('角色')} htmlFor={`${ids}-role`}>
              <Select
                id={`${ids}-role`}
                value={role}
                onChange={(e) => setRole(e.target.value as InviteRole)}
                options={INVITE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              />
            </Field>
          </div>

          {created && (
            <motion.div
              key={created.id}
              variants={variants.fadeUp}
              initial="hidden"
              animate="visible"
              className="mt-4 rounded-md border border-line bg-subtle p-3"
            >
              <p className="text-small font-medium text-fg">
                {tr('邀请链接已生成')}
                <span className="font-normal text-fg-muted">
                  {' · '}
                  {ROLE_LABEL[created.role]}
                  {created.email ? ` · ${created.email}` : tr(' · 任何人可用')}
                  {' · '}
                  <When iso={created.expiresAt} />
                  {tr(' 过期')}
                </span>
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  readOnly
                  aria-label={tr('邀请链接')}
                  value={inviteLink(created.token)}
                  className="font-mono text-small"
                  leading={<Link2 strokeWidth={1.75} aria-hidden />}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="secondary"
                  leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
                  onClick={() => void copyLink(created.token)}
                >
                  {tr('复制链接')}
                </Button>
              </div>
            </motion.div>
          )}
        </SettingsCard>
      </form>

      <SettingsCard
        title={tr('已发出的邀请')}
        description={tr('邀请被接受后，对方会出现在成员列表里。')}
      >
        {invites.isPending ? (
          <SectionSkeleton rows={2} />
        ) : invites.isError ? (
          <ErrorCard error={invites.error} onRetry={() => void invites.refetch()} />
        ) : invites.data.length === 0 ? (
          <EmptyState
            icon={Link2}
            title={tr('还没有邀请')}
            description={tr('生成的邀请链接会列在这里，可以随时再复制一次。')}
            className="py-8"
          />
        ) : (
          <motion.ul
            variants={stagger()}
            initial="hidden"
            animate="visible"
            className="-mx-4 flex flex-col divide-y divide-line border-t border-line"
            aria-label={tr('邀请列表')}
          >
            {invites.data.map((inv) => (
              <InviteRow key={inv.id} invite={inv} variants={variants.fadeUp} />
            ))}
          </motion.ul>
        )}
      </SettingsCard>
    </div>
  );
}

function InviteRow({
  invite,
  variants,
}: {
  invite: Invite;
  variants: ReturnType<typeof useMotionPreset>['variants']['fadeUp'];
}) {
  const accepted = invite.acceptedAt !== null;
  const expired = !accepted && isExpired(invite.expiresAt);
  return (
    <motion.li
      variants={variants}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-fg-muted ring-1 ring-line">
        {accepted ? (
          <Check size={16} strokeWidth={1.75} aria-hidden />
        ) : (
          <Link2 size={16} strokeWidth={1.75} aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium text-fg">
            {invite.email ?? tr('通用链接')}
          </span>
          <Badge tone="neutral">{ROLE_LABEL[invite.role]}</Badge>
        </div>
        <p className="truncate text-small text-fg-subtle">
          {accepted && invite.acceptedAt ? (
            <>
              <RelativeTime iso={invite.acceptedAt} />
              {tr(' 接受')}
            </>
          ) : expired ? (
            <>
              <RelativeTime iso={invite.expiresAt} />
              {tr(' 过期')}
            </>
          ) : (
            <>
              <RelativeTime iso={invite.createdAt} />
              {tr(' 创建 · ')}
              <When iso={invite.expiresAt} />
              {tr(' 过期')}
            </>
          )}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {accepted ? (
          <Badge tone="success">{tr('已接受')}</Badge>
        ) : expired ? (
          <Badge tone="warning">{tr('已过期')}</Badge>
        ) : (
          <>
            <Badge tone="accent">{tr('待接受')}</Badge>
            <IconButton
              label={tr('复制链接')}
              size="sm"
              onClick={() => void copyLink(invite.token)}
            >
              <Copy strokeWidth={1.75} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </motion.li>
  );
}
