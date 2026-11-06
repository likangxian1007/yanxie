import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  CornerDownLeft,
  FileText,
  BookMarked,
  Lightbulb,
  Microscope,
  FolderKanban,
  LogOut,
  Moon,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquareSlash,
  Sun,
  UserCog,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Avatar, Dialog, Kbd, StatusDot } from '@/components/ui';
import { DOC_KIND_META, type DocKindMeta } from '@/features/docs/kinds';
import { helpPaletteCommands } from '@/features/onboarding/palette-commands';
import { researchApi, researchKey } from '@/features/research/data';
import { cn } from '@/lib/cn';
import { useHarness, useMcpServers } from '@/lib/harness';
import { useMotionPreset } from '@/lib/motion';
import { ROLE_LABEL, useMembers, useThreads } from '@/lib/project';
import { useLogout, useMe } from '@/lib/session';
import { useThemeStore } from '@/lib/theme';
import { useLayoutStore } from './layout-store';
import { INBOX_NAV, MAIN_NAV, projectPath, SETTINGS_NAV } from './nav-items';
import {
  DOC_SEARCH_DEBOUNCE_MS,
  filterMembers,
  harnessLinks,
  settingsLinks,
  useDebouncedValue,
  useDocSearch,
  type PaletteLink,
} from './palette-sources';
import { tr } from '@/lib/i18n';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  keywords?: string;
  /** 服务端已经按搜索词筛过（文档全文搜索），本地不再按标题过滤 */
  remote?: boolean;
  /** 只在输入了搜索词时出现（设置分区、Skill 这类条目多，空面板里不列） */
  searchOnly?: boolean;
  run: () => void;
}

const SETTINGS_GROUP = tr('设置');
const HARNESS_GROUP = tr('Skill、指令与 MCP');

/** 分组的展示顺序；同组内保持加入时的顺序 */
const GROUP_ORDER = [
  tr('跳转'),
  tr('操作'),
  SETTINGS_GROUP,
  tr('线程'),
  tr('文档'),
  tr('研究空间'),
  tr('研究资料'),
  tr('研究结论'),
  HARNESS_GROUP,
  tr('成员'),
  tr('我的会话'),
  tr('切换课题'),
];

const LINK_ICON: Record<PaletteLink['kind'], LucideIcon> = {
  settings: Settings,
  skill: Sparkles,
  command: SquareSlash,
  mcp: Plug,
  profile: UserCog,
};

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

function matches(cmd: Command, q: string): boolean {
  if (!q) return !cmd.searchOnly;
  if (cmd.remote) return true;
  const hay = `${cmd.label} ${cmd.hint ?? ''} ${cmd.keywords ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

/**
 * ⌘K 命令面板：跳转页面、打开线程与文档、找成员、切换课题、常用操作。
 * 上下键选择，Enter 执行，Esc 关闭。
 */
export function CommandPalette({ projectId }: { projectId: string }) {
  const open = useLayoutStore((s) => s.paletteOpen);
  const setOpen = useLayoutStore((s) => s.setPaletteOpen);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={tr('命令面板')}
      size="md"
      bare
      placement="top"
      instantClose
      className="max-h-[min(560px,76dvh)]"
    >
      {open && <PaletteBody projectId={projectId} onClose={() => setOpen(false)} />}
    </Dialog>
  );
}

function PaletteBody({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { spring } = useMotionPreset();
  const me = useMe();
  const threads = useThreads(projectId, { kind: 'project' });
  const personal = useThreads(projectId, { kind: 'personal' });
  const members = useMembers(projectId);
  const docs = useDocSearch(projectId, query);
  const researchQuery = useDebouncedValue(query.trim().slice(0, 200), DOC_SEARCH_DEBOUNCE_MS);
  const research = useQuery({
    queryKey: researchKey(projectId, 'search', researchQuery),
    queryFn: ({ signal }) => researchApi.search(projectId, researchQuery, signal),
    enabled: !!projectId && !!researchQuery,
    staleTime: 30_000,
    retry: false,
  });
  // 输入框也在用这份汇总（指令、Skill、Profile），通常已经在缓存里
  const harness = useHarness(projectId);
  const mcp = useMcpServers(projectId);
  const logout = useLogout();
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const setTheme = useThemeStore((s) => s.setPreference);
  const q = query.trim();

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const list: Command[] = [];
    for (const item of [...MAIN_NAV, INBOX_NAV, SETTINGS_NAV]) {
      list.push({
        id: `nav-${item.to}`,
        group: tr('跳转'),
        label: item.label,
        icon: item.icon,
        keywords: item.to,
        run: go(projectPath(projectId, item.to)),
      });
    }
    list.push(
      {
        id: 'new-session',
        group: tr('操作'),
        label: tr('新建个人会话'),
        hint: tr('在我的工作区里单独和 agent 聊'),
        icon: Plus,
        keywords: tr('workspace session 工作区'),
        run: go(`${projectPath(projectId, 'workspace')}?new=1`),
      },
      {
        id: 'invite',
        group: tr('操作'),
        label: tr('邀请成员'),
        icon: UserPlus,
        keywords: tr('invite 成员 导师'),
        run: go(`${projectPath(projectId, 'settings')}?tab=invites`),
      },
      {
        id: 'theme',
        group: tr('操作'),
        label: resolvedTheme === 'dark' ? tr('切换到浅色') : tr('切换到深色'),
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        keywords: tr('theme dark light 主题 暗色'),
        run: () => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          onClose();
        },
      },
      {
        id: 'new-project',
        group: tr('操作'),
        label: tr('新建课题'),
        icon: FolderKanban,
        keywords: tr('project 项目'),
        run: go('/new'),
      },
      {
        id: 'logout',
        group: tr('操作'),
        label: tr('退出登录'),
        icon: LogOut,
        keywords: 'logout',
        run: () => {
          onClose();
          logout.mutate();
        },
      },
    );
    list.push(...helpPaletteCommands(projectId, go));
    const links: [string, PaletteLink[]][] = [
      [SETTINGS_GROUP, settingsLinks()],
      [
        HARNESS_GROUP,
        harnessLinks({
          skills: harness.data?.skills,
          commands: harness.data?.commands,
          profiles: harness.data?.profiles,
          mcpServers: mcp.data,
        }),
      ],
    ];
    for (const [group, items] of links) {
      for (const link of items) {
        list.push({
          id: link.id,
          group,
          label: link.label,
          ...(link.hint ? { hint: link.hint } : {}),
          icon: LINK_ICON[link.kind],
          keywords: link.keywords,
          searchOnly: true,
          run: go(projectPath(projectId, link.to)),
        });
      }
    }
    for (const t of threads.data ?? []) {
      list.push({
        id: `thread-${t.id}`,
        group: tr('线程'),
        label: t.title,
        hint: t.label ?? undefined,
        leading: <StatusDot status={t.statusBucket} />,
        run: go(projectPath(projectId, `threads/${t.id}`)),
      });
    }
    for (const d of docs.hits) {
      // 服务端可能返回前端还不认识的新类型：按普通文档展示
      const kind = DOC_KIND_META[d.kind] as DocKindMeta | undefined;
      list.push({
        id: `doc-${d.id}`,
        group: tr('文档'),
        label: d.title || tr('未命名文档'),
        hint: d.snippet || kind?.label,
        icon: kind?.icon ?? FileText,
        remote: true,
        run: go(projectPath(projectId, `docs/${d.id}`)),
      });
    }
    if (q.slice(0, 200) === researchQuery) {
      for (const hit of research.data?.items ?? []) {
        list.push({
          id: `research-${hit.kind}-${hit.id}`,
          group:
            hit.kind === 'source'
              ? tr('研究资料')
              : hit.kind === 'finding'
                ? tr('研究结论')
                : tr('研究空间'),
          label: hit.title,
          hint: hit.snippet || undefined,
          icon:
            hit.kind === 'source' ? BookMarked : hit.kind === 'finding' ? Lightbulb : Microscope,
          remote: true,
          run: go(
            projectPath(
              projectId,
              hit.kind === 'source'
                ? `research-sources/${hit.id}`
                : hit.kind === 'finding'
                  ? `research-findings/${hit.id}`
                  : hit.kind === 'item'
                    ? `research/${hit.recordId}?item=${encodeURIComponent(hit.id)}`
                    : `research/${hit.id}`,
            ),
          ),
        });
      }
    }
    // 成员：选中后打开设置里的「成员」分区（那里能看角色、改权限）
    for (const m of filterMembers(members.data ?? [], q)) {
      list.push({
        id: `member-${m.user.id}`,
        group: tr('成员'),
        label: m.user.name,
        hint: `${ROLE_LABEL[m.role]} · ${m.user.email}`,
        leading: <Avatar name={m.user.name} color={m.user.avatarColor} size={20} aria-hidden />,
        remote: true,
        run: go(`${projectPath(projectId, 'settings')}?tab=members`),
      });
    }
    for (const t of personal.data ?? []) {
      list.push({
        id: `personal-${t.id}`,
        group: tr('我的会话'),
        label: t.title,
        leading: <StatusDot status={t.statusBucket} />,
        run: go(`${projectPath(projectId, 'workspace')}/${t.id}`),
      });
    }
    for (const p of me.data?.projects ?? []) {
      if (p.id === projectId) continue;
      list.push({
        id: `project-${p.id}`,
        group: tr('切换课题'),
        label: p.name,
        leading: <span aria-hidden>{p.icon}</span>,
        run: go(`/p/${p.id}`),
      });
    }
    return list;
  }, [
    projectId,
    navigate,
    onClose,
    threads.data,
    personal.data,
    docs.hits,
    research.data,
    researchQuery,
    harness.data,
    mcp.data,
    members.data,
    q,
    me.data,
    logout,
    resolvedTheme,
    setTheme,
  ]);

  const filtered = useMemo(() => {
    const out = commands
      .filter((c) => matches(c, q))
      .map((c, i) => ({ c, i }))
      .sort((a, b) => groupRank(a.c.group) - groupRank(b.c.group) || a.i - b.i)
      .map(({ c }) => c);
    // 没输入时线程只显示最近 6 个，避免列表太长
    if (!q) {
      let n = 0;
      return out.filter((c) => c.group !== '线程' || n++ < 6);
    }
    return out;
  }, [commands, q]);

  const groups = useMemo(() => {
    const result: { name: string; items: { cmd: Command; index: number }[] }[] = [];
    filtered.forEach((cmd, index) => {
      const last = result[result.length - 1];
      if (last && last.name === cmd.group) last.items.push({ cmd, index });
      else result.push({ name: cmd.group, items: [{ cmd, index }] });
    });
    return result;
  }, [filtered]);

  const index = Math.min(active, Math.max(0, filtered.length - 1));

  const scrollTo = (i: number) => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${i}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = (index + 1) % Math.max(1, filtered.length);
      setActive(i);
      scrollTo(i);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = (index - 1 + filtered.length) % Math.max(1, filtered.length);
      setActive(i);
      scrollTo(i);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[index]?.run();
    } else if (e.key === 'Escape') {
      // 焦点在输入框时就地关闭，不依赖 Dialog 的面板 / 全局监听（之前第一下 Esc 偶尔关不上）
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="flex max-h-[inherit] flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-subtle" />
        <input
          data-autofocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={tr('搜索页面、线程、文档、研究、成员…')}
          aria-label={tr('搜索命令')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={filtered[index] ? `palette-${filtered[index].id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent text-prose text-fg placeholder:text-fg-subtle focus-visible:outline-none"
        />
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
      </div>
      <div
        ref={listRef}
        id="palette-list"
        role="listbox"
        aria-label={tr('命令')}
        aria-busy={docs.searching || undefined}
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {filtered.length === 0 && (
          <p className="px-3 py-10 text-center text-small text-fg-subtle">
            {docs.searching
              ? tr('正在搜索文档…')
              : tr('没有找到和「{query}」相关的内容', { query })}
          </p>
        )}
        {groups.map((group, gi) => (
          <div key={group.name} role="group" aria-labelledby={`palette-group-${gi}`}>
            <div
              id={`palette-group-${gi}`}
              role="presentation"
              className="px-2.5 pt-2.5 pb-1 text-caption text-fg-subtle"
            >
              {group.name}
            </div>
            {group.items.map(({ cmd, index: i }) => {
              const Icon = cmd.icon;
              const selected = i === index;
              return (
                <div
                  key={cmd.id}
                  id={`palette-${cmd.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  onPointerMove={() => setActive(i)}
                  onClick={() => cmd.run()}
                  className={cn(
                    'relative flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-body select-none',
                    selected ? 'text-fg' : 'text-fg-muted',
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="palette-active"
                      transition={spring.snappy}
                      aria-hidden
                      className="absolute inset-0 rounded-md bg-subtle"
                    />
                  )}
                  <span className="relative flex w-4 shrink-0 justify-center">
                    {Icon ? <Icon size={16} strokeWidth={1.75} aria-hidden /> : cmd.leading}
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="relative hidden max-w-[45%] truncate text-caption font-normal text-fg-subtle sm:block">
                      {cmd.hint}
                    </span>
                  )}
                  {selected && (
                    <CornerDownLeft
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden
                      className="relative shrink-0 text-fg-subtle"
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {filtered.length > 0 && docs.searching && !groups.some((g) => g.name === '文档') && (
        <p role="status" className="px-4 pb-2 text-caption font-normal text-fg-subtle">
          {tr('正在搜索文档…')}
        </p>
      )}
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-caption font-normal text-fg-subtle">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {tr('选择')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {tr('打开')}
        </span>
        <span className="ml-auto hidden sm:inline">
          <Kbd>G</Kbd>
          {tr(' 然后 ')}
          <Kbd>T</Kbd>
          {tr(' 回协作台')}
        </span>
      </div>
    </div>
  );
}
