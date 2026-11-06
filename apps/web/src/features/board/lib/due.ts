import { tr } from '@/lib/i18n';
/**
 * 截止日期（看板卡片与待办共用）。dueAt 是 ISO 时间；界面上按“本地日期”理解：
 * 从日期输入框写入时存为当天本地 23:59:59.999，过期 = 截止日早于今天。
 */

/** 本地日期的可比较数值：20261026 */
export function dayKey(d: Date): number {
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function parseDue(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

/** 截止日早于今天（今天截止的不算过期）。 */
export function isOverdue(iso: string | null | undefined, now: Date = new Date()): boolean {
  const due = parseDue(iso);
  return due !== null && dayKey(due) < dayKey(now);
}

/** 今天 / 明天 / 昨天 / 10月28日 / 2027年1月3日 */
export function formatDue(iso: string | null | undefined, now: Date = new Date()): string {
  const due = parseDue(iso);
  if (!due) return '';
  const k = dayKey(due);
  if (k === dayKey(now)) return tr('今天');
  if (k === dayKey(addDays(now, 1))) return tr('明天');
  if (k === dayKey(addDays(now, -1))) return tr('昨天');
  const md = tr('{value}月{due}日', { value: due.getMonth() + 1, due: due.getDate() });
  return due.getFullYear() === now.getFullYear()
    ? md
    : tr('{due}年{md}', { due: due.getFullYear(), md });
}

/** ISO → `<input type="date">` 的值（本地日期 YYYY-MM-DD），空值返回 '' */
export function toDateInputValue(iso: string | null | undefined): string {
  const due = parseDue(iso);
  if (!due) return '';
  const mm = String(due.getMonth() + 1).padStart(2, '0');
  const dd = String(due.getDate()).padStart(2, '0');
  return `${due.getFullYear()}-${mm}-${dd}`;
}

/** `<input type="date">` 的值 → 当天本地 23:59:59.999 的 ISO；空串返回 null */
export function fromDateInputValue(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

/** 按截止日期分桶：已过期 / 今天 / 本周（周一为一周开始，今天之后到周日）/ 以后 / 无日期 */
export function dueBucket(iso: string | null | undefined, now: Date = new Date()): DueBucket {
  const due = parseDue(iso);
  if (!due) return 'none';
  const k = dayKey(due);
  const today = dayKey(now);
  if (k < today) return 'overdue';
  if (k === today) return 'today';
  const toSunday = (7 - now.getDay()) % 7;
  if (k <= dayKey(addDays(now, toSunday))) return 'week';
  return 'later';
}
