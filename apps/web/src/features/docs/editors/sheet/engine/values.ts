/**
 * 单元格的值类型与“原始输入 → 值”的解析（非公式部分）。
 * 数字、百分比、千分位、布尔、日期（转成 Excel 序列号，并给出建议的显示格式）、以 ' 开头强制文本。
 */

export interface CellError {
  error: string;
}

/** null = 空单元格 */
export type Scalar = number | string | boolean | null;
export type CellValue = Scalar | CellError;

export function isError(v: unknown): v is CellError {
  return typeof v === 'object' && v !== null && 'error' in v;
}

export const ERRORS = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#CYCLE!',
  '#ERROR!',
] as const;

export function isFormula(raw: string | undefined | null): raw is string {
  return typeof raw === 'string' && raw.length > 1 && raw.startsWith('=');
}

const PLAIN_NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u;
const GROUPED_NUM = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/u;
const CURRENCY = /^([¥$€£])\s?(-?[\d,]*\.?\d+)$/u;
const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u;
const CN_DATE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u;

/** 1900 日期系统：1899-12-30 为 0（与 Excel 一致，含 1900-02-29 的历史 bug 偏移） */
const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86_400_000;

export function dateToSerial(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  const t = Date.UTC(y, m - 1, d, hh, mm, ss);
  return (t - EPOCH) / DAY;
}

export function jsDateToSerial(d: Date): number {
  return (d.getTime() - EPOCH) / DAY;
}

export function serialToJsDate(serial: number): Date {
  return new Date(EPOCH + Math.round(serial * DAY));
}

export interface Literal {
  value: Scalar;
  /** 输入本身暗示的显示格式（日期、百分比、货币），单元格没设格式时用它 */
  format?: string;
}

/** 非公式原始输入 → 值 */
export function parseLiteral(raw: string): Literal {
  if (raw === '') return { value: null };
  if (raw.startsWith("'")) return { value: raw.slice(1) };
  const t = raw.trim();
  if (PLAIN_NUM.test(t)) return { value: Number(t) };
  if (GROUPED_NUM.test(t)) return { value: Number(t.replace(/,/gu, '')), format: '#,##0.##' };
  if (t.endsWith('%')) {
    const body = t.slice(0, -1).trim();
    if (PLAIN_NUM.test(body)) return { value: Number(body) / 100, format: '0%' };
  }
  const cur = CURRENCY.exec(t);
  if (cur) {
    const n = Number((cur[2] ?? '').replace(/,/gu, ''));
    if (Number.isFinite(n)) {
      const sym = cur[1] === '$' ? '$' : `"${cur[1]}"`;
      return { value: n, format: `${sym}#,##0.00` };
    }
  }
  const iso = ISO_DATE.exec(t) ?? CN_DATE.exec(t);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const hasTime = iso[4] !== undefined;
      return {
        value: dateToSerial(y, m, d, Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0)),
        format: hasTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd',
      };
    }
  }
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { value: true };
  if (upper === 'FALSE') return { value: false };
  if ((ERRORS as readonly string[]).includes(upper)) return { value: raw };
  return { value: raw };
}

/** 浮点误差修整（0.1+0.2 → 0.3），保留 15 位有效数字（Excel 精度） */
export function tidy(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  return Number.parseFloat(n.toPrecision(15));
}

/** 值的纯文本（CSV、markdown、比较用；不带格式） */
export function valueText(v: CellValue): string {
  if (v === null) return '';
  if (isError(v)) return v.error;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(tidy(v));
  return v;
}

/** Excel 排序规则：数字 < 文本 < 布尔，空值总在最后；文本不区分大小写、按中文拼音 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
export function compareValues(a: CellValue, b: CellValue): number {
  const rank = (v: CellValue) =>
    v === null || v === ''
      ? 4
      : typeof v === 'number'
        ? 0
        : typeof v === 'string'
          ? 1
          : typeof v === 'boolean'
            ? 2
            : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}
