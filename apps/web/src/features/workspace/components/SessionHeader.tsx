import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Forward, Link2, MoreHorizontal, Pencil, RotateCcw } from 'lucide-react';
import type { AgentSession, Thread } from '@srh/shared';
import {
  Button,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  RelativeTime,
  StatusDot,
  Tooltip,
  toast,
} from '@/components/ui';
import { PageTitle, PageActions } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { absoluteUrl } from '@/lib/base-path';
import { isAgentBusy } from '@/lib/project';
import { threadDisplay } from '@/lib/status';
import { formatFullTimeZh } from '@/lib/time';
import { useUpdatePersonalThread } from '../workspace-api';
import { tr } from '@/lib/i18n';

const TITLE_MAX = 80;

/** “已于 X 转给协调者”里的 X：今天 16:40 / 昨天 16:40 / 10月24日 16:40 / 完整日期。 */
function shortTimeZh(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return tr('今天 {hm}', { hm });
  if (d.toDateString() === yesterday.toDateString()) return tr('昨天 {hm}', { hm });
  if (d.getFullYear() === now.getFullYear())
    return tr('{value}月{d}日 {hm}', { value: d.getMonth() + 1, d: d.getDate(), hm });
  return formatFullTimeZh(iso);
}

function ForwardedAt({ iso }: { iso: string }) {
  const [now] = useState(() => new Date());
  return (
    <time dateTime={iso} title={formatFullTimeZh(iso)} className="tabular-nums">
      {shortTimeZh(iso, now)}
    </time>
  );
}

export interface SessionHeaderProps {
  projectId: string;
  thread: Thread;
  agent: AgentSession | null;
  writable: boolean;
  onForward: () => void;
}

/** 会话页头：标题（可就地改名）、状态、转给协调者、更多操作。 */
export function SessionHeader({
  projectId,
  thread,
  agent,
  writable,
  onForward,
}: SessionHeaderProps) {
  const update = useUpdatePersonalThread(projectId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = isAgentBusy(agent);
  const display = threadDisplay(thread, agent);
  const status = busy ? 'working' : thread.resolved ? 'completed' : display.dot;
  const statusText = busy
    ? (agent?.activity ?? tr('个人 agent 正在回复'))
    : thread.resolved
      ? tr('已解决')
      : display.label;

  // 菜单关闭时会把焦点还给触发按钮，所以稍等一下再聚焦输入框
  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [editing]);

  // 回车提交、Esc 取消之后输入框卸载可能再触发一次 blur：用 ref 保证只结算一次
  const editingRef = useRef(false);

  const startEdit = () => {
    editingRef.current = true;
    setTitle(thread.title);
    setEditing(true);
  };

  const cancel = () => {
    editingRef.current = false;
    setEditing(false);
  };

  const commit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const next = title.trim();
    setEditing(false);
    if (!next || next === thread.title) return;
    update.mutate(
      { thread, patch: { title: next.slice(0, TITLE_MAX) } },
      { onError: (e) => toast.error(tr('标题没改成'), e.message) },
    );
  };

  const toggleResolved = () => {
    const resolved = !thread.resolved;
    update.mutate(
      { thread, patch: { resolved } },
      {
        onSuccess: () => toast.success(resolved ? tr('已标为已解决') : tr('已重新打开')),
        onError: (e) => toast.error(tr('没能更新会话'), e.message),
      },
    );
  };

  const copyLink = async () => {
    const url = absoluteUrl(projectPath(projectId, `workspace/${thread.id}`));
    try {
      await navigator.clipboard.writeText(url);
      toast.success(tr('链接已复制'), tr('个人会话只有你自己能打开'));
    } catch {
      toast.error(tr('没能复制链接'), tr('浏览器拒绝了剪贴板访问，可以直接复制地址栏里的链接。'));
    }
  };

  const forwarded = Boolean(thread.forwardedAt);

  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-line pb-4">
      <div className="flex items-start gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          {editing && <PageTitle>{thread.title}</PageTitle>}
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                commit();
              }}
            >
              <Input
                ref={inputRef}
                size="lg"
                value={title}
                maxLength={TITLE_MAX}
                aria-label={tr('会话标题')}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancel();
                  }
                }}
              />
            </form>
          ) : writable ? (
            <PageTitle>
              <button
                type="button"
                onClick={startEdit}
                title={tr('点击重命名')}
                className="-mx-1.5 max-w-full cursor-text rounded-sm px-1.5 text-left break-words transition-colors duration-(--dur-fast) hover:bg-subtle"
              >
                {thread.title}
              </button>
            </PageTitle>
          ) : (
            <PageTitle>{thread.title}</PageTitle>
          )}

          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-fg-muted">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <StatusDot status={status} label={statusText} />
              <span className={cn('truncate', busy && 'text-agent-text')}>{statusText}</span>
            </span>
            <span className="text-fg-subtle">
              {tr('开始于 ')}
              <RelativeTime iso={thread.createdAt} />
            </span>
          </div>
        </div>

        <PageActions>
          {writable && (
            <Tooltip
              content={
                forwarded
                  ? tr('这段会话已经转给协调者了')
                  : tr('把这段会话交给协调者，团队就能接手')
              }
            >
              <Button
                variant={forwarded ? 'secondary' : 'primary'}
                leftIcon={<Forward strokeWidth={1.75} aria-hidden />}
                aria-disabled={forwarded || undefined}
                className={cn(forwarded && 'cursor-not-allowed opacity-50 hover:bg-surface')}
                onClick={() => {
                  if (!forwarded) onForward();
                }}
              >
                {tr('转给协调者')}
              </Button>
            </Tooltip>
          )}
          <Menu
            align="end"
            label={tr('会话操作')}
            trigger={
              <IconButton label={tr('更多操作')}>
                <MoreHorizontal strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            {writable && (
              <MenuItem icon={<Pencil strokeWidth={1.75} />} onSelect={startEdit}>
                {tr('重命名')}
              </MenuItem>
            )}
            {writable && (
              <MenuItem
                icon={
                  thread.resolved ? (
                    <RotateCcw strokeWidth={1.75} />
                  ) : (
                    <CircleCheck strokeWidth={1.75} />
                  )
                }
                onSelect={toggleResolved}
              >
                {thread.resolved ? tr('重新打开') : tr('标为已解决')}
              </MenuItem>
            )}
            {writable && <MenuSeparator />}
            <MenuItem icon={<Link2 strokeWidth={1.75} />} onSelect={() => void copyLink()}>
              {tr('复制链接')}
            </MenuItem>
          </Menu>
        </PageActions>
      </div>

      {forwarded && thread.forwardedAt && (
        <p className="flex flex-wrap items-center gap-x-1.5 rounded-md bg-agent-soft px-3 py-2 text-small text-agent-text">
          <Forward size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span>
            {tr('已于 ')}
            <ForwardedAt iso={thread.forwardedAt} />
            {tr(' 转给协调者')}
          </span>
          <span aria-hidden>·</span>
          <Link
            to={projectPath(projectId, '')}
            className="font-medium underline-offset-2 hover:underline"
          >
            {tr('去协作台查看')}
          </Link>
        </p>
      )}
    </header>
  );
}
