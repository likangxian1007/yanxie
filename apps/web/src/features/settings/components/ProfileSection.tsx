import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import type { User } from '@srh/shared';
import { Avatar, Button, Input, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { useLogout, useMe, type MeResponse } from '@/lib/session';
import { errorMessage } from '../lib';
import {
  ErrorCard,
  Field,
  InlineError,
  PaletteSwatches,
  SectionSkeleton,
  SettingsCard,
} from './parts';
import { AppearanceSettings } from './AppearanceSettings';
import { tr } from '@/lib/i18n';

export function ProfileSection({ pid }: { pid: string }) {
  const me = useMe();
  if (me.isPending) return <SectionSkeleton rows={2} />;
  if (me.isError) return <ErrorCard error={me.error} onRetry={() => void me.refetch()} />;
  return <ProfileForms pid={pid} user={me.data.user} />;
}

function ProfileForms({ pid, user }: { pid: string; user: User }) {
  const qc = useQueryClient();
  const logout = useLogout();
  const ids = useId();
  const [name, setName] = useState<string | null>(null);
  const [color, setColor] = useState<number | null>(null);

  const nameValue = name ?? user.name;
  const colorValue = color ?? user.avatarColor;
  const changes: { name?: string; avatarColor?: number } = {};
  if (name !== null && name.trim() !== user.name) changes.name = name.trim();
  if (color !== null && color !== user.avatarColor) changes.avatarColor = color;
  const dirty = Object.keys(changes).length > 0;
  const nameError = nameValue.trim() ? undefined : tr('名字不能为空');

  const save = useMutation({
    mutationFn: (body: typeof changes) => api.patch<User>('/auth/me', body),
    onSuccess: (u) => {
      qc.setQueryData<MeResponse>(qk.me, (prev) => (prev ? { ...prev, user: u } : prev));
      void qc.invalidateQueries({ queryKey: qk.me });
      if (pid) void qc.invalidateQueries({ queryKey: qk.members(pid) });
      setName(null);
      setColor(null);
      toast.success(tr('已更新个人资料'));
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !nameError) save.mutate(changes);
        }}
      >
        <SettingsCard
          title={tr('个人资料')}
          description={tr('所有课题共用的个人资料。')}
          footer={
            <>
              {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
              {dirty && (
                <Button
                  variant="ghost"
                  disabled={save.isPending}
                  onClick={() => {
                    setName(null);
                    setColor(null);
                  }}
                >
                  {tr('放弃更改')}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={!dirty || Boolean(nameError)}
              >
                {tr('保存更改')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Avatar name={nameValue.trim() || user.name} color={colorValue} size={40} />
              <div className="min-w-0">
                <p className="truncate text-h3 text-fg">{nameValue.trim() || user.name}</p>
                <p className="truncate text-small text-fg-muted">{user.email}</p>
              </div>
            </div>
            <Field label={tr('名字')} htmlFor={`${ids}-name`}>
              <Input
                id={`${ids}-name`}
                value={nameValue}
                maxLength={40}
                autoComplete="name"
                error={name !== null ? nameError : undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-small font-medium text-fg">{tr('头像颜色')}</span>
              <PaletteSwatches label={tr('头像颜色')} value={colorValue} onChange={setColor} />
            </div>
          </div>
        </SettingsCard>
      </form>

      <AppearanceSettings />

      <SettingsCard
        title={tr('退出登录')}
        description={tr('退出当前设备的登录状态。')}
        actions={
          <Button
            variant="secondary"
            leftIcon={<LogOut strokeWidth={1.75} aria-hidden />}
            loading={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {tr('退出登录')}
          </Button>
        }
      />
    </div>
  );
}
