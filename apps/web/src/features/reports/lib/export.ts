import type { ReportStats } from '@srh/shared';
import { formatPeriod, toYmd } from './period';
import { tr } from '@/lib/i18n';

/** 文件名里不能出现的字符（Windows 最严格）与控制字符 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/gu;

function ymdOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : toYmd(d);
}

/**
 * 导出文件名：标题去掉非法字符（“组会汇报 · 10月20日–10月26日.md”）；
 * 标题为空时用期间：“组会汇报-2026-10-20至2026-10-26.md”。最长 80 字。
 */
export function reportFileName(report: {
  title: string;
  periodStart: string;
  periodEnd: string;
}): string {
  const cleaned = report.title
    .replace(ILLEGAL, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s.]+|[\s.]+$/gu, '')
    .slice(0, 80)
    .trim();
  if (cleaned) return `${cleaned}.md`;
  const s = ymdOf(report.periodStart);
  const e = ymdOf(report.periodEnd);
  return s && e ? tr('组会汇报-{s}至{e}.md', { s, e }) : tr('组会汇报.md');
}

/** 导出内容：正文没有一级标题时补上标题与期间 */
export function reportMarkdown(report: {
  title: string;
  periodStart: string;
  periodEnd: string;
  content: string;
}): string {
  const body = report.content.trim();
  if (/^#\s/u.test(body)) return `${body}\n`;
  const period = formatPeriod(report.periodStart, report.periodEnd);
  const head = `# ${report.title || tr('组会汇报')}\n\n${period ? `> ${period}\n\n` : ''}`;
  return `${head}${body}\n`;
}

/** 在浏览器里下载一段文本 */
export function downloadText(filename: string, text: string, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** “整理了 12 个线程 · 5 个实验 · 3 个审阅” */
export function statsSummary(stats: ReportStats | null): string | null {
  if (!stats) return null;
  const parts = [
    stats.threads ? tr('{threads} 个线程', { threads: stats.threads }) : '',
    stats.experiments ? tr('{experiments} 个实验', { experiments: stats.experiments }) : '',
    stats.reviews ? tr('{reviews} 个审阅', { reviews: stats.reviews }) : '',
    stats.documents ? tr('{documents} 份文档', { documents: stats.documents }) : '',
    stats.todos ? tr('{todos} 条待办', { todos: stats.todos }) : '',
  ].filter(Boolean);
  if (parts.length === 0) {
    return stats.messages
      ? tr('整理了 {messages} 条讨论', { messages: stats.messages })
      : tr('这一期没有找到可整理的上下文');
  }
  return tr('整理了 {parts}', { parts: parts.join(' · ') });
}
