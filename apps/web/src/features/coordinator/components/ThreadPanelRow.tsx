import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { FolderOpen, ListChecks, Vote } from 'lucide-react';
import { Avatar, AvatarStack, RelativeTime, StatusDot } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { ThreadActionsMenu } from '@/features/threads/components/ThreadActions';
import { useThreadContextMenu } from '@/features/threads/components/thread-actions';
import { cn } from '@/lib/cn';
import { statusText, type PanelThread } from '../thread-panel';
import { tr } from '@/lib/i18n';

export interface ThreadPanelRowProps {
  row: PanelThread;
  projectId: string;
  /** 普通点击：在面板里打开（Ctrl / ⌘ / 中键仍走链接，打开完整页面） */
  onOpen: (threadId: string) => void;
  nameOf: (userId: string) => string | undefined;
  colorOf: (userId: string) => number | undefined;
  /** 是否带动画状态点（同屏循环动画不超过 3 个） */
  animateDot?: boolean;
}

/** 修饰键或非左键：交给浏览器（新标签 / 完整页面） */
function isPlainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** 线程面板里的一行：标题 + 状态，现在在做什么，进度 · 产出 · 在等谁 · 谁在看 · 最近活动。 */
export function ThreadPanelRow({
  row,
  projectId,
  onOpen,
  nameOf,
  colorOf,
  animateDot = true,
}: ThreadPanelRowProps) {
  const { thread } = row;
  const href = projectPath(projectId, `threads/${thread.id}`);
  const context = useThreadContextMenu(thread, projectId);
  const waitingOthers = row.status.kind === 'waiting' && !row.waitingOnMe ? row.waitingOn : [];
  const status = statusText(row, nameOf);

  return (
    <li className="group/row relative">
      <Link
        to={href}
        onClick={(e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          onOpen(thread.id);
        }}
        {...context.handlers}
        aria-label={tr('{title}，{status}', { title: thread.title, status })}
        className={cn(
          'press flex min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 pr-9 text-left',
          'transition-colors duration-(--dur-fast) hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          thread.resolved && 'opacity-80',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot
            status={
              animateDot ? row.status.dot : row.status.dot === 'working' ? 'idle' : row.status.dot
            }
            label={row.status.label}
          />
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
            {thread.title}
          </span>
          {waitingOthers.length > 0 && (
            <Avatar
              name={nameOf(waitingOthers[0] ?? '') ?? tr('成员')}
              color={colorOf(waitingOthers[0] ?? '')}
              size={20}
              aria-hidden
            />
          )}
          <span
            className={cn(
              'shrink-0 text-caption font-medium',
              row.waitingOnMe
                ? 'rounded-full bg-warning-soft px-1.5 text-warning'
                : row.status.textClass,
            )}
          >
            {status}
          </span>
        </span>

        {row.current && (
          <span className="truncate pl-4 text-small text-fg-muted">{row.current}</span>
        )}

        <span className="flex min-w-0 items-center gap-3 pl-4 text-caption font-normal text-fg-subtle tabular-nums">
          {row.progress.total > 0 && (
            <span className="inline-flex items-center gap-1" title={tr('进度')}>
              <ListChecks size={13} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">{tr('进度')}</span>
              {row.progress.done}/{row.progress.total}
            </span>
          )}
          {row.outputs > 0 && (
            <span className="inline-flex items-center gap-1" title={tr('产出')}>
              <FolderOpen size={13} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">{tr('产出')}</span>
              {row.outputs}
            </span>
          )}
          {row.openDecisions > 0 && (
            <span className="inline-flex items-center gap-1 text-warning" title={tr('待拍板')}>
              <Vote size={13} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">{tr('待拍板')}</span>
              {row.openDecisions}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            <RelativeTime iso={thread.lastActivityAt} />
          </span>
        </span>
      </Link>
      <div className="flex justify-end px-2.5">
        {row.viewers.length > 0 && (
          <AvatarStack
            size={20}
            max={3}
            expand="left"
            label={tr('正在看这个线程')}
            members={row.viewers.map((v) => ({
              id: v.userId,
              name: v.name,
              color: v.color,
              activity: v.typing ? tr('正在输入') : tr('正在看'),
            }))}
          />
        )}
      </div>

      <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
        <ThreadActionsMenu thread={thread} projectId={projectId} />
      </div>
      {context.menu}
    </li>
  );
}
