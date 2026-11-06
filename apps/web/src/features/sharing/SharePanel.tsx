import { useMemo, useState, type ReactNode } from 'react';
import { absoluteUrl } from '@/lib/base-path';
import {
  ACCESS_LEVEL_TEXT,
  LINK_SCOPE_LABEL,
  SHARE_LEVEL_LABEL,
  type LinkScope,
  type ResourceSpace,
  type ShareLevel,
  type ShareResourceKind,
  type ShareSettings,
} from '@srh/shared';
import { Copy, Link2, Lock, RotateCcw, Users, X } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  IconButton,
  Input,
  Select,
  Separator,
  Sheet,
  Skeleton,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useMembers, useMyRole } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { useIsMobile } from '@/lib/use-media-query';
import { shareUrl, useMoveSpace, useShareMutations, useShareSettings } from './api';
import { tr } from '@/lib/i18n';

/**
 * 飞书式分享面板（API.md §2.19）：桌面 400px 右侧抽屉，手机底部面板。
 *
 * - 团队空间：说明谁能访问，可以移到自己的个人空间（创建者 / 负责人 / 导师）。
 * - 个人空间（所有者）：按人邀请（成员或研协账号邮箱）、每人一个级别；链接分享的范围与级别，
 *   复制、重置；移到团队空间。
 * - 被分享的人：只读地看到所有者和自己的权限。
 */
export interface SharePanelProps {
  pid: string;
  kind: ShareResourceKind;
  /** 打开的资源；null = 关闭 */
  target: { id: string; title: string; href: string; createdBy?: string | null } | null;
  onClose: () => void;
}

const NAME: Record<ShareResourceKind, string> = { document: tr('文档'), paper: tr('文献') };

const LEVEL_OPTIONS = (['view', 'comment', 'edit'] as const).map((v) => ({
  value: v,
  label: SHARE_LEVEL_LABEL[v],
}));

const SCOPE_HINT: Record<LinkScope, string> = {
  invited: tr('链接已关闭，只有下面邀请的人能访问'),
  project: tr('本课题成员打开链接即可访问'),
  anyone: tr('任何登录研协的人打开链接即可访问，包括课题外的人'),
};

const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : tr('操作失败，请重试'));

export function SharePanel({ pid, kind, target, onClose }: SharePanelProps) {
  const mobile = useIsMobile();
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      side={mobile ? 'bottom' : 'right'}
      width="min(400px, 100vw)"
      title={target ? tr('分享「{value}」', { value: target.title || tr('未命名') }) : tr('分享')}
    >
      {target && (
        <ShareBody key={target.id} pid={pid} kind={kind} target={target} onClose={onClose} />
      )}
    </Sheet>
  );
}

function ShareBody({
  pid,
  kind,
  target,
  onClose,
}: {
  pid: string;
  kind: ShareResourceKind;
  target: NonNullable<SharePanelProps['target']>;
  onClose: () => void;
}) {
  const settings = useShareSettings(pid, kind, target.id);
  const me = useMeUser();
  const role = useMyRole(pid);
  const move = useMoveSpace(pid, kind);

  if (settings.isPending) {
    return (
      <div className="flex flex-col gap-3 p-4" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="flex flex-col items-start gap-3 p-4 text-small text-danger">
        <p>{errText(settings.error)}</p>
        <Button size="sm" variant="secondary" onClick={() => void settings.refetch()}>
          {tr('重试')}
        </Button>
      </div>
    );
  }
  const s = settings.data;

  const doMove = (space: ResourceSpace) =>
    move.mutate(
      { id: target.id, space },
      {
        onSuccess: () =>
          toast.success(
            space === 'team'
              ? tr('已移到团队空间，课题成员都能看到')
              : tr('已移到你的个人空间，只有你能看到'),
          ),
        onError: (e) => toast.error(tr('移动失败'), errText(e)),
      },
    );

  if (s.space === 'team') {
    const canTake = role === 'owner' || role === 'advisor' || (!!me && target.createdBy === me.id);
    return (
      <div className="flex flex-col gap-4 p-4">
        <InfoRow icon={<Users strokeWidth={1.75} aria-hidden />}>
          {tr('这份{value}在团队空间，课题成员都能访问（访客只读），不需要单独分享。', {
            value: NAME[kind],
          })}
        </InfoRow>
        <CopyRow label={tr('页面地址')} value={absoluteUrl(target.href)} />
        {canTake && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-small text-fg-muted">
                {tr('移到个人空间后只有你能看到，之后可以再单独分享给别人。')}
              </p>
              <Button
                variant="secondary"
                className="self-start max-md:h-11"
                loading={move.isPending}
                leftIcon={<Lock strokeWidth={1.75} aria-hidden />}
                onClick={() => doMove('personal')}
              >
                {tr('移到我的个人空间')}
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (s.access !== 'manage') {
    return (
      <div className="flex flex-col gap-4 p-4">
        <InfoRow icon={<Lock strokeWidth={1.75} aria-hidden />}>
          {tr('这是 ')}
          {s.ownerName ?? tr('其他成员')}
          {tr(' 个人空间里的')}
          {NAME[kind]}
          {tr('。你的权限：')}
          <strong className="font-medium text-fg">{ACCESS_LEVEL_TEXT[s.access]}</strong>
        </InfoRow>
        <CopyRow label={tr('页面地址')} value={absoluteUrl(target.href)} />
        <p className="text-small text-fg-muted">{tr('需要更高权限时，请联系所有者调整。')}</p>
      </div>
    );
  }

  return (
    <OwnerPanel
      pid={pid}
      kind={kind}
      s={s}
      onMoveTeam={() => {
        doMove('team');
        onClose();
      }}
      moving={move.isPending}
    />
  );
}

function OwnerPanel({
  pid,
  kind,
  s,
  onMoveTeam,
  moving,
}: {
  pid: string;
  kind: ShareResourceKind;
  s: ShareSettings;
  onMoveTeam: () => void;
  moving: boolean;
}) {
  const m = useShareMutations(pid, kind, s.resourceId);
  const members = useMembers(pid);
  const me = useMeUser();
  const [pick, setPick] = useState('');
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<ShareLevel>('view');
  const [confirmReset, setConfirmReset] = useState(false);

  const invited = useMemo(() => new Set(s.grants.map((g) => g.userId)), [s.grants]);
  const candidates = useMemo(
    () =>
      (members.data ?? [])
        .filter((x) => x.user.id !== me?.id && !invited.has(x.user.id))
        .map((x) => ({ value: x.user.id, label: x.user.name })),
    [members.data, me?.id, invited],
  );

  const invite = () => {
    const emails = email.trim() ? [email.trim()] : [];
    const userIds = pick ? [pick] : [];
    if (!emails.length && !userIds.length) return;
    m.invite.mutate(
      { userIds, emails, level },
      {
        onSuccess: () => {
          setPick('');
          setEmail('');
          toast.success(tr('已邀请'));
        },
        onError: (e) => toast.error(tr('邀请失败'), errText(e)),
      },
    );
  };

  const setLink = (input: { scope?: LinkScope; level?: ShareLevel }) =>
    m.link.mutate(input, { onError: (e) => toast.error(tr('链接设置没有保存'), errText(e)) });

  const open = s.link.scope !== 'invited';

  return (
    <div className="flex flex-col gap-5 p-4">
      <section aria-labelledby="share-invite" className="flex flex-col gap-2.5">
        <h3 id="share-invite" className="text-small font-medium text-fg">
          {tr('邀请协作者')}
        </h3>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            aria-label={tr('选择课题成员')}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            wrapperClassName="min-w-0 flex-1"
            className="max-md:h-11"
          >
            <option value="">
              {candidates.length ? tr('选择课题成员') : tr('没有可邀请的成员')}
            </option>
            {candidates.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label={tr('邀请的权限')}
            value={level}
            onChange={(e) => setLevel(e.target.value as ShareLevel)}
            options={LEVEL_OPTIONS}
            wrapperClassName="sm:w-28"
            className="max-md:h-11"
          />
        </div>
        <div className="flex gap-2">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && invite()}
            placeholder={tr('或输入研协账号邮箱（课题外的人）')}
            aria-label={tr('按邮箱邀请')}
            wrapperClassName="min-w-0 flex-1"
            className="max-md:h-11"
          />
          <Button
            variant="primary"
            className="max-md:h-11"
            loading={m.invite.isPending}
            disabled={!pick && !email.trim()}
            onClick={invite}
          >
            {tr('邀请')}
          </Button>
        </div>
        {s.grants.length > 0 && (
          <ul className="mt-1 flex flex-col" aria-label={tr('已邀请的人')}>
            {s.grants.map((g) => (
              <li key={g.userId} className="flex min-h-11 items-center gap-2.5 py-1">
                <Avatar name={g.name} color={g.avatarColor} size={24} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-small text-fg">
                    {g.name}
                    {g.external && <Badge>{tr('课题外')}</Badge>}
                  </span>
                  {g.email && (
                    <span className="truncate text-caption text-fg-muted">{g.email}</span>
                  )}
                </div>
                <Select
                  aria-label={tr('{name} 的权限', { name: g.name })}
                  value={g.level}
                  onChange={(e) =>
                    m.setLevel.mutate(
                      { userId: g.userId, level: e.target.value as ShareLevel },
                      { onError: (err) => toast.error(tr('没有改成功'), errText(err)) },
                    )
                  }
                  options={LEVEL_OPTIONS}
                  size="sm"
                  wrapperClassName="w-24"
                  className="max-md:h-11"
                />
                <IconButton
                  label={tr('移除 {name}', { name: g.name })}
                  size="sm"
                  className="max-md:size-11"
                  onClick={() =>
                    m.remove.mutate(g.userId, {
                      onError: (err) => toast.error(tr('移除失败'), errText(err)),
                    })
                  }
                >
                  <X strokeWidth={1.75} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Separator />

      <section aria-labelledby="share-link" className="flex flex-col gap-2.5">
        <h3 id="share-link" className="flex items-center gap-1.5 text-small font-medium text-fg">
          <Link2 className="size-4" strokeWidth={1.75} aria-hidden />
          {tr('链接分享')}
        </h3>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            aria-label={tr('谁可以通过链接访问')}
            value={s.link.scope}
            onChange={(e) => setLink({ scope: e.target.value as LinkScope })}
            options={(['invited', 'project', 'anyone'] as const).map((v) => ({
              value: v,
              label: v === 'invited' ? tr('关闭（仅邀请的人）') : LINK_SCOPE_LABEL[v],
            }))}
            wrapperClassName="min-w-0 flex-1"
            className="max-md:h-11"
          />
          <Select
            aria-label={tr('通过链接访问的权限')}
            value={s.link.level}
            disabled={!open}
            onChange={(e) => setLink({ level: e.target.value as ShareLevel })}
            options={LEVEL_OPTIONS}
            wrapperClassName="sm:w-28"
            className="max-md:h-11"
          />
        </div>
        <p className="text-caption text-fg-muted">
          {SCOPE_HINT[s.link.scope]}
          {s.link.scope === 'anyone' && tr('（需要登录研协账号）')}
        </p>
        {open && s.link.token && (
          <>
            <CopyRow label={tr('分享链接')} value={shareUrl(s.link.token)} />
            {confirmReset ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small text-warning">
                <span className="min-w-0 flex-1">
                  {tr('旧链接会立即失效，靠旧链接打开过的人也会失去访问。')}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  loading={m.reset.isPending}
                  onClick={() =>
                    m.reset.mutate(undefined, {
                      onSuccess: () => {
                        setConfirmReset(false);
                        toast.success(tr('链接已重置'));
                      },
                      onError: (e) => toast.error(tr('重置失败'), errText(e)),
                    })
                  }
                >
                  {tr('确认重置')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  {tr('取消')}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="self-start max-md:h-11"
                leftIcon={<RotateCcw strokeWidth={1.75} aria-hidden />}
                onClick={() => setConfirmReset(true)}
              >
                {tr('重置链接')}
              </Button>
            )}
          </>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <p className="text-small text-fg-muted">
          {tr('移到团队空间后课题成员都能看到，单独的邀请和链接会清空。')}
        </p>
        <Button
          variant="secondary"
          className="self-start max-md:h-11"
          leftIcon={<Users strokeWidth={1.75} aria-hidden />}
          loading={moving}
          onClick={onMoveTeam}
        >
          {kind === 'paper' ? tr('加入团队文献库') : tr('移到团队空间')}
        </Button>
      </section>
    </div>
  );
}

function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <p>{children}</p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const copy = () =>
    navigator.clipboard
      .writeText(value)
      .then(() => toast.success(tr('链接已复制')))
      .catch(() => toast.error(tr('复制失败'), tr('浏览器不允许访问剪贴板，可以手动选中复制。')));
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        wrapperClassName="min-w-0 flex-1"
        className="font-mono text-caption max-md:h-11"
      />
      <Button
        variant="secondary"
        className="max-md:h-11"
        leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
        onClick={copy}
      >
        {tr('复制')}
      </Button>
    </div>
  );
}
