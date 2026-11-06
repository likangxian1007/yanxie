import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AgentProfile, DocumentSearchHit, ProjectMember, Skill } from '@srh/shared';
import { ck } from '@/features/collab-kit/keys';
import { SETTINGS_TAB_LABEL, SETTINGS_TABS, type SettingsTab } from '@/features/settings/lib';
import { api } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/project';
import { tr } from '@/lib/i18n';

/**
 * 命令面板的远程 / 衍生数据源：文档搜索（防抖 + 出错时静默为空）与成员筛选。
 * 组件放在 CommandPalette.tsx，这里只放 hook 与纯函数（react-refresh 要求分文件）。
 */

/** 远程文档搜索的防抖时长 */
export const DOC_SEARCH_DEBOUNCE_MS = 200;
/** 成员最多展示几位，避免把面板撑满 */
export const MEMBER_LIMIT = 6;

/** 值停止变化 `ms` 毫秒后才更新（setState 在定时器回调里，不在 effect 体里同步调用）。 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** 文档搜索的查询键：挂在 ['p', pid, 'docs'] 下，文档事件失效时一起刷新。 */
export function docSearchKey(pid: string, q: string) {
  return [...ck.docs(pid), 'search', q] as const;
}

/**
 * GET P/docs/search?q=。接口不存在（404）、无权限或网络错误时返回空列表：
 * 命令面板里只是少一组结果，不应该弹错误。被取消的请求照常抛出，交给 TanStack Query。
 */
export async function fetchDocHits(
  pid: string,
  q: string,
  signal?: AbortSignal,
): Promise<DocumentSearchHit[]> {
  try {
    const hits = await api.get<DocumentSearchHit[]>(`/projects/${pid}/docs/search`, {
      ...(signal ? { signal } : {}),
      query: { q },
    });
    return Array.isArray(hits) ? hits : [];
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

export interface DocSearchState {
  hits: DocumentSearchHit[];
  /** 输入后还在等防抖或请求 */
  searching: boolean;
}

/** 防抖后的远程文档搜索；`query` 为空时不请求。 */
export function useDocSearch(pid: string, query: string): DocSearchState {
  const q = query.trim().slice(0, 200);
  const debounced = useDebouncedValue(q, DOC_SEARCH_DEBOUNCE_MS);
  const enabled = Boolean(pid && debounced);
  const result = useQuery({
    queryKey: docSearchKey(pid, debounced),
    queryFn: ({ signal }) => fetchDocHits(pid, debounced, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  if (!q) return { hits: [], searching: false };
  return {
    hits: enabled ? (result.data ?? []) : [],
    searching: q !== debounced || result.isFetching,
  };
}

/** 成员是否匹配搜索词（名字、邮箱、角色；空格分隔的每个词都要命中）。 */
export function memberMatches(member: ProjectMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const hay = `${member.user.name} ${member.user.email} ${ROLE_LABEL[member.role]}`.toLowerCase();
  return q
    .split(/\s+/u)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

/** 匹配的成员（最多 MEMBER_LIMIT 位）。没有输入时不列成员。 */
export function filterMembers(members: readonly ProjectMember[], query: string): ProjectMember[] {
  return members.filter((m) => memberMatches(m, query)).slice(0, MEMBER_LIMIT);
}

// ---------------------------------------------------------------- 设置分区与 agent 配置

/** 命令面板里的一条「跳到某处」（图标由组件按 kind 决定） */
export interface PaletteLink {
  id: string;
  kind: 'settings' | 'skill' | 'command' | 'mcp' | 'profile';
  label: string;
  hint?: string;
  keywords: string;
  /** 相对项目根的路径（含查询串） */
  to: string;
}

/** 设置分区的别名：用户常搜的说法（「定时」「记忆」「LLM」……） */
const SETTINGS_KEYWORDS: Record<SettingsTab, string> = {
  general: tr('project general 项目信息 名称 简介 可见性 归档'),
  members: tr('members 成员 角色 权限'),
  invites: tr('invite 邀请 链接 导师'),
  instructions: tr('instructions 指令 协调者 提示词 prompt'),
  memory: tr('memory 记忆 项目记忆'),
  routines: tr('routines cron schedule 定时 计划任务 周报'),
  versioning: tr('version git github 版本 提案 改动提案 直接写入 仓库 PR'),
  models: tr('models llm provider 模型 推理强度 api key 服务商'),
  mcp: tr('mcp server 工具 tools 服务器'),
  skills: tr('skill skills 技能'),
  commands: tr('commands slash 斜杠 指令 快捷指令 自定义指令'),
  'agent-profiles': tr('profile profiles 角色 agent'),
  profile: tr('profile me theme 个人 外观 主题 头像 名字'),
  integrations: tr('integrations token api token 接入 令牌 门禁卡 agent dots'),
  notify: tr('notify notification webhook 通知 飞书 企业微信 钉钉 群机器人'),
};

const settingsTo = (tab: SettingsTab) => `settings?tab=${tab}`;

/** 每个设置分区一条（静态）。 */
export function settingsLinks(): PaletteLink[] {
  return SETTINGS_TABS.map((tab) => ({
    id: `settings-${tab}`,
    kind: 'settings',
    label: tr('设置 · {value}', { value: SETTINGS_TAB_LABEL[tab] }),
    keywords: tr('设置 settings {tab} {value}', { tab, value: SETTINGS_KEYWORDS[tab] }),
    to: settingsTo(tab),
  }));
}

const SCOPE_LABEL: Record<string, string> = {
  builtin: tr('内置'),
  project: tr('项目'),
  personal: tr('个人'),
};

type Described = { id: string; name: string; description: string; scope: string };

export interface HarnessSources {
  skills?: readonly (Described & Pick<Skill, 'slug'>)[] | undefined;
  commands?: readonly Described[] | undefined;
  mcpServers?: readonly Described[] | undefined;
  profiles?: readonly (Described & Pick<AgentProfile, 'slug'>)[] | undefined;
}

function hintOf(kind: string, scope: string, description: string): string {
  return [`${SCOPE_LABEL[scope] ?? ''}${kind}`, description.trim()].filter(Boolean).join(' · ');
}

/**
 * Skill、自定义斜杠指令、MCP 服务器、Profile：选中后打开设置里对应的分区。
 * 内置斜杠指令（/stop 之类）不是「地方」，不列。
 */
export function harnessLinks(src: HarnessSources): PaletteLink[] {
  const out: PaletteLink[] = [];
  // 接口形状不对（老后端、无权限时的兜底响应）就当没有
  const list = <T>(v: readonly T[] | undefined): readonly T[] => (Array.isArray(v) ? v : []);
  for (const s of list(src.skills)) {
    out.push({
      id: `skill-${s.id}`,
      kind: 'skill',
      label: s.name || s.slug,
      hint: hintOf(' Skill', s.scope, s.description),
      keywords: tr('skill 技能 /{slug} {slug2} {description}', {
        slug: s.slug,
        slug2: s.slug,
        description: s.description,
      }),
      to: settingsTo('skills'),
    });
  }
  for (const c of list(src.commands)) {
    if (c.scope === 'builtin') continue;
    out.push({
      id: `command-${c.id}`,
      kind: 'command',
      label: `/${c.name}`,
      hint: hintOf(tr('指令'), c.scope, c.description),
      keywords: tr('command 指令 斜杠 自定义指令 {name} {description}', {
        name: c.name,
        description: c.description,
      }),
      to: settingsTo('commands'),
    });
  }
  for (const m of list(src.mcpServers)) {
    out.push({
      id: `mcp-${m.id}`,
      kind: 'mcp',
      label: m.name,
      hint: hintOf(' MCP', m.scope, m.description),
      keywords: tr('mcp server 工具 {name} {description}', {
        name: m.name,
        description: m.description,
      }),
      to: settingsTo('mcp'),
    });
  }
  for (const p of list(src.profiles)) {
    out.push({
      id: `profile-${p.id}`,
      kind: 'profile',
      label: p.name || p.slug,
      hint: hintOf(' Profile', p.scope, p.description),
      keywords: tr('profile 角色 {slug} {description}', {
        slug: p.slug,
        description: p.description,
      }),
      to: settingsTo('agent-profiles'),
    });
  }
  return out;
}
