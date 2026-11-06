import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { PageActions, PageTitle } from '@/components/layout/Page';
import {
  CircleCheck,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { AgentSession, ProjectMember, Thread } from '@srh/shared';
import {
  Avatar,
  Badge,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  RelativeTime,
  StatusDot,
  toast,
} from '@/components/ui';
import { BackLink } from '@/components/layout/BackLink';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { absoluteUrl } from '@/lib/base-path';
import { paletteFromString } from '@/lib/palette';
import { usePinStore, usePins } from '@/lib/pins';
import { isAgentBusy } from '@/lib/project';
import { displayTextClass, STATUS_DOT_CLASS, threadDisplay } from '@/lib/status';
import { useStopAgent, useUpdateThread } from '../thread-api';
import { tr } from '@/lib/i18n';

export interface ThreadHeaderProps {
  projectId: string;
  thread: Thread;
  owner: ProjectMember | undefined;
  agent: AgentSession | null;
  writable: boolean;
  /** 状态点是否带光环（同屏循环动画名额） */
  animateDot: boolean;
}

function TitleEditor({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: string;
  saving: boolean;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = value.trim();
    if (!t || t === initial) onCancel();
    else onSave(t);
  };
  return (
    <form onSubmit={submit} className="min-w-0 flex-1">
      <Input
        autoFocus
        size="lg"
        value={value}
        maxLength={80}
        disabled={saving}
        aria-label={tr('线程标题')}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => submit()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="text-h2"
      />
    </form>
  );
}

/** 线程详情的标题区：返回、可改的标题、状态与元信息、置顶 / 更多操作。 */
export function ThreadHeader({
  projectId,
  thread,
  owner,
  agent,
  writable,
  animateDot,
}: ThreadHeaderProps) {
  const [editing, setEditing] = useState(false);
  const location = useLocation();
  const returnHref =
    typeof location.state?.threadsHref === 'string' &&
    location.state.threadsHref.startsWith(projectPath(projectId, 'threads'))
      ? location.state.threadsHref
      : projectPath(projectId, 'threads');
  const update = useUpdateThread(projectId);
  const stop = useStopAgent(projectId);
  const pinned = usePins(projectId).includes(thread.id);
  const togglePin = usePinStore((s) => s.toggle);
  const busy = isAgentBusy(agent);
  const display = threadDisplay(thread, agent);

  const saveTitle = (title: string) =>
    update.mutate(
      { id: thread.id, patch: { title } },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => {
          setEditing(false);
          toast.error(tr('标题没改成'), e.message);
        },
      },
    );

  const setResolved = (resolved: boolean) =>
    update.mutate(
      { id: thread.id, patch: { resolved } },
      {
        onSuccess: () =>
          toast({
            title: resolved ? tr('已标为已解决') : tr('已重新打开'),
            tone: 'success',
            action: {
              label: tr('撤销'),
              onClick: () => update.mutate({ id: thread.id, patch: { resolved: !resolved } }),
            },
          }),
        onError: (e) => toast.error(tr('没能更新线程'), e.message),
      },
    );

  const copyLink = () => {
    const url = absoluteUrl(projectPath(projectId, `threads/${thread.id}`));
    void navigator.clipboard?.writeText(url).then(
      () => toast({ title: tr('已复制链接') }),
      () => toast.error(tr('复制失败'), tr('浏览器没有允许访问剪贴板，可以从地址栏复制。')),
    );
  };

  const stopAgent = () => {
    if (!agent) return;
    stop.mutate(agent.id, {
      onSuccess: () =>
        toast({ title: tr('已停止 agent'), description: tr('回复线程可以让它接着做。') }),
      onError: (e) => toast.error(tr('没能停止'), e.message),
    });
  };

  return (
    <header className="mb-4 min-w-0">
      <div className="mb-2">
        <BackLink to={returnHref}>{tr('全部线程')}</BackLink>
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <PageTitle>{thread.title}</PageTitle>
        {editing && (
          <TitleEditor
            initial={thread.title}
            saving={update.isPending}
            onSave={saveTitle}
            onCancel={() => setEditing(false)}
          />
        )}
        <PageActions>
          {writable && (
            <IconButton label={tr('修改标题')} size="sm" onClick={() => setEditing(true)}>
              <Pencil strokeWidth={1.75} aria-hidden />
            </IconButton>
          )}
          <IconButton
            label={pinned ? tr('取消置顶') : tr('置顶')}
            aria-pressed={pinned}
            onClick={() => togglePin(projectId, thread.id)}
          >
            {pinned ? (
              <PinOff strokeWidth={1.75} aria-hidden />
            ) : (
              <Pin strokeWidth={1.75} aria-hidden />
            )}
          </IconButton>
          <Menu
            label={tr('线程操作')}
            align="end"
            trigger={
              <IconButton label={tr('更多操作')}>
                <MoreHorizontal strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            {writable &&
              (thread.resolved ? (
                <MenuItem
                  icon={<RotateCcw strokeWidth={1.75} />}
                  onSelect={() => setResolved(false)}
                >
                  {tr('重新打开')}
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<CircleCheck strokeWidth={1.75} />}
                  description={tr('从默认列表里收起')}
                  onSelect={() => setResolved(true)}
                >
                  {tr('标为已解决')}
                </MenuItem>
              ))}
            <MenuItem icon={<Link2 strokeWidth={1.75} />} onSelect={copyLink}>
              {tr('复制链接')}
            </MenuItem>
            {writable && busy && (
              <>
                <MenuSeparator />
                <MenuItem danger icon={<Square strokeWidth={1.75} />} onSelect={stopAgent}>
                  {tr('停止 agent')}
                </MenuItem>
              </>
            )}
          </Menu>
        </PageActions>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          {animateDot ? (
            <StatusDot status={display.dot} label={display.label} />
          ) : (
            <span
              aria-hidden
              className={cn('size-2 rounded-full', STATUS_DOT_CLASS[display.dot])}
            />
          )}
          <span className={cn('text-fg', displayTextClass(display.kind))}>{display.label}</span>
        </span>
        {thread.label && <Badge color={paletteFromString(thread.label)}>{thread.label}</Badge>}
        {thread.resolved && (
          <Badge tone="success">
            <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
            {tr('已解决')}
          </Badge>
        )}
        {owner && (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Avatar name={owner.user.name} color={owner.user.avatarColor} size={20} />
            <span className="truncate">{tr('{name} 发起', { name: owner.user.name })}</span>
          </span>
        )}
        <span className="text-fg-subtle">
          {tr('创建于 ')}
          <RelativeTime iso={thread.createdAt} />
        </span>
        <span className="text-fg-subtle">
          {tr('最近活动 ')}
          <RelativeTime iso={thread.lastActivityAt} />
        </span>
      </div>
    </header>
  );
}
