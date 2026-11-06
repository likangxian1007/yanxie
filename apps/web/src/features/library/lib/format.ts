import type { Paper, PaperAuthor, PaperStatus } from '@srh/shared';
import type { BadgeTone } from '@/components/ui';
import { tr } from '@/lib/i18n';

export const STATUS_LABEL: Record<PaperStatus, string> = {
  queued: tr('排队中'),
  fetching: tr('获取中'),
  parsing: tr('解析中'),
  indexing: tr('建索引'),
  ready: tr('可阅读'),
  needs_pdf: tr('缺 PDF'),
  failed: tr('失败'),
};

export const STATUS_TONE: Record<PaperStatus, BadgeTone> = {
  queued: 'neutral',
  fetching: 'accent',
  parsing: 'accent',
  indexing: 'accent',
  ready: 'success',
  needs_pdf: 'warning',
  failed: 'danger',
};

/**
 * 别人分享给我的、已解析好的论文：「就绪」状态的文案「可阅读」和分享权限「可阅读」撞字，
 * 这时只显示分享权限标记，不再显示状态。
 */
export function sharedReady(p: Pick<Paper, 'status' | 'space' | 'access'>): boolean {
  return p.status === 'ready' && p.space === 'personal' && !!p.access && p.access !== 'manage';
}

export const isWorking = (s: PaperStatus) =>
  s === 'queued' || s === 'fetching' || s === 'parsing' || s === 'indexing';

/** “Vaswani 等” / “Vaswani、Shazeer” */
export function shortAuthors(authors: PaperAuthor[]): string {
  if (authors.length === 0) return tr('作者未知');
  const fam = (a: PaperAuthor) => a.family ?? a.name;
  if (authors.length === 1) return fam(authors[0]!);
  if (authors.length === 2)
    return tr('{value}、{value2}', { value: fam(authors[0]!), value2: fam(authors[1]!) });
  return tr('{value} 等 {count} 人', { value: fam(authors[0]!), count: authors.length });
}

export function sourceLine(p: Paper): string {
  const bits: string[] = [];
  if (p.venue) bits.push(p.venue);
  if (p.year) bits.push(String(p.year));
  if (p.arxivId) bits.push(`arXiv:${p.arxivId}`);
  else if (p.doi) bits.push(`DOI ${p.doi}`);
  return bits.join(' · ');
}

export const PARSER_LABEL: Record<string, string> = {
  grobid: 'GROBID',
  mineru: 'MinerU',
  'pdf-text': tr('纯文本（降级）'),
};

/** 根据输入猜导入方式：arXiv 编号 / DOI / 链接 */
export function guessImportKind(v: string): 'arxiv' | 'doi' | 'url' | null {
  const s = v.trim();
  if (!s) return null;
  if (/^(arxiv:)?\s*(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/iu.test(s)) return 'arxiv';
  if (/arxiv\.org\/(abs|pdf)\//iu.test(s)) return 'arxiv';
  if (/^(doi:\s*)?10\.\d{4,9}\//iu.test(s) || /doi\.org\/10\./iu.test(s)) return 'doi';
  if (/^https?:\/\//iu.test(s)) return 'url';
  return null;
}
