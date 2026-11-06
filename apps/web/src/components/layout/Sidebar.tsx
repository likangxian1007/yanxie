import { useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { LayoutGroup } from 'motion/react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Coins,
  LogOut,
  LibraryBig,
  MessageSquareWarning,
  MessagesSquare,
  Pin,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  UserRound,
  Languages,
  type LucideIcon,
} from 'lucide-react';
import { FEEDBACK_COPY } from '@/features/feedback/copy';
import { openFeedbackDialog } from '@/features/feedback/feedback-store';
import { ADMIN_COPY } from '@/features/admin/copy';
import {
  Avatar,
  Badge,
  Dialog,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Skeleton,
  StatusDot,
  Tooltip,
} from '@/components/ui';
import { HELP_NAV } from '@/features/help/nav';
import { useInboxCount } from '@/features/inbox/use-inbox-count';
import { cn } from '@/lib/cn';
import { paletteSoft } from '@/lib/palette';
import type { DocumentMeta, Thread } from '@srh/shared';
import { DocKindIcon } from '@/features/docs/kinds';
import { useDocs } from '@/features/docs/list/use-docs';
import { usePins } from '@/lib/pins';
import { threadHref, useThreadContextMenu } from '@/features/threads/components/thread-actions';
import { useMembers, useProject, useThreads } from '@/lib/project';
import { useLogout, useMe } from '@/lib/session';
import {
  PRIMARY_NAV,
  PLANS_NAV,
  RESOURCE_GROUPS,
  THREADS_NAV,
  projectPath,
  SETTINGS_NAV,
} from './nav-items';
import { BrandMark } from './BrandMark';
import { useLayoutStore } from './layout-store';
import { modKeyLabel } from '@/lib/platform';
import { ProjectCreateForm } from './ProjectCreateForm';
import { SidebarNavItem } from './SidebarNavItem';
import { useServiceStatus } from './use-service-status';
import { getLang, switchLang, tr } from '@/lib/i18n';

export interface SidebarProps {
  projectId: string;
  collapsed: boolean;
  /** 区分桌面侧栏与移动端抽屉，避免两份 layoutId 互相干扰 */
  layoutGroupId: string;
  /** 点击导航项后（移动端用来关闭抽屉） */
  onNavigate?: () => void;
  /** 项目切换器右侧的附加按钮（移动端抽屉的关闭按钮） */
  headerAction?: ReactNode;
  className?: string;
}

function ProjectSwitcher({ projectId, collapsed }: { projectId: string; collapsed: boolean }) {
  const navigate = useNavigate();
  const project = useProject(projectId);
  const members = useMembers(projectId);
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const p = project.data;

  const button = (
    <button
      type="button"
      aria-label={p ? tr('当前课题：{name}（切换课题）', { name: p.name }) : tr('切换课题')}
      className={cn(
        'press flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
        collapsed && 'justify-center px-0',
      )}
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-sm text-body ring-1 ring-line"
        style={{ backgroundColor: p ? paletteSoft(p.color) : undefined }}
      >
        {p?.icon ?? ''}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            {p ? (
              <span className="block truncate text-small leading-5 font-medium text-fg">
                {p.name}
              </span>
            ) : (
              <Skeleton className="h-3.5 w-24" />
            )}
            <span className="block truncate text-caption leading-4 font-normal text-fg-subtle">
              {members.data ? tr('{count} 位成员', { count: members.data.length }) : '\u00a0'}
            </span>
          </span>
          <ChevronsUpDown
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 text-fg-subtle"
          />
        </>
      )}
    </button>
  );

  return (
    <>
      <Menu
        label={tr('切换课题')}
        align="start"
        className="w-64"
        trigger={
          <span className="flex min-w-0 flex-1">
            <Tooltip
              content={p?.name ?? tr('课题')}
              side="right"
              disabled={!collapsed}
              className="flex w-full"
            >
              {button}
            </Tooltip>
          </span>
        }
      >
        <MenuLabel>{tr('我的课题')}</MenuLabel>
        {(me.data?.projects ?? []).map((x) => (
          <MenuItem
            key={x.id}
            icon={<span className="text-body leading-none">{x.icon}</span>}
            onSelect={() => navigate(`/p/${x.id}`)}
          >
            <span className="flex items-center gap-2">
              <span className="truncate">{x.name}</span>
              {x.id === projectId && (
                <Check size={14} strokeWidth={2} aria-label={tr('当前')} className="text-accent" />
              )}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Plus strokeWidth={1.75} />} onSelect={() => setCreating(true)}>
          {tr('新建课题')}
        </MenuItem>
      </Menu>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={tr('新建课题')}
        description={tr('课题有自己的协调者、文档、看板和成员。')}
      >
        <ProjectCreateForm onCancel={() => setCreating(false)} />
      </Dialog>
    </>
  );
}

function SidebarUser({
  projectId,
  collapsed,
  onNavigate,
}: {
  projectId: string;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const service = useServiceStatus();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const user = me.data?.user;
  const name = user?.name ?? '…';

  const trigger = collapsed ? (
    <button
      type="button"
      aria-label={name}
      className="press relative flex size-9 cursor-pointer items-center justify-center rounded-md hover:bg-muted/60"
    >
      <Avatar name={name} color={user?.avatarColor} size={24} aria-hidden />
    </button>
  ) : (
    <button
      type="button"
      className="press flex w-full cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-muted/60"
    >
      <Avatar name={name} color={user?.avatarColor} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{name}</span>
      </span>
    </button>
  );

  return (
    <>
      <Menu label={tr('账号')} side="top" align="start" className="w-56" trigger={trigger}>
        {user && <MenuLabel>{user.email}</MenuLabel>}
        <MenuItem
          icon={<UserRound strokeWidth={1.75} />}
          onSelect={() => navigate(`${projectPath(projectId, 'settings')}?tab=profile`)}
        >
          {tr('个人资料与外观')}
        </MenuItem>
        <MenuItem
          icon={<Settings2 strokeWidth={1.75} />}
          onSelect={() => navigate(projectPath(projectId, 'settings'))}
        >
          {tr('课题设置')}
        </MenuItem>
        <MenuItem
          icon={<Languages strokeWidth={1.75} />}
          onSelect={() => switchLang(getLang() === 'en' ? 'zh' : 'en')}
        >
          {/* 用目标语言写，任何界面语言下都认得出来 */}
          {getLang() === 'en' ? '切换到中文' /* i18n-ignore */ : 'Switch to English'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={<MessageSquareWarning strokeWidth={1.75} />}
          onSelect={() => {
            onNavigate?.();
            openFeedbackDialog();
          }}
        >
          {FEEDBACK_COPY.entryLong}
        </MenuItem>
        <MenuItem
          icon={<MessagesSquare strokeWidth={1.75} />}
          onSelect={() => {
            onNavigate?.();
            navigate('/feedback');
          }}
        >
          {FEEDBACK_COPY.center}
        </MenuItem>
        <MenuItem
          icon={<Coins strokeWidth={1.75} />}
          onSelect={() => {
            onNavigate?.();
            navigate('/billing');
          }}
        >
          {tr('余额与充值')}
        </MenuItem>
        {user?.isAdmin && (
          <MenuItem
            icon={<ShieldCheck strokeWidth={1.75} />}
            onSelect={() => {
              onNavigate?.();
              navigate('/admin');
            }}
          >
            {ADMIN_COPY.title}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<LogOut strokeWidth={1.75} />} onSelect={() => logout.mutate()}>
          {tr('退出登录')}
        </MenuItem>
      </Menu>
      {service.status === 'failed' && (
        <Tooltip content={tr('服务异常，查看状态')} side="right" disabled={!collapsed}>
          <NavLink
            to={`${projectPath(projectId, 'help')}#service-status`}
            aria-label={tr('服务异常，查看状态')}
            onClick={onNavigate}
            className={cn(
              'flex min-h-8 items-center gap-2 rounded-sm px-2 text-caption text-warning hover:bg-muted/60 max-md:min-h-11',
              collapsed && 'justify-center px-0',
            )}
          >
            <AlertCircle size={15} strokeWidth={1.75} aria-hidden />
            {!collapsed && <span>{tr('服务异常，查看状态')}</span>}
          </NavLink>
        </Tooltip>
      )}
    </>
  );
}

/** 置顶的一条：右键和项目里其他列表一样能重命名、取消置顶等。 */
function PinnedRow({
  projectId,
  thread: t,
  onNavigate,
}: {
  projectId: string;
  thread: Thread;
  onNavigate?: (() => void) | undefined;
}) {
  const { handlers, menu } = useThreadContextMenu(t, projectId);
  return (
    <li>
      <NavLink
        to={threadHref(projectId, t)}
        onClick={onNavigate}
        {...handlers}
        className={({ isActive }) =>
          cn(
            'flex h-8 items-center gap-2.5 rounded-sm px-2 text-body transition-colors duration-(--dur-fast)',
            isActive
              ? 'bg-surface font-medium text-fg shadow-xs ring-1 ring-line dark:bg-muted'
              : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
          )
        }
      >
        <span className="flex w-[18px] shrink-0 justify-center">
          <StatusDot status={t.statusBucket} />
        </span>
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
      </NavLink>
      {menu}
    </li>
  );
}

type PinnedItem = { type: 'thread'; thread: Thread } | { type: 'doc'; doc: DocumentMeta };

/** 置顶的文档：点开文档；取消置顶在文档列表的右键菜单里。 */
function PinnedDocRow({
  projectId,
  doc,
  onNavigate,
}: {
  projectId: string;
  doc: DocumentMeta;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <li>
      <NavLink
        to={`/p/${projectId}/docs/${doc.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex h-8 items-center gap-2.5 rounded-sm px-2 text-body transition-colors duration-(--dur-fast)',
            isActive
              ? 'bg-surface font-medium text-fg shadow-xs ring-1 ring-line dark:bg-muted'
              : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
          )
        }
      >
        <span className="flex w-[18px] shrink-0 justify-center">
          <DocKindIcon kind={doc.kind} size="sm" className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{doc.title || tr('未命名文档')}</span>
      </NavLink>
    </li>
  );
}

function PinnedThreads({
  projectId,
  layoutGroupId,
  onNavigate,
}: {
  projectId: string;
  layoutGroupId: string;
  onNavigate?: (() => void) | undefined;
}) {
  const pins = usePins(projectId);
  const threads = useThreads(projectId, { kind: 'project' });
  const personal = useThreads(projectId, { kind: 'personal' });
  const docs = useDocs(projectId);
  const threadById = new Map(
    [...(threads.data ?? []), ...(personal.data ?? [])].map((t) => [t.id, t]),
  );
  const docById = new Map((Array.isArray(docs.data) ? docs.data : []).map((d) => [d.id, d]));
  const pinned = pins.flatMap((id): PinnedItem[] => {
    const t = threadById.get(id);
    if (t) return [{ type: 'thread', thread: t }];
    const d = docById.get(id);
    return d ? [{ type: 'doc', doc: d }] : [];
  });

  if (pinned.length === 0) return null;

  return (
    <section aria-labelledby={`${layoutGroupId}-pinned`} className="mt-6">
      <h2
        id={`${layoutGroupId}-pinned`}
        className="mb-1.5 flex items-center gap-1.5 px-2 text-caption text-fg-subtle"
      >
        <Pin size={12} strokeWidth={2} aria-hidden />
        {tr('置顶')}
      </h2>
      {pinned.length === 0 ? (
        <p className="px-2 text-caption font-normal text-pretty text-fg-subtle">
          {tr('在线程、会话或文档上右键选「置顶」，常用的会出现在这里。')}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {pinned.map((p) =>
            p.type === 'thread' ? (
              <PinnedRow
                key={p.thread.id}
                projectId={projectId}
                thread={p.thread}
                onNavigate={onNavigate}
              />
            ) : (
              <PinnedDocRow
                key={p.doc.id}
                projectId={projectId}
                doc={p.doc}
                onNavigate={onNavigate}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
/** 不挂在课题下的顶层入口（/feedback、/admin），样式与 SidebarNavItem 一致。 */
function TopLevelNavItem({
  to,
  label,
  icon: Icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <li>
      <Tooltip content={label} side="right" disabled={!collapsed} className="flex w-full">
        <NavLink
          to={to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small select-none max-md:h-11',
              isActive
                ? 'bg-muted font-medium text-fg'
                : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
              collapsed && 'justify-center px-0',
            )
          }
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden />
          <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
        </NavLink>
      </Tooltip>
    </li>
  );
}

/**
 * 侧边栏：课题切换 → 主导航 → 待我处理 → 置顶线程 → 底部（设置、用户、服务状态）。
 * 桌面 224px，可收起到 60px（只显示图标 + tooltip）。
 */
export function Sidebar({
  projectId,
  collapsed,
  layoutGroupId,
  onNavigate,
  headerAction,
  className,
}: SidebarProps) {
  const inboxCount = useInboxCount(projectId);
  const isAdmin = useMe().data?.user.isAdmin === true;
  const location = useLocation();
  const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);
  const [groups, setGroups] = useState<{ path: string; expanded: Record<string, boolean> }>({
    path: location.pathname,
    expanded: {},
  });
  const expandedGroups = groups.path === location.pathname ? groups.expanded : {};
  const inboxBadge =
    inboxCount > 0 ? (
      <Badge tone="warning" animateKey={inboxCount}>
        {inboxCount}
      </Badge>
    ) : undefined;

  return (
    <LayoutGroup id={layoutGroupId}>
      <div className={cn('chrome flex h-full min-h-0 flex-col', className)}>
        <div
          className={cn(
            'flex h-(--topbar-h) shrink-0 items-center justify-between px-5',
            collapsed && 'justify-center px-2',
          )}
        >
          <NavLink
            to={projectPath(projectId, '')}
            aria-label={tr('研协首页')}
            className="min-w-0 rounded-sm"
          >
            <BrandMark withText={!collapsed} className="[&>svg]:size-7" />
          </NavLink>
          {headerAction}
        </div>
        <div className={cn('shrink-0 space-y-2 px-3 pt-1 pb-4', collapsed && 'px-2.5')}>
          <ProjectSwitcher projectId={projectId} collapsed={collapsed} />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={tr('搜索与命令')}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small text-fg-muted hover:bg-muted/60 max-md:h-11',
              collapsed && 'justify-center px-0',
            )}
          >
            <span className="flex w-7 shrink-0 justify-center">
              <Search size={16} strokeWidth={1.75} aria-hidden />
            </span>
            {!collapsed && (
              <>
                <span className="flex-1 text-left">{tr('搜索')}</span>
                <span className="text-caption text-fg-subtle">{modKeyLabel()} K</span>
              </>
            )}
          </button>
        </div>
        <nav
          aria-label={tr('主导航')}
          className={cn(
            'min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4',
            collapsed && 'px-2.5',
          )}
        >
          <ul className="flex flex-col gap-0.5">
            {PRIMARY_NAV.map((item) => (
              <SidebarNavItem
                key={item.to}
                item={item}
                projectId={projectId}
                collapsed={collapsed}
                badge={item.to === 'inbox' ? inboxBadge : undefined}
                onNavigate={onNavigate}
              >
                {item.to === 'workspace' && (
                  <ul
                    aria-label={tr('我的工作区资料')}
                    className={cn(!collapsed && 'ml-4 border-l border-line pl-2')}
                  >
                    <li>
                      <Tooltip
                        content={tr('个人文献库')}
                        side="right"
                        disabled={!collapsed}
                        className="flex w-full"
                      >
                        <NavLink
                          to="/library"
                          onClick={onNavigate}
                          className={({ isActive }) =>
                            cn(
                              'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small max-md:h-11',
                              isActive
                                ? 'bg-muted font-medium text-fg'
                                : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
                              collapsed && 'justify-center px-0',
                            )
                          }
                        >
                          <LibraryBig size={18} strokeWidth={1.75} aria-hidden />
                          <span className={cn('truncate', collapsed && 'sr-only')}>
                            {tr('个人文献库')}
                          </span>
                        </NavLink>
                      </Tooltip>
                    </li>
                  </ul>
                )}
              </SidebarNavItem>
            ))}
          </ul>
          <section aria-label={tr('资源')} className="mt-6">
            {!collapsed && <h2 className="mb-2 px-2 text-caption text-fg-subtle">{tr('资源')}</h2>}
            <ul className="flex flex-col gap-0.5">
              <SidebarNavItem
                item={THREADS_NAV}
                projectId={projectId}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
              <SidebarNavItem
                item={PLANS_NAV}
                projectId={projectId}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
              {RESOURCE_GROUPS.map((group) => {
                const active = group.items.some((item) =>
                  location.pathname.startsWith(projectPath(projectId, item.to)),
                );
                const expanded = expandedGroups[group.label] ?? active;
                return (
                  <li key={group.label}>
                    {!collapsed && (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`${layoutGroupId}-${group.label}`}
                        onClick={() =>
                          setGroups({
                            path: location.pathname,
                            expanded: { ...expandedGroups, [group.label]: !expanded },
                          })
                        }
                        className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small text-fg-muted hover:bg-muted/60 max-md:h-11"
                      >
                        <ChevronRight
                          size={16}
                          strokeWidth={1.75}
                          aria-hidden
                          className={cn(
                            'transition-transform duration-(--dur-fast) motion-reduce:transition-none',
                            expanded && 'rotate-90',
                          )}
                        />
                        {group.label}
                      </button>
                    )}
                    {(expanded || collapsed) && (
                      <ul
                        id={`${layoutGroupId}-${group.label}`}
                        className={cn(
                          'flex flex-col gap-0.5',
                          !collapsed && 'ml-4 border-l border-line pl-1',
                        )}
                      >
                        {group.items.map((item) => (
                          <SidebarNavItem
                            key={item.to}
                            item={item}
                            projectId={projectId}
                            collapsed={collapsed}
                            onNavigate={onNavigate}
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          {!collapsed && (
            <PinnedThreads
              projectId={projectId}
              layoutGroupId={layoutGroupId}
              onNavigate={onNavigate}
            />
          )}
        </nav>

        <div className={cn('shrink-0 border-t border-line px-3 pt-2 pb-3', collapsed && 'px-2.5')}>
          <ul className="mb-1 flex flex-col gap-0.5">
            <SidebarNavItem
              item={SETTINGS_NAV}
              projectId={projectId}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
            <SidebarNavItem
              item={HELP_NAV}
              projectId={projectId}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
            <TopLevelNavItem
              to="/feedback"
              label={FEEDBACK_COPY.center}
              icon={MessagesSquare}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
            {isAdmin && (
              <TopLevelNavItem
                to="/admin"
                label={ADMIN_COPY.title}
                icon={ShieldCheck}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            )}
          </ul>
          <SidebarUser projectId={projectId} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
      </div>
    </LayoutGroup>
  );
}
