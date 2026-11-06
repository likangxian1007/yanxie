import type { HarnessScope, McpTransport, ThinkingFormat, WritableScope } from '@srh/shared';
import { canManage, canWrite, useMyRole } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { tr } from '@/lib/i18n';

/**
 * harness 设置的权限：项目作用域要负责人 / 导师；个人作用域任何成员都能写（只对自己生效）。
 * 内置项只读，可以复制成项目或个人的同名项来覆盖。
 */
export interface HarnessPerm {
  /** 能管理项目作用域（owner / advisor） */
  manage: boolean;
  /** 能写个人作用域（访客不行） */
  personal: boolean;
  meId: string | null;
  /** 新建时可选的作用域 */
  scopes: WritableScope[];
  canEdit: (item: { scope: HarnessScope; ownerUserId: string | null }) => boolean;
}

export function useHarnessPerm(pid: string): HarnessPerm {
  const role = useMyRole(pid);
  const me = useMeUser();
  const manage = canManage(role);
  const personal = canWrite(role);
  const meId = me?.id ?? null;
  const scopes: WritableScope[] = [
    ...(manage ? (['project'] as const) : []),
    ...(personal ? (['personal'] as const) : []),
  ];
  return {
    manage,
    personal,
    meId,
    scopes,
    canEdit: (item) => {
      if (item.scope === 'builtin') return false;
      if (item.scope === 'project') return manage;
      return personal && (item.ownerUserId === null || item.ownerUserId === meId);
    },
  };
}

export const SCOPE_LABEL: Record<HarnessScope, string> = {
  builtin: tr('内置'),
  project: tr('项目'),
  personal: tr('个人'),
};

export const SCOPE_HINT: Record<WritableScope, string> = {
  project: tr('项目里所有人的 agent 都能用'),
  personal: tr('只对你自己的个人会话生效，别人看不到'),
};

export const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'HTTP',
  sse: tr('SSE（旧版）'),
};

export const THINKING_FORMAT_LABEL: Record<ThinkingFormat, string> = {
  deepseek: 'DeepSeek',
  openai: tr('OpenAI 兼容'),
  none: tr('不支持推理'),
  openrouter: 'OpenRouter',
};

/** 每行一个，去掉空行和首尾空白 */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 逗号 / 空白分隔的列表 */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,，、]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const SLUG_HINT = tr('只能用小写字母、数字和连字符，最长 40 位');

export function validateSlug(slug: string): string | null {
  if (!slug.trim()) return tr('请填写名字');
  return SLUG_RE.test(slug.trim()) ? null : SLUG_HINT;
}

export interface KeyValueRow {
  key: string;
  value: string;
  /** 服务端已经存着的键（值不回显，留空 = 保留原值） */
  existing: boolean;
}

export const KV_KEY_RE = /^[\w.-]{1,80}$/u;

/** 编辑行 → 提交用的对象；键重复或不合法时返回错误说明 */
export function rowsToRecord(rows: KeyValueRow[]): {
  value: Record<string, string>;
  error: string | null;
} {
  const value: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k && !r.value) continue;
    if (!KV_KEY_RE.test(k))
      return { value, error: tr('「{value}」不是合法的键名', { value: k || tr('（空）') }) };
    if (k in value) return { value, error: tr('键「{k}」重复了', { k }) };
    value[k] = r.value;
  }
  return { value, error: null };
}
