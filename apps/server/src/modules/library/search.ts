import { scopeKey, scopeWhere, type LibraryScopeInput } from './scope';
import { and, eq, isNull } from 'drizzle-orm';
import type { LibraryHit, PaperChunk, PdfBox } from '@srh/shared';
import type { AppContext } from '../../context';
import { paperChunks, papers } from '../../db/schema';
import { cleanQaChunks, proseQaChunks, requestedQaSection } from './qa-context';

/**
 * 段落检索：进程内 BM25（不依赖向量、不依赖 Postgres 扩展，PGlite 与 Postgres 16 一致）。
 * 每个项目一份倒排索引，按需构建并缓存；论文解析完成 / 删除 / 归档时作废（invalidate）。
 *
 * 分词：英文小写 + 去停用词 + 轻量词干（复数、-ing、-ed）；中文按字二元组。
 * 中文问题查英文论文时，问答接口会先让模型给出英文关键词再检索（qa.ts）。
 */

const STOP = new Set(
  (
    'a an the of on in for to and or with from by at as is are was were be been being this that these those it its ' +
    'we our you your they their he she his her them us i me my which who whom what when where why how than then ' +
    'there here also can could may might will would shall should do does did done not no nor but if so such into ' +
    'over under about between through during before after above below up down out off again further once all any ' +
    'both each few more most other some own same too very s t just only via use used using one two'
  ).split(' '),
);

function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && /(?:ch|sh|x|z)es$/u.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const HAN = /\p{Script=Han}/u;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const tok = m[0];
    if (HAN.test(tok)) {
      if (tok.length === 1) out.push(tok);
      for (let i = 0; i < tok.length - 1; i += 1) out.push(tok.slice(i, i + 2));
      continue;
    }
    // bert-base → bert, base, bert-base
    const parts = tok.split(/[-_]/u).filter(Boolean);
    for (const p of parts) {
      if (STOP.has(p) || (p.length < 2 && !/\d/u.test(p))) continue;
      out.push(stem(p));
    }
    if (parts.length > 1) out.push(tok.replace(/_/gu, '-'));
  }
  return out;
}

interface Doc {
  chunkId: string;
  paperId: string;
  seq: number;
  kind: PaperChunk['kind'];
  sectionPath: string;
  page: number;
  para: number;
  boxes: PdfBox[];
  text: string;
  len: number;
  tf: Map<string, number>;
}

interface Index {
  docs: Doc[];
  df: Map<string, number>;
  avgLen: number;
  papers: Map<string, { title: string; citekey: string; titleTokens: Set<string> }>;
}

const cache = new WeakMap<AppContext, Map<string, Promise<Index>>>();

function projectCache(ctx: AppContext) {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = new Map()));
  return m;
}

export function invalidateIndex(ctx: AppContext, projectId: LibraryScopeInput): void {
  projectCache(ctx).delete(scopeKey(projectId));
}

async function build(ctx: AppContext, projectId: LibraryScopeInput): Promise<Index> {
  const rows = await ctx.db.db
    .select({ c: paperChunks, title: papers.title, citekey: papers.citekey })
    .from(paperChunks)
    .innerJoin(papers, eq(papers.id, paperChunks.paperId))
    .where(and(scopeWhere(papers, projectId), isNull(papers.archivedAt)));
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  const paperInfo: Index['papers'] = new Map();
  let total = 0;
  for (const { c, title, citekey } of rows) {
    if (!paperInfo.has(c.paperId)) {
      paperInfo.set(c.paperId, { title, citekey, titleTokens: new Set(tokenize(title)) });
    }
    // 小节标题也算进段落的词（“Positional Encoding” 一节里的段落能被这个词找到）
    const tokens = tokenize(`${c.text} ${c.sectionPath.replace(/^[\d.\s]+/u, '')}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    total += tokens.length;
    docs.push({
      chunkId: c.id,
      paperId: c.paperId,
      seq: c.seq,
      kind: c.kind,
      sectionPath: c.sectionPath,
      page: c.page,
      para: c.para,
      boxes: c.boxes,
      text: c.text,
      len: tokens.length,
      tf,
    });
  }
  return { docs, df, avgLen: docs.length ? total / docs.length : 1, papers: paperInfo };
}

function getIndex(ctx: AppContext, projectId: LibraryScopeInput): Promise<Index> {
  const m = projectCache(ctx);
  let p = m.get(scopeKey(projectId));
  if (!p) {
    p = build(ctx, projectId);
    m.set(scopeKey(projectId), p);
    p.catch(() => m.delete(scopeKey(projectId)));
  }
  return p;
}

export interface SearchOptions {
  paperId?: string | undefined;
  /** 只在这些论文里找 */
  paperIds?: string[] | undefined;
  limit?: number;
  /** 每篇论文最多返回几段（跨论文检索时避免一篇霸屏），默认 4；限定单篇时不限 */
  perPaper?: number;
  /** 问答排除重复页眉与页码；普通全文检索仍返回原始段落。 */
  forQa?: boolean;
}

const K1 = 1.2;
const B = 0.75;

/** BM25 打分；queries 可以给多组（原问题 + 英文关键词），各自打分后取最大值再加和奖励 */
export async function searchLibrary(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  queries: string | string[],
  opts: SearchOptions = {},
): Promise<LibraryHit[]> {
  const idx = await getIndex(ctx, projectId);
  const list = (Array.isArray(queries) ? queries : [queries]).filter((q) => q.trim());
  const N = idx.docs.length;
  if (N === 0 || list.length === 0) return [];
  const allow = opts.paperId
    ? new Set(!opts.paperIds || opts.paperIds.includes(opts.paperId) ? [opts.paperId] : [])
    : opts.paperIds
      ? new Set(opts.paperIds)
      : null;
  const scores = new Map<number, number>();
  const allowedChunks = opts.forQa ? new Set(cleanQaChunks(idx.docs)) : null;
  for (const q of list) {
    const terms = [...new Set(tokenize(q))];
    if (terms.length === 0) continue;
    const idf = new Map(
      terms.map((t) => {
        const df = idx.df.get(t) ?? 0;
        return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))] as const;
      }),
    );
    idx.docs.forEach((d, i) => {
      if (allow && !allow.has(d.paperId)) return;
      if (allowedChunks && !allowedChunks.has(d)) return;
      let s = 0;
      let matched = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched += 1;
        s += (idf.get(t)! * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / idx.avgLen));
      }
      if (s <= 0) return;
      // 覆盖率奖励：多个词都命中的段落优先
      s *= 0.6 + (0.4 * matched) / terms.length;
      // 太短的段落（标题残片、公式碎片）降权
      if (d.len < 8) s *= 0.6;
      const title = idx.papers.get(d.paperId)?.titleTokens;
      if (title && terms.some((t) => title.has(t))) s *= 1.1;
      scores.set(i, Math.max(scores.get(i) ?? 0, s));
    });
  }
  const limit = opts.limit ?? 10;
  const perPaper = opts.paperId ? Infinity : (opts.perPaper ?? 4);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const count = new Map<string, number>();
  const hits: LibraryHit[] = [];
  for (const [i, score] of ranked) {
    const d = idx.docs[i]!;
    const n = count.get(d.paperId) ?? 0;
    if (n >= perPaper) continue;
    count.set(d.paperId, n + 1);
    const info = idx.papers.get(d.paperId)!;
    hits.push({
      paperId: d.paperId,
      paperTitle: info.title,
      citekey: info.citekey,
      chunkId: d.chunkId,
      seq: d.seq,
      kind: d.kind,
      sectionPath: d.sectionPath,
      page: d.page,
      para: d.para,
      boxes: d.boxes,
      text: d.text,
      score: Math.round(score * 1000) / 1000,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 单篇阅读的概览材料，不要求用户的问题包含论文里的专业词。仍使用同一归属隔离索引。 */
export async function paperOverview(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  limit = 12,
): Promise<LibraryHit[]> {
  const idx = await getIndex(ctx, scope);
  const info = idx.papers.get(paperId);
  if (!info) return [];
  const docs = proseQaChunks(idx.docs.filter((d) => d.paperId === paperId)).sort(
    (a, b) => a.seq - b.seq,
  );
  const count = Math.max(1, Math.min(12, Math.floor(limit)));
  const chosen = new Set<Doc>();
  const add = (d: Doc | undefined) => {
    if (d && chosen.size < count) chosen.add(d);
  };
  // 先保留首尾、摘要及主要章节，再按全篇位置补足，避免只看到开头。
  add(docs[0]);
  add(docs.at(-1));
  add(docs.find((d) => d.kind === 'abstract'));
  for (const section of [
    /method|approach|framework|方法|框架/iu,
    /result|experiment|evaluation|结果|实验/iu,
    /discussion|limitation|讨论|局限/iu,
    /conclusion|结论/iu,
  ])
    add(docs.find((d) => section.test(d.sectionPath)));
  for (let i = 0; i < count; i++)
    add(docs[Math.round((i * (docs.length - 1)) / Math.max(1, count - 1))]);
  for (const d of docs) add(d);
  return [...chosen]
    .sort((a, b) => a.seq - b.seq)
    .map((d) => ({
      paperId: d.paperId,
      paperTitle: info.title,
      citekey: info.citekey,
      chunkId: d.chunkId,
      seq: d.seq,
      kind: d.kind,
      sectionPath: d.sectionPath,
      page: d.page,
      para: d.para,
      boxes: d.boxes,
      text: d.text,
      score: 0,
    }));
}

/** 已识别的章节请求只读取该章及子节；未识别则交回普通问答。 */
export async function paperSection(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  question: string,
): Promise<LibraryHit[] | null> {
  const idx = await getIndex(ctx, scope);
  const info = idx.papers.get(paperId);
  if (!info) return null;
  const docs = idx.docs.filter((d) => d.paperId === paperId);
  const section = requestedQaSection(
    question,
    docs.map((d) => d.sectionPath),
  );
  if (!section) return null;
  const belongs = (d: Doc) =>
    d.sectionPath
      .split(' › ')
      .some((p) => p.toLowerCase().replace(/\s+/gu, ' ').trim() === section);
  return proseQaChunks(cleanQaChunks(docs).filter(belongs))
    .sort((a, b) => a.seq - b.seq)
    .map((d) => ({
      paperId: d.paperId,
      paperTitle: info.title,
      citekey: info.citekey,
      chunkId: d.chunkId,
      seq: d.seq,
      kind: d.kind,
      sectionPath: d.sectionPath,
      page: d.page,
      para: d.para,
      boxes: d.boxes,
      text: d.text,
      score: 0,
    }));
}
