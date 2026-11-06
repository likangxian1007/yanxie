import { tr } from '@/lib/i18n';
/** 完整时间：2026年10月26日 16:40（相对时间的 hover 提示用） */
export function formatFullTimeZh(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return tr('{d}年{value}月{d2}日 {hh}:{mm}', {
    d: d.getFullYear(),
    value: d.getMonth() + 1,
    d2: d.getDate(),
    hh,
    mm,
  });
}
