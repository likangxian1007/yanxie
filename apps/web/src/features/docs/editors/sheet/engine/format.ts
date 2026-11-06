import * as SSF from 'ssf';
import { isError, tidy, type CellValue } from './values';
import { tr } from '@/lib/i18n';

/**
 * 数字格式显示：用 SheetJS 的 SSF（Apache-2.0）按 Excel 格式代码渲染，
 * 与 Excel / 飞书看到的文字一致（含四舍五入、千分位、日期、科学计数、货币）。
 */

export interface FormatPreset {
  id: string;
  label: string;
  /** Excel 格式代码；general 为 undefined */
  code?: string;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: 'general', label: tr('常规') },
  { id: 'number', label: tr('数字'), code: '#,##0.00' },
  { id: 'integer', label: tr('整数'), code: '#,##0' },
  { id: 'percent', label: tr('百分比'), code: '0.00%' },
  { id: 'cny', label: tr('人民币'), code: '"¥"#,##0.00' },
  { id: 'usd', label: tr('美元'), code: '$#,##0.00' },
  { id: 'date', label: tr('日期'), code: 'yyyy-mm-dd' },
  { id: 'datetime', label: tr('日期时间'), code: 'yyyy-mm-dd hh:mm' },
  { id: 'time', label: tr('时间'), code: 'hh:mm:ss' },
  { id: 'scientific', label: tr('科学计数'), code: '0.00E+00' },
  { id: 'text', label: tr('文本'), code: '@' },
];

export function presetOf(code: string | undefined): FormatPreset | null {
  if (!code || code === 'General') return FORMAT_PRESETS[0] ?? null;
  return FORMAT_PRESETS.find((p) => p.code === code) ?? null;
}

/** 调整小数位：0.00 → 0.000 / 0.0；没有小数部分时加 .0 */
export function adjustDecimals(code: string | undefined, delta: 1 | -1): string {
  const base = !code || code === 'General' || code === '@' ? '0' : code;
  // 只改第一段（正数段）里第一个数字占位串
  const sections = base.split(';');
  const first = sections[0] ?? '0';
  const m = /([0#,]*0)(\.(0+))?/u.exec(first);
  if (!m) return base;
  const decimals = (m[3] ?? '').length + delta;
  const repl = decimals > 0 ? `${m[1]}.${'0'.repeat(decimals)}` : (m[1] ?? '0');
  sections[0] = first.slice(0, m.index) + repl + first.slice(m.index + m[0].length);
  return sections.join(';');
}

/**
 * SSF 不认格式代码里未加引号的非 ASCII 字符（中文区 Excel 常见的 ¥、年月日写法）：
 * 引号、[]、反斜杠转义之外的非 ASCII 连续字符加上引号。
 */
export function sanitizeCode(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      const stop = end < 0 ? code.length : end + 1;
      out += code.slice(i, stop);
      i = stop;
    } else if (ch === '[') {
      const end = code.indexOf(']', i + 1);
      const stop = end < 0 ? code.length : end + 1;
      out += code.slice(i, stop);
      i = stop;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      out += code.slice(i, i + 2);
      i += 2;
    } else if (ch.charCodeAt(0) > 127) {
      let j = i;
      while (j < code.length && code.charCodeAt(j) > 127) j += 1;
      out += `"${code.slice(i, j)}"`;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function ssfFormat(code: string, v: number | string): string {
  try {
    return SSF.format(code, v);
  } catch {
    return SSF.format(sanitizeCode(code), v);
  }
}

const cache = new Map<string, boolean>();
export function isDateFormat(code: string | undefined): boolean {
  if (!code || code === 'General' || code === '@') return false;
  const hit = cache.get(code);
  if (hit !== undefined) return hit;
  let r: boolean;
  try {
    r = SSF.is_date(sanitizeCode(code));
  } catch {
    r = false;
  }
  cache.set(code, r);
  return r;
}

/** General：最多 11 位有效数字（Excel 列宽足够时的显示），很大或很小用科学计数 */
function general(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    return n
      .toExponential(5)
      .replace(/\.?0+e/u, 'E')
      .replace(/E\+?(-?)(\d)$/u, 'E+$10$2')
      .replace('E+-', 'E-');
  }
  if (Number.isInteger(n)) return String(n);
  const s = Number.parseFloat(n.toPrecision(10));
  return String(tidy(s));
}

export interface Display {
  text: string;
  /** 格式里的 [Red] 等颜色 */
  color?: string;
}

const COLOR_WORDS: Record<string, string> = {
  red: '#e5484d',
  blue: '#0090ff',
  green: '#30a46c',
  black: '#1c2024',
  white: '#ffffff',
  magenta: '#d6409f',
  yellow: '#ffc53d',
  cyan: '#05a2c2',
};

/** 值 + 格式代码 → 显示文字 */
export function formatValue(v: CellValue, code?: string): Display {
  if (v === null) return { text: '' };
  if (isError(v)) return { text: v.error };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') {
    if (code && code.includes('@') && code !== '@') {
      try {
        return { text: ssfFormat(code, v) };
      } catch {
        return { text: v };
      }
    }
    return { text: v };
  }
  if (!code || code === 'General' || code === '@') return { text: general(v) };
  try {
    const text = ssfFormat(code, v);
    const section = pickSection(code, v);
    const cm = /\[(red|blue|green|black|white|magenta|yellow|cyan)\]/iu.exec(section);
    const color = cm ? COLOR_WORDS[(cm[1] ?? '').toLowerCase()] : undefined;
    return color ? { text, color } : { text };
  } catch {
    return { text: general(v) };
  }
}

function pickSection(code: string, v: number): string {
  const parts = code.split(';');
  if (parts.length === 1) return parts[0] ?? '';
  if (v > 0) return parts[0] ?? '';
  if (v < 0) return parts[1] ?? parts[0] ?? '';
  return parts[2] ?? parts[0] ?? '';
}

/** 编辑时显示的原始值：日期格式的数字显示为 yyyy-mm-dd，方便改 */
export function editText(raw: string, v: CellValue, code?: string): string {
  if (typeof v === 'number' && isDateFormat(code) && !raw.startsWith('=')) {
    try {
      return ssfFormat(Number.isInteger(v) ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss', v);
    } catch {
      return raw;
    }
  }
  return raw;
}
