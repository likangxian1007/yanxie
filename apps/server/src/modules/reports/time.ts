import { ApiError } from '@srh/shared';
import { parseDate } from '../collab-common';

/**
 * 汇报用的时间工具。研协面向国内课题组，日期按北京时间（UTC+8，无夏令时）解释与显示。
 */
const OFFSET_MS = 8 * 3600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function shifted(d: Date): Date {
  return new Date(d.getTime() + OFFSET_MS);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 2026-10-26 */
export function ymd(d: Date): string {
  const s = shifted(d);
  return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

/** 10月26日 */
export function monthDay(d: Date): string {
  const s = shifted(d);
  return `${s.getUTCMonth() + 1}月${s.getUTCDate()}日`;
}

/** 10-26 16:40 */
export function shortTime(d: Date): string {
  const s = shifted(d);
  return `${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())} ${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`;
}

/** 2026-10-26T16:40:00+08:00 */
export function isoLocal(d: Date): string {
  const s = shifted(d);
  return `${ymd(d)}T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}+08:00`;
}

/**
 * 解析汇报时间段。只给日期（YYYY-MM-DD）时，开始取当天 00:00、结束取当天 23:59:59.999（北京时间）；
 * 也接受完整的 ISO 时间。开始晚于结束时抛 422。
 */
export function parsePeriod(startRaw: string, endRaw: string): { start: Date; end: Date } {
  const start = DATE_ONLY.test(startRaw.trim())
    ? new Date(`${startRaw.trim()}T00:00:00.000+08:00`)
    : parseDate(startRaw, '开始时间');
  const end = DATE_ONLY.test(endRaw.trim())
    ? new Date(`${endRaw.trim()}T23:59:59.999+08:00`)
    : parseDate(endRaw, '结束时间');
  if (!start || Number.isNaN(start.getTime())) {
    throw new ApiError('validation_failed', '开始时间格式不对', {
      issues: [{ path: 'periodStart', message: '应为 YYYY-MM-DD 或 ISO 8601 时间' }],
    });
  }
  if (!end || Number.isNaN(end.getTime())) {
    throw new ApiError('validation_failed', '结束时间格式不对', {
      issues: [{ path: 'periodEnd', message: '应为 YYYY-MM-DD 或 ISO 8601 时间' }],
    });
  }
  if (start.getTime() > end.getTime()) {
    throw new ApiError('validation_failed', '结束时间不能早于开始时间，请重新选择时间段', {
      issues: [{ path: 'periodEnd', message: '结束时间不能早于开始时间' }],
    });
  }
  return { start, end };
}

/** 默认标题：组会汇报 · 10月20日–10月26日 */
export function defaultReportTitle(start: Date, end: Date): string {
  return `组会汇报 · ${monthDay(start)}–${monthDay(end)}`;
}
