import { useNavigate, useParams, useSearchParams } from 'react-router';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { NewSessionHero } from '../components/NewSessionHero';
import { SessionList } from '../components/SessionList';
import { SessionView } from '../components/SessionView';
import { usePersonalThreads } from '../workspace-api';
import { tr } from '@/lib/i18n';

/**
 * 我的工作区：每个成员和自己的个人 agent 的私人会话，别人看不到；想清楚后一键转给协调者。
 *
 * 布局（像 Claude / ChatGPT 的双栏）：
 * - ≥ 1024px：页面内 280px 的会话列表（吸顶、单独滚动）+ 右侧会话 / 开始页
 * - < 1024px：/workspace 就是会话列表；打开会话或 ?new=1 时整屏显示，带返回
 * 消息流和吸底输入框都跟着 AppShell 的 #app-scroll 滚动。
 */
export function WorkspacePage() {
  const projectId = useProjectId();
  const { threadId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const writable = canWrite(useMyRole(projectId));
  const threads = usePersonalThreads(projectId);
  const isNew = params.get('new') === '1';
  const firstTime = threads.isSuccess && threads.data.length === 0;
  // 手机上：选中会话或新建时显示右侧内容，否则显示列表
  const showDetailOnMobile = Boolean(threadId) || isNew || firstTime;

  const startNew = () => {
    const next = new URLSearchParams(params);
    next.set('new', '1');
    navigate(`${projectPath(projectId, 'workspace')}?${next}`);
  };

  return (
    <div
      className={cn(
        'flex min-h-full flex-1 flex-col',
        !firstTime && 'lg:grid lg:grid-cols-[280px_minmax(0,1fr)]',
      )}
    >
      {!firstTime && (
        <aside
          id="workspace-list-scroll"
          aria-label={tr('会话列表')}
          className={cn(
            'flex-col px-3 pt-6 pb-8 md:px-5 md:pt-8',
            'lg:sticky lg:top-(--topbar-h) lg:h-[calc(100dvh-var(--topbar-h))] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:border-r lg:border-line lg:px-3 lg:pt-6 lg:pb-4',
            showDetailOnMobile ? 'hidden lg:flex' : 'flex',
          )}
        >
          <SessionList
            projectId={projectId}
            threads={threads.data}
            isPending={threads.isPending}
            error={threads.error}
            onRetry={() => void threads.refetch()}
            activeId={threadId}
            onNew={startNew}
            canCreate={writable}
            thinkingBudget={threadId ? 1 : 2}
          />
        </aside>
      )}

      <section
        aria-label={threadId ? tr('会话') : tr('新建会话')}
        className={cn('min-w-0 flex-1 flex-col', showDetailOnMobile ? 'flex' : 'hidden lg:flex')}
      >
        {threadId ? (
          <SessionView
            key={threadId}
            projectId={projectId}
            threadId={threadId}
            writable={writable}
          />
        ) : (
          <NewSessionHero
            projectId={projectId}
            autoFocus={isNew}
            firstTime={firstTime}
            showBack={!firstTime}
            writable={writable}
          />
        )}
      </section>
    </div>
  );
}
