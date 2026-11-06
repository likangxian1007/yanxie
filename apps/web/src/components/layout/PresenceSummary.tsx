import { memo, useState } from 'react';
import { Link } from 'react-router';
import { Users } from 'lucide-react';
import { Avatar, Badge, Button, Input, Popover } from '@/components/ui';
import { canManage, ROLE_LABEL, useMembers, useMyRole } from '@/lib/project';
import { useRealtimeStore } from '@/lib/realtime-store';
import { useMeUser } from '@/lib/session';
import { tr } from '@/lib/i18n';

export const PresenceSummary = memo(function PresenceSummary({ projectId }: { projectId: string }) {
  const members = useMembers(projectId);
  const me = useMeUser();
  const role = useMyRole(projectId);
  const [search, setSearch] = useState('');
  const status = useRealtimeStore((s) => s.status);
  const presence = useRealtimeStore((s) => s.presence[projectId]);
  const live = status === 'open' && presence !== undefined;
  const online = new Set(presence?.map((p) => p.userId) ?? []);
  const needle = search.trim().toLocaleLowerCase();
  const rows = [...(members.data ?? [])]
    .filter((m) => `${m.user.name}\n${m.user.email}`.toLocaleLowerCase().includes(needle))
    .sort(
      (a, b) =>
        Number(live && online.has(b.user.id)) - Number(live && online.has(a.user.id)) ||
        a.user.name.localeCompare(b.user.name, 'zh-CN'),
    );
  const label = members.data ? tr('成员 · {count}', { count: members.data.length }) : tr('成员');
  return (
    <Popover
      label={tr('课题成员')}
      align="end"
      className="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-caption text-fg-muted hover:bg-muted/60 max-md:h-11 max-md:min-w-11"
        >
          <Users size={15} aria-hidden />
          <span className="hidden md:inline">{label}</span>
          <span className="md:hidden" aria-hidden>
            {members.data?.length ?? '—'}
          </span>
        </button>
      }
    >
      {() => (
        <>
          <h2 tabIndex={-1} data-autofocus className="px-2 py-2 text-small font-medium">
            {label}
          </h2>
          <div className="px-2 pb-2">
            <Input
              aria-label={tr('搜索成员')}
              placeholder={tr('搜索姓名或邮箱')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {members.isPending ? (
            <p role="status" className="p-2 text-small text-fg-muted">
              {tr('正在加载成员…')}
            </p>
          ) : members.isError ? (
            <div role="alert" className="p-2 text-small text-danger">
              {tr('成员加载失败')}
              <Button size="sm" variant="ghost" onClick={() => void members.refetch()}>
                {tr('重试')}
              </Button>
            </div>
          ) : (
            <ul aria-label={tr('课题成员列表')} className="max-h-80 overflow-y-auto px-2 pb-2">
              {rows.map((m) => (
                <li key={m.user.id} className="flex items-center gap-2.5 py-2">
                  <Avatar
                    name={m.user.name}
                    color={m.user.avatarColor}
                    src={m.user.avatarUrl}
                    size={24}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-small text-fg">{m.user.name}</span>
                      {m.user.id === me?.id && <Badge>{tr('你')}</Badge>}
                    </div>
                    <p className="text-caption text-fg-muted">
                      {ROLE_LABEL[m.role]} ·{' '}
                      {!live ? tr('在线状态未知') : online.has(m.user.id) ? tr('在线') : tr('离线')}
                    </p>
                  </div>
                </li>
              ))}
              {rows.length === 0 && (
                <li className="py-2 text-small text-fg-muted">{tr('没有找到成员')}</li>
              )}
            </ul>
          )}
          <div className="flex gap-3 border-t border-line px-2 py-2 text-small">
            <Link className="text-accent" to={`/p/${projectId}/settings?tab=members`}>
              {canManage(role) ? tr('管理成员') : tr('查看成员详情')}
            </Link>
            {canManage(role) && (
              <Link className="text-accent" to={`/p/${projectId}/settings?tab=invites`}>
                {tr('邀请成员')}
              </Link>
            )}
          </div>
        </>
      )}
    </Popover>
  );
});
