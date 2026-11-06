import {
  BUILTIN_COMMAND_NAMES,
  type CommandKind,
  type Skill,
  type SlashCommand,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/**
 * 输入框斜杠指令的纯逻辑（DSH 风格，见 dsh-digest §3）：
 * - 输入框以 “/” 开头、还没敲空格时弹出菜单（之后的内容是参数）
 * - 菜单顺序：内置指令 → 可点名的 skill（/slug）→ 自定义指令；按前缀 / 子串过滤
 * - 发送时解析整行：client 类前端执行，session 类调 commands/run，prompt 类原样当消息发
 */

export type SlashGroup = 'builtin' | 'skill' | 'custom';

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  builtin: tr('指令'),
  skill: 'Skill',
  custom: tr('自定义'),
};

export interface SlashItem {
  /** 不带斜杠 */
  name: string;
  description: string;
  argumentHint: string;
  kind: CommandKind;
  group: SlashGroup;
  /** skill 的显示名（与 name 不同时显示） */
  label?: string;
}

export interface SlashContext {
  /** 已有 agent 会话：切模型、clear、compact、stop 这些才有意义 */
  hasSession: boolean;
  /** 个人会话：/forward 可用 */
  personal: boolean;
}

/** 前端实现了的 client 指令；服务端将来多出来的 client 指令先不显示 */
const CLIENT_COMMANDS = new Set(['help', 'model', 'effort', 'profile', 'forward', 'stop']);

const BUILTIN_SET = new Set<string>(BUILTIN_COMMAND_NAMES);

export function isBuiltinName(name: string): boolean {
  return BUILTIN_SET.has(name);
}

/** 内置指令在当前上下文里能不能用。 */
export function builtinAvailable(cmd: Pick<SlashCommand, 'name' | 'kind'>, ctx: SlashContext) {
  if (cmd.kind === 'client') {
    if (!CLIENT_COMMANDS.has(cmd.name)) return false;
    if (cmd.name === 'help') return true;
    if (cmd.name === 'forward') return ctx.hasSession && ctx.personal;
    return ctx.hasSession;
  }
  if (cmd.kind === 'session') return ctx.hasSession;
  return true;
}

/** 组装菜单项：内置 → skill → 自定义；同名时指令优先于 skill。 */
export function buildSlashItems(
  data: { commands: SlashCommand[]; skills: Skill[] } | null | undefined,
  ctx: SlashContext,
): SlashItem[] {
  if (!data) return [];
  const builtins: SlashItem[] = [];
  const customs: SlashItem[] = [];
  const taken = new Set<string>();
  for (const c of data.commands) {
    if (taken.has(c.name)) continue;
    const builtin = c.scope === 'builtin' || isBuiltinName(c.name);
    if (builtin) {
      taken.add(c.name);
      if (!builtinAvailable(c, ctx)) continue;
      builtins.push({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        kind: c.kind,
        group: 'builtin',
      });
    } else {
      taken.add(c.name);
      customs.push({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        kind: 'prompt',
        group: 'custom',
      });
    }
  }
  const skills: SlashItem[] = [];
  for (const s of data.skills) {
    if (!s.enabled || !s.userInvocable || taken.has(s.slug)) continue;
    taken.add(s.slug);
    skills.push({
      name: s.slug,
      description: s.description,
      argumentHint: '',
      kind: 'prompt',
      group: 'skill',
      ...(s.name && s.name !== s.slug ? { label: s.name } : {}),
    });
  }
  return [...builtins, ...skills, ...customs];
}

/** 输入框处于「正在输入指令名」状态时返回已输入的部分（不含斜杠），否则 null。 */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/u.exec(value);
  return m ? (m[1] ?? '') : null;
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

function score(item: SlashItem, q: string): number {
  const name = item.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (item.label?.toLowerCase().includes(q)) return 2;
  if (isSubsequence(q, name)) return 3;
  if (item.description.toLowerCase().includes(q)) return 4;
  return -1;
}

/** 过滤并排序：前缀 → 名字包含 → 显示名包含 → 名字子序列 → 描述包含；同档保持原顺序。 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .map((item, i) => ({ item, i, s: score(item, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.item);
}

export interface ParsedSlash {
  name: string;
  args: string;
}

/** 解析一整行 “/name 参数”；名字后必须是空白或结尾（/usr/bin、5/8 不算指令）。 */
export function parseSlashLine(text: string): ParsedSlash | null {
  const m = /^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!m) return null;
  return { name: (m[1] ?? '').toLowerCase(), args: (m[2] ?? '').trim() };
}

export type SlashAction =
  | { type: 'send' }
  | { type: 'client'; name: string; args: string }
  | { type: 'session'; name: string; args: string }
  | { type: 'unavailable'; name: string };

/**
 * 发送一整行之前判断该怎么处理：
 * - 不是指令、未知指令、prompt 类（goal、plan、skill、/skill-slug、自定义）→ 当普通消息发
 * - client → 前端执行；session（clear、compact、/goal clear）→ commands/run
 * - 内置指令但当前上下文不能用 → unavailable（提示一下，保留草稿）
 */
export function resolveSlash(text: string, items: SlashItem[], ctx: SlashContext): SlashAction {
  const parsed = parseSlashLine(text);
  if (!parsed) return { type: 'send' };
  const { name, args } = parsed;
  if (name === 'goal' && args.toLowerCase() === 'clear') {
    return ctx.hasSession
      ? { type: 'session', name, args: 'clear' }
      : { type: 'unavailable', name };
  }
  const item = items.find((i) => i.name === name);
  if (!item) return isBuiltinName(name) ? { type: 'unavailable', name } : { type: 'send' };
  if (item.kind === 'client') return { type: 'client', name, args };
  if (item.kind === 'session') return { type: 'session', name, args };
  return { type: 'send' };
}

/** 菜单里选中一项：prompt 类插入 “/name ” 等用户写参数；其余直接执行。 */
export function pickBehavior(item: SlashItem): 'insert' | 'execute' {
  return item.kind === 'prompt' ? 'insert' : 'execute';
}

export function slashOptionId(listId: string, index: number) {
  return `${listId}-opt-${index}`;
}

/** 菜单的选中项：query 变了就回到第一项（不用 effect 重置）。 */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
