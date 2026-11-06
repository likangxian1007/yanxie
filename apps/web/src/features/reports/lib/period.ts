import { tr } from '@/lib/i18n';
/**
 * 汇报期间的快捷选择与展示。日期一律用 YYYY-MM-DD（本地日历日）提交，
 * 服务端按“开始日 00:00 – 结束日 23:59:59.999”解释。一周从周一开始。
 */

export type PeriodPreset = 'this_week' | 'last_week' | 'two_weeks' | 'this_month' | 'custom';

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'this_week', label: tr('本周') },
  { value: 'last_week', label: tr('上周') },
  { value: 'two_weeks', label: tr('最近两周') },
  { value: 'this_month', label: tr('本月') },
  { value: 'custom', label: tr('自定义') },
];

export interface DateRange {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地日期 → YYYY-MM-DD */
export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD → 本地当天 0 点；格式不对返回 null */
export function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** 本周一（周日算上一周的最后一天） */
function mondayOf(d: Date): Date {
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

/** 快捷期间：都截止到今天（上周除外，为上周一到上周日） */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, now = new Date()): DateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'this_week':
      return { start: toYmd(mondayOf(today)), end: toYmd(today) };
    case 'last_week': {
      const monday = addDays(mondayOf(today), -7);
      return { start: toYmd(monday), end: toYmd(addDays(monday, 6)) };
    }
    case 'two_weeks':
      return { start: toYmd(addDays(today, -13)), end: toYmd(today) };
    case 'this_month':
      return {
        start: toYmd(new Date(today.getFullYear(), today.getMonth(), 1)),
        end: toYmd(today),
      };
  }
}

/** 包含首尾的天数；无效返回 0 */
export function rangeDays({ start, end }: DateRange): number {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e) return 0;
  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  return days > 0 ? days : 0;
}

/** 校验自定义期间，返回中文错误或 null */
export function validateRange(range: DateRange): string | null {
  if (!parseYmd(range.start) || !parseYmd(range.end)) return tr('请选择开始和结束日期');
  if (range.start > range.end) return tr('结束日期不能早于开始日期');
  if (rangeDays(range) > 366) return tr('时间段最长一年');
  return null;
}

function monthDay(d: Date): string {
  return tr('{value}月{d}日', { value: d.getMonth() + 1, d: d.getDate() });
}

/** 默认标题：组会汇报 · 10月20日–10月26日（与服务端默认标题一致） */
export function defaultReportTitle(range: DateRange): string {
  const s = parseYmd(range.start);
  const e = parseYmd(range.end);
  if (!s || !e) return tr('组会汇报');
  return tr('组会汇报 · {value}–{value2}', { value: monthDay(s), value2: monthDay(e) });
}

/**
 * 展示期间：同年省略年份（跨年或非今年时带上年份）。
 * 接受 ISO 时间或 YYYY-MM-DD。
 */
export function formatPeriod(startIso: string, endIso: string, now = new Date()): string {
  const s = parseYmd(startIso) ?? new Date(startIso);
  const e = parseYmd(endIso) ?? new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const withYear = s.getFullYear() !== e.getFullYear() || e.getFullYear() !== now.getFullYear();
  const fmt = (d: Date) =>
    withYear ? tr('{d}年{value}', { d: d.getFullYear(), value: monthDay(d) }) : monthDay(d);
  if (toYmd(s) === toYmd(e)) return fmt(s);
  return `${fmt(s)} – ${fmt(e)}`;
}
