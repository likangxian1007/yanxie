import type { LibraryHit } from '@srh/shared';

type Passage = Pick<LibraryHit, 'paperId' | 'text' | 'page' | 'sectionPath' | 'kind'>;
const normalize = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim();

/** 只清理送入问答的材料；原始解析记录及引用身份保持不变。 */
export function cleanQaChunks<T extends Passage>(docs: T[]): T[] {
  const repeated = new Map<string, Set<number>>();
  const key = (d: T) => `${d.paperId}:${normalize(d.text)}`;
  for (const d of docs) {
    if (d.text.length > 180) continue;
    const pages = repeated.get(key(d)) ?? new Set<number>();
    pages.add(d.page);
    repeated.set(key(d), pages);
  }
  return docs.filter((d) => {
    const text = d.text.trim();
    return (
      text &&
      !/^(?:page\s*)?\d+(?:\s*(?:\/|of)\s*\d+)?$/iu.test(text) &&
      !/^Published in\s+.{0,150}\(\d{2}\/\d{4}\)$/iu.test(text) &&
      !/^arxiv:\s*\d{4}\.\d+/iu.test(text) &&
      (repeated.get(key(d))?.size ?? 0) < 3
    );
  });
}

/** 概括优先使用论述与条目，避免图中文字或作者名单占满上下文。 */
export function proseQaChunks<T extends Passage>(docs: T[]): T[] {
  const body = cleanQaChunks(docs).filter(
    (d) =>
      (d.kind === 'abstract' || d.kind === 'paragraph') &&
      !/(?:\breferences?\b|\bbibliography\b|参考文献)/iu.test(d.sectionPath) &&
      !/^(?:figure|fig\.?|table|图|表)\s*\d+/iu.test(d.text),
  );
  const prose = body.filter((d) => {
    const text = d.text.trim();
    const chinese = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const words = text.match(/[a-z]+(?:[-'][a-z]+)*/giu)?.length ?? 0;
    return (
      (d.kind === 'abstract' || chinese >= 25 || words >= 6) &&
      (/(?<![.!?])[.!?。！？](?![.!?])[”"']?(?:\s|$)/u.test(text) || /^[•●▪*-]\s/u.test(text))
    );
  });
  return prose.length ? prose : body;
}

const aliases = [
  ['introduction', '引言', '绪论', '导论'],
  ['abstract', '摘要'],
  ['related work', 'related works', '相关工作'],
  ['method', 'methods', 'methodology', '方法'],
  ['result', 'results', '结果'],
  ['discussion', '讨论'],
  ['conclusion', 'conclusions', '结论'],
];

/** 只对简短、明确的章节阅读请求限域；比较或粘贴长正文仍使用普通问答检索。 */
export function requestedQaSection(question: string, paths: string[]): string | null {
  if (
    question.length > 240 ||
    !/概括|总结|归纳|解释|讲解|介绍|讲一下|阅读|summari[sz]e|overview|explain|describe|outline|read/iu.test(
      question,
    )
  )
    return null;
  const q = normalize(question);
  const sections = [...new Set(paths.flatMap((p) => p.split(' › ')).map(normalize))];
  const titled = sections.filter((section) => {
    const title = section.replace(/^\d+(?:\.\d+)*\.?\s+/u, '');
    if (/^第 \d+ 页$/u.test(title)) return false;
    const names = aliases.find((group) => group.includes(title)) ?? [title];
    return names.some((name) => name.length >= 2 && q.includes(name));
  });
  if (titled.length === 1) return titled[0]!;
  if (titled.length > 1) return null;
  const number =
    /第\s*([一二三四五六七八九十\d.]+)\s*(?:章|节|部分)|\b(?:section|chapter)\s+(\d+(?:\.\d+)*)/iu.exec(
      q,
    );
  const raw = number?.[1] ?? number?.[2];
  if (!raw) return null;
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'].indexOf(raw);
  const n = chinese >= 0 ? String(chinese + 1) : raw;
  const matching = sections.filter((section) => /^(\d+(?:\.\d+)*)\.?\s/u.exec(section)?.[1] === n);
  return matching.length === 1 ? matching[0]! : null;
}

/** 总预算不因长段落增加；章节模式保留长段正文，避免贡献列表在 1800 字符后被截掉。 */
export function budgetQaSources(sources: LibraryHit[], section = false): LibraryHit[] {
  let left = section ? 24000 : 21600;
  return sources.slice(0, section ? 24 : 12).flatMap((source) => {
    if (left <= 0) return [];
    const text = source.text.slice(0, Math.min(section ? 6000 : 1800, left));
    left -= text.length;
    return [{ ...source, text }];
  });
}
