import { tr } from './i18n';
/**
 * 前后端都会用到的纯函数：状态清单解析、相对时间等。
 */

export type ChecklistMark = 'done' | 'active' | 'todo';

export interface ChecklistLine {
  mark: ChecklistMark;
  text: string;
  /** 刚完成的那一步（原文加粗） */
  highlight: boolean;
}

export interface ParsedChecklist {
  title: string;
  lines: ChecklistLine[];
}

const MARKS: Record<string, ChecklistMark> = { '✓': 'done', '✱': 'active', '○': 'todo' };

/**
 * 解析线程状态清单：第 1 行标题，之后每行以 ✓ / ✱ / ○ 开头，可整体加粗 **✓ …**。
 * 无法识别的行原样当作 todo 文本，保证不会丢信息。
 */
export function parseChecklist(text: string): ParsedChecklist {
  const rows = text.split(/\r?\n/u);
  const title = (rows.shift() ?? '').trim();
  const lines: ChecklistLine[] = [];
  for (const raw of rows) {
    let row = raw.trim();
    if (!row) continue;
    let highlight = false;
    const bold = /^\*\*(.+)\*\*$/u.exec(row);
    if (bold?.[1]) {
      highlight = true;
      row = bold[1].trim();
    }
    const mark = MARKS[row.charAt(0)];
    if (mark) {
      lines.push({ mark, text: row.slice(1).trim(), highlight });
    } else {
      lines.push({ mark: 'todo', text: row, highlight });
    }
  }
  return { title, lines };
}

/** 清单进度 0–1（用于进度条）。 */
export function checklistProgress(list: ParsedChecklist): number {
  if (list.lines.length === 0) return 0;
  const done = list.lines.filter((l) => l.mark === 'done').length;
  return done / list.lines.length;
}

/** 中文相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 10月26日 */
export function relativeTimeZh(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const diff = Math.round((now.getTime() - t.getTime()) / 1000);
  if (diff < 45) return tr('刚刚');
  if (diff < 3600) return tr('{Math} 分钟前', { Math: Math.max(1, Math.round(diff / 60)) });
  if (diff < 86_400) return tr('{Math} 小时前', { Math: Math.round(diff / 3600) });
  if (diff < 2 * 86_400) return tr('昨天');
  if (diff < 7 * 86_400) return tr('{Math} 天前', { Math: Math.floor(diff / 86_400) });
  const sameYear = t.getFullYear() === now.getFullYear();
  return sameYear
    ? tr('{value}月{t}日', { value: t.getMonth() + 1, t: t.getDate() })
    : tr('{t}年{value}月{t2}日', { t: t.getFullYear(), value: t.getMonth() + 1, t2: t.getDate() });
}
