import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, UserMinus, UserPlus, Users } from 'lucide-react';
import type { ProjectMember, ProjectRole } from '@srh/shared';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  RelativeTime,
  Select,
  toast,
  type BadgeTone,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { canManage, ROLE_LABEL, useMembers, useMyRole } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import { useMeUser } from '@/lib/session';
import { errorMessage } from '../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from './parts';
import { tr } from '@/lib/i18n';

const ROLES: ProjectRole[] = ['owner', 'advisor', 'member', 'guest'];
const ROLE_ORDER: Record<ProjectRole, number> = { owner: 0, advisor: 1, member: 2, guest: 3 };
const ROLE_TONE: Record<ProjectRole, BadgeTone> = {
  owner: 'accent',
  advisor: 'agent',
  member: 'neutral',
  guest: 'neutral',
};

export function MembersSection({ pid }: { pid: string }) {
  const members = useMembers(pid);
  const role = useMyRole(pid);
  const me = useMeUser();
  const [, setParams] = useSearchParams();
  const { variants, stagger } = useMotionPreset();
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const qc = useQueryClient();

  const updateRole = useMutation({
    mutationFn: ({ userId, role: next }: { userId: string; role: ProjectRole }) =>
      api.patch<ProjectMember>(`/projects/${pid}/members/${userId}`, { role: next }),
    onSuccess: (m) => {
      qc.setQueryData<ProjectMember[]>(qk.members(pid), (list) =>
        list?.map((x) => (x.user.id === m.user.id ? m : x)),
      );
      if (m.user.id === me?.id) void qc.invalidateQueries({ queryKey: qk.me });
      toast.success(
        tr('已把 {name} 设为{value}', { name: m.user.name, value: ROLE_LABEL[m.role] }),
      );
    },
    onError: (err) => toast.error(tr('没能修改角色'), errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${pid}/members/${userId}`),
    onSuccess: (_void, userId) => {
      qc.setQueryData<ProjectMember[]>(qk.members(pid), (list) =>
        list?.filter((x) => x.user.id !== userId),
      );
      toast.success(tr('已将 {value} 移出项目', { value: removing?.user.name ?? tr('成员') }));
      setRemoving(null);
    },
  });

  if (members.isPending) return <SectionSkeleton rows={4} />;
  if (members.isError)
    return <ErrorCard error={members.error} onRetry={() => void members.refetch()} />;

  const manager = canManage(role);
  const list = [...members.data].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.user.name.localeCompare(b.user.name),
  );
  const ownerCount = list.filter((m) => m.role === 'owner').length;

  /** 能否改这个人的角色 / 移出项目；返回不能的原因 */
  const lockReason = (m: ProjectMember): string | null => {
    if (!manager) return null;
    if (m.role === 'owner' && role !== 'owner') return tr('导师不能修改负责人');
    if (m.role === 'owner' && ownerCount <= 1) return tr('项目至少需要一位负责人');
    return null;
  };

  return (
    <>
      <SettingsCard
        title={tr('成员 · {count}', { count: list.length })}
        description={tr('负责人和导师可以管理成员、邀请、项目指令和项目记忆；访客只能查看。')}
        actions={
          manager ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<UserPlus strokeWidth={1.75} aria-hidden />}
              onClick={() => setParams({ tab: 'invites' })}
            >
              {tr('邀请成员')}
            </Button>
          ) : (
            <ReadOnlyNote />
          )
        }
      >
        {list.length === 0 ? (
          <EmptyState
            icon={Users}
            title={tr('还没有成员')}
            description={tr('用邀请链接把同学和导师加进项目。')}
          />
        ) : (
          <motion.ul
            variants={stagger()}
            initial="hidden"
            animate="visible"
            className="-mx-4 flex flex-col divide-y divide-line border-t border-line"
            aria-label={tr('成员列表')}
          >
            {list.map((m) => {
              const isMe = m.user.id === me?.id;
              const lock = lockReason(m);
              const canEdit = manager && !lock;
              const canRemove = canEdit && !isMe;
              return (
                <motion.li
                  key={m.user.id}
                  variants={variants.fadeUp}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                >
                  <Avatar
                    name={m.user.name}
                    color={m.user.avatarColor}
                    src={m.user.avatarUrl}
                    size={32}
                  />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-body font-medium text-fg">{m.user.name}</span>
                      {isMe && <Badge tone="accent">{tr('你')}</Badge>}
                    </div>
                    <p className="truncate text-small text-fg-muted">
                      {m.user.email}
                      <span className="text-fg-subtle">
                        {tr(' · 加入于 ')}
                        <RelativeTime iso={m.joinedAt} />
                      </span>
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {canEdit ? (
                      <Select
                        size="sm"
                        aria-label={tr('{name} 的角色', { name: m.user.name })}
                        wrapperClassName="w-32"
                        value={m.role}
                        disabled={
                          updateRole.isPending && updateRole.variables?.userId === m.user.id
                        }
                        onChange={(e) => {
                          const next = e.target.value as ProjectRole;
                          if (next !== m.role) updateRole.mutate({ userId: m.user.id, role: next });
                        }}
                        options={ROLES.map((r) => ({
                          value: r,
                          label: ROLE_LABEL[r],
                          // 只有负责人能任命负责人
                          disabled: r === 'owner' && role !== 'owner',
                        }))}
                      />
                    ) : (
                      <Badge tone={ROLE_TONE[m.role]} title={lock ?? undefined}>
                        {ROLE_LABEL[m.role]}
                      </Badge>
                    )}
                    {manager && (
                      <Menu
                        align="end"
                        label={tr('{name} 的操作', { name: m.user.name })}
                        trigger={
                          <IconButton label={tr('更多操作')} size="sm" disabled={!canRemove}>
                            <MoreHorizontal strokeWidth={1.75} aria-hidden />
                          </IconButton>
                        }
                      >
                        <MenuItem
                          danger
                          icon={<UserMinus strokeWidth={1.75} aria-hidden />}
                          onSelect={() => {
                            remove.reset();
                            setRemoving(m);
                          }}
                        >
                          {tr('移出项目')}
                        </MenuItem>
                      </Menu>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </SettingsCard>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(v) => {
          if (!v) setRemoving(null);
        }}
        title={tr('把 {value} 移出项目？', { value: removing?.user.name ?? '' })}
        description={tr(
          '移出后对方将看不到项目里的内容，已发的消息和产出会保留。需要时可以重新邀请。',
        )}
        confirmLabel={tr('移出项目')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (removing) remove.mutate(removing.user.id);
        }}
      />
    </>
  );
}
