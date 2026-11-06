/**
 * 文本小工具：字数统计、链接规整、快捷键显示。纯函数，便于单测。
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu;

/** 字数：中日韩文字按字计，其他按词计（"研协 AI 平台 v2.0" = 4 + 2 = 6）。 */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ');
  const words = rest.match(WORD)?.length ?? 0;
  return cjk + words;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(https?|mailto|tel):/i;

/**
 * 把用户输入的链接规整成可用的 href；不安全（javascript: 等）或空的返回 null。
 * "example.com" → "https://example.com"；"#标题"、"/path" 原样保留。
 */
export function normalizeHref(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith('#') || raw.startsWith('/')) return raw;
  if (SCHEME.test(raw)) return SAFE_SCHEME.test(raw) ? raw : null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
  if (/\s/.test(raw)) return null;
  return `https://${raw}`;
}

export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** "Mod-Shift-x" → "⌘⇧X"（Mac）/ "Ctrl+Shift+X"（其他） */
export function shortcutLabel(spec: string, mac = isMacLike()): string {
  const parts = spec.split('-');
  const key = parts.pop() ?? '';
  const mods = parts.map((p) => {
    if (p === 'Mod') return mac ? '⌘' : 'Ctrl';
    if (p === 'Shift') return mac ? '⇧' : 'Shift';
    if (p === 'Alt') return mac ? '⌥' : 'Alt';
    return p;
  });
  const k = key.length === 1 ? key.toUpperCase() : key;
  return mac ? [...mods, k].join('') : [...mods, k].join('+');
}
