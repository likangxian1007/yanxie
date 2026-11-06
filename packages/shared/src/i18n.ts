/**
 * 界面语言（中 / 英）。
 *
 * 约定：中文原文就是词条的 key，`tr('重试')` 在中文界面原样返回，在英文界面查英文词典；
 * 词典里没有的词条回退成中文原文，所以漏翻只会显示中文，不会影响功能。
 * 带变量的文案用命名占位符：`tr('移除附件 {name}', { name })`。
 *
 * 语言在页面加载时确定（读 localStorage `srh-lang`，默认中文），切换语言会刷新页面，
 * 因此模块顶层的 `tr()` 也能拿到正确语言。这个文件不能引入任何其他模块：
 * 前端要在加载其余代码之前先装好词典。服务端从不切换语言，始终输出中文。
 */

export type UiLang = 'zh' | 'en';
export const LANG_STORAGE_KEY = 'srh-lang';

/** 英文词条：普通字符串，或按数量区分单复数 */
export type I18nEntry = string | { one: string; other: string };
export type I18nDict = Record<string, I18nEntry>;
export type TrArgs = Record<string, unknown>;

function detect(): UiLang {
  try {
    const v = (globalThis as { localStorage?: Storage }).localStorage?.getItem(LANG_STORAGE_KEY);
    return v === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let current: UiLang = detect();
const dict: I18nDict = {};
const serverDict: I18nDict = {};
let patterns: { re: RegExp; names: string[]; entry: I18nEntry }[] | null = null;

export function getLang(): UiLang {
  return current;
}

export function setLang(lang: UiLang): void {
  current = lang;
}

/** 前端用的 Intl 区域 */
export function locale(): string {
  return current === 'en' ? 'en-US' : 'zh-CN';
}

export function registerDict(entries: I18nDict): void {
  Object.assign(dict, entries);
}

/** 服务端发来的固定文案（错误提示、状态等）的英文；支持带占位符的模板匹配 */
export function registerServerDict(entries: I18nDict): void {
  Object.assign(serverDict, entries);
  patterns = null;
}

function countOf(args: TrArgs | undefined): number | undefined {
  if (!args) return undefined;
  for (const k of ['n', 'count']) if (typeof args[k] === 'number') return args[k];
  for (const v of Object.values(args)) if (typeof v === 'number') return v;
  return undefined;
}

function pick(entry: I18nEntry, args: TrArgs | undefined): string {
  if (typeof entry === 'string') return entry;
  return countOf(args) === 1 ? entry.one : entry.other;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, args: TrArgs | undefined): string {
  if (!args) return text;
  return text.replace(PLACEHOLDER, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : m,
  );
}

/** 翻译界面文案。中文界面返回原文（填好变量）；英文界面查词典，查不到用原文。 */
export function tr(key: string, args?: TrArgs): string {
  if (current === 'en') {
    const entry = dict[key] ?? serverDict[key];
    if (entry !== undefined) return fill(pick(entry, args), args);
  }
  return fill(key, args);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(): NonNullable<typeof patterns> {
  const out: NonNullable<typeof patterns> = [];
  for (const [key, entry] of Object.entries(serverDict)) {
    if (!key.includes('{')) continue;
    const names: string[] = [];
    let re = '';
    let last = 0;
    for (const m of key.matchAll(PLACEHOLDER)) {
      re += escapeRe(key.slice(last, m.index));
      re += '([\\s\\S]*?)';
      names.push(m[1]!);
      last = m.index! + m[0].length;
    }
    if (!names.length) continue;
    re += escapeRe(key.slice(last));
    out.push({ re: new RegExp(`^${re}$`), names, entry });
  }
  // 越长的模板越具体，先匹配
  out.sort((a, b) => b.re.source.length - a.re.source.length);
  return out;
}

/**
 * 翻译服务端发来的中文固定文案（错误提示等）。英文界面先精确查词典，再按模板匹配；
 * 都匹配不上就原样返回。模板里的变量（文件名、标题等）保持原样。
 */
export function trServer(message: string): string {
  if (current !== 'en' || !message) return message;
  const exact = serverDict[message] ?? dict[message];
  if (exact !== undefined) return pick(exact, undefined);
  patterns ??= compile();
  for (const p of patterns) {
    const m = p.re.exec(message);
    if (!m) continue;
    const args: TrArgs = {};
    p.names.forEach((n, i) => {
      const v = m[i + 1] ?? '';
      args[n] = /^\d+$/.test(v) ? Number(v) : v;
    });
    return fill(pick(p.entry, args), args);
  }
  return message;
}
