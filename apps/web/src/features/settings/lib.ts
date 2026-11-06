import type { MemoryFile, MemoryType, ProjectRole, ProjectVisibility, Thread } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import { absoluteUrl } from '@/lib/base-path';
import { formatFullTimeZh } from '@/lib/time';
import { tr } from '@/lib/i18n';

/** 设置页的分区（URL ?tab=）。其他页面会链接 ?tab=memory / ?tab=members。 */
export const SETTINGS_TABS = [
  'general',
  'members',
  'invites',
  'instructions',
  'memory',
  'routines',
  'versioning',
  'models',
  'mcp',
  'skills',
  'commands',
  'agent-profiles',
  'profile',
  'integrations',
  'notify',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  general: tr('项目信息'),
  members: tr('成员'),
  invites: tr('邀请'),
  instructions: tr('协调者指令'),
  memory: tr('项目记忆'),
  routines: tr('定时任务'),
  versioning: tr('版本与提案'),
  models: tr('模型'),
  mcp: tr('MCP 连接'),
  skills: tr('技能'),
  commands: tr('快捷指令'),
  'agent-profiles': tr('角色配置'),
  profile: tr('个人与外观'),
  integrations: tr('接入'),
  notify: tr('通知'),
};

export function parseSettingsTab(value: string | null): SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value ?? '')
    ? (value as SettingsTab)
    : 'general';
}

export const READ_ONLY_HINT = tr('只有负责人和导师可以修改');

export const VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  private: tr('仅受邀成员'),
  team: tr('团队可见'),
};

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: tr('成员偏好'),
  feedback: tr('反馈与纠正'),
  project: tr('项目背景'),
  reference: tr('参考资料'),
};

/** Select 用的类型选项；空字符串 = 未分类（null）。 */
export const MEMORY_TYPE_OPTIONS: { value: '' | MemoryType; label: string }[] = [
  { value: '', label: tr('未分类') },
  ...(Object.keys(MEMORY_TYPE_LABEL) as MemoryType[]).map((t) => ({
    value: t,
    label: MEMORY_TYPE_LABEL[t],
  })),
];

export function parseMemoryType(value: string): MemoryType | null {
  return value in MEMORY_TYPE_LABEL ? (value as MemoryType) : null;
}

export const MEMORY_MAX = 16_000;

/** 可以发出邀请的角色（负责人不能通过邀请产生）。 */
export const INVITE_ROLES = [
  'member',
  'advisor',
  'guest',
] as const satisfies readonly ProjectRole[];
export type InviteRole = (typeof INVITE_ROLES)[number];

/** 给用户看的中文错误文案。ApiRequestError.message 已经是中文。 */
export function errorMessage(err: unknown, fallback = tr('出了点问题，请稍后再试。')): string {
  if (err instanceof ApiRequestError) return err.message;
  return fallback;
}

/** 409 version_conflict 时取出服务端最新的记忆文件（details.current）。 */
export function memoryConflict(err: unknown): MemoryFile | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'version_conflict') return null;
  const current = err.details?.current;
  if (current && typeof current === 'object' && 'path' in current && 'version' in current) {
    return current as MemoryFile;
  }
  return null;
}

/** 记忆文件路径可能带子目录：逐段编码，保留斜杠。 */
export function memoryFileUrl(pid: string, path: string): string {
  return `/projects/${pid}/memory/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export const MEMORY_PATH_RE = /^[\w\-./]+\.md$/u;

export function validateMemoryPath(path: string): string | null {
  const p = path.trim();
  if (!p) return tr('请填写文件路径，例如 notes/experiments.md');
  if (!p.endsWith('.md')) return tr('路径须以 .md 结尾');
  if (!MEMORY_PATH_RE.test(p)) return tr('路径只能包含字母、数字、下划线、短横线、点和斜杠');
  if (p.startsWith('/') || p.includes('..')) return tr('请使用相对路径，不要以 / 开头或包含 ..');
  return null;
}

/** 邀请是否已过期（在渲染外调用 Date.now，避免组件里出现不纯调用）。 */
export function isExpired(iso: string): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t < Date.now();
}

/**
 * 未来时间的中文相对说明（shared 的 relativeTimeZh 只处理过去时间）：
 * 1 分钟内 / 25 分钟后 / 3 小时后 / 明天 09:00 / 5 天后 / 11月2日 09:00。
 * 已经过去的时间返回 null，由调用方改用 RelativeTime。
 */
export function relativeFutureZh(iso: string, now: Date): string | null {
  const t = new Date(iso);
  const diff = Math.round((t.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (diff < 60) return tr('1 分钟内');
  if (diff < 3600) return tr('{Math} 分钟后', { Math: Math.round(diff / 60) });
  if (diff < 6 * 3600) return tr('{Math} 小时后', { Math: Math.round(diff / 3600) });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (t.toDateString() === now.toDateString()) return tr('今天 {hhmm}', { hhmm });
  if (t.toDateString() === tomorrow.toDateString()) return tr('明天 {hhmm}', { hhmm });
  if (diff < 7 * 86_400) return tr('{Math} 天后', { Math: Math.ceil(diff / 86_400) });
  const sameYear = t.getFullYear() === now.getFullYear();
  return sameYear
    ? tr('{value}月{t}日 {hhmm}', { value: t.getMonth() + 1, t: t.getDate(), hhmm })
    : tr('{t}年{value}月{t2}日', { t: t.getFullYear(), value: t.getMonth() + 1, t2: t.getDate() });
}

export function inviteLink(token: string): string {
  return absoluteUrl(`/invite/${token}`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

// ---------------------------------------------------------------- 定时任务的时间表

function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, tr('天')],
    [3_600_000, tr('小时')],
    [60_000, tr('分钟')],
    [1000, tr('秒')],
  ];
  for (const [size, label] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${label}`;
  }
  if (ms >= 60_000) return tr('{Math} 分钟', { Math: Math.round(ms / 60_000) });
  return tr('{ms} 毫秒', { ms });
}

/** 校验时间表写法；合法返回 null，否则返回中文说明。 */
export function validateSchedule(raw: string): string | null {
  const s = raw.trim();
  if (!s) return tr('请填写时间表');
  if (s.length > 100) return tr('时间表最多 100 个字符');
  if (s.startsWith('every:')) {
    const ms = Number(s.slice(6));
    if (!Number.isInteger(ms) || ms < 60_000)
      return tr('every: 后面填毫秒数，且至少 60000（1 分钟）');
    return null;
  }
  if (s.startsWith('at:')) {
    const t = new Date(s.slice(3)).getTime();
    if (!Number.isFinite(t)) return tr('at: 后面填 ISO 时间，例如 at:2026-11-01T09:00:00+08:00');
    return null;
  }
  const parts = s.split(/\s+/u);
  if (parts.length !== 5 || !parts.every((p) => /^[\d*,/-]+$/u.test(p))) {
    return tr('cron 表达式需要 5 段（分 时 日 月 周），例如 0 9 * * 1-5');
  }
  return null;
}

// ---------------------------------------------------------------- 定时任务的唤醒对象

/** Select 里代表“唤醒协调者”（targetThreadId = null）的值 */
export const ROUTINE_TARGET_COORDINATOR = '';

type ThreadLite = Pick<Thread, 'id' | 'title' | 'resolved'>;

/** 线程在下拉框 / 列表里显示的名字 */
function threadName(t: ThreadLite): string {
  return t.title.trim() || tr('未命名线程');
}

/**
 * “唤醒对象”下拉框的选项：第一项是协调者（默认），之后是未解决的项目线程。
 * 编辑时如果原本指向一个已解决 / 列表里找不到的线程，也保留这一项，免得保存时悄悄改掉。
 */
export function routineTargetOptions(
  threads: readonly ThreadLite[] | undefined,
  current: string,
  loading: boolean,
): { value: string; label: string }[] {
  const options = [{ value: ROUTINE_TARGET_COORDINATOR, label: tr('协调者（默认）') }];
  for (const t of threads ?? []) {
    if (t.resolved && t.id !== current) continue;
    options.push({ value: t.id, label: `${threadName(t)}${t.resolved ? tr('（已解决）') : ''}` });
  }
  if (current !== ROUTINE_TARGET_COORDINATOR && !options.some((o) => o.value === current)) {
    options.push({
      value: current,
      label: loading ? tr('正在加载线程…') : tr('原来的线程（已找不到）'),
    });
  }
  return options;
}

/** 列表里的唤醒对象说明：唤醒：协调者 / 唤醒线程：标题 / 唤醒线程 */
export function describeRoutineTarget(
  targetThreadId: string | null,
  threads: readonly ThreadLite[] | undefined,
): string {
  if (targetThreadId === null) return tr('唤醒：协调者');
  const t = threads?.find((x) => x.id === targetThreadId);
  return t ? tr('唤醒线程：{value}', { value: threadName(t) }) : tr('唤醒线程');
}

/** 时间表的中文说明（尽力而为，看不懂的 cron 原样显示）。 */
export function describeSchedule(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('every:')) {
    const ms = Number(s.slice(6));
    return Number.isFinite(ms) && ms > 0 ? tr('每隔 {value}', { value: formatDuration(ms) }) : s;
  }
  if (s.startsWith('at:')) {
    const full = formatFullTimeZh(s.slice(3));
    return full ? tr('在 {full} 运行一次', { full }) : s;
  }
  const parts = s.split(/\s+/u);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
    if (/^\d+$/u.test(min) && /^\d+$/u.test(hour) && dom === '*' && mon === '*') {
      const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      if (dow === '*') return tr('每天 {time}', { time });
      if (dow === '1-5') return tr('工作日 {time}', { time });
      if (dow === '0,6' || dow === '6,0') return tr('周末 {time}', { time });
    }
    if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
      return tr('每小时整点');
  }
  return tr('cron：{s}', { s });
}
