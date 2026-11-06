import { formatBibEntry, type BibEntry } from '../compile/bib';
import { L10N, Out, createCtx, type Ctx, type Lang } from './context';
import { PH_CLOSE, PH_OPEN, Parser, anchorKey } from './latexParser';
import { containsCjk, escapeHtml, latexToPlain } from './text';
import type { LatexBlock, LatexRenderOptions, LatexRenderResult, LatexWarning } from './types';
import { tr } from '@/lib/i18n';

/**
 * LaTeX 源码 → 预览 HTML（纯 TS，不依赖 DOM，可在测试和 Worker 里跑）。
 * 输出的 HTML 未清洗，展示前必须经过 sanitizeLatexHtml。
 */
export function renderLatex(source: string, options: LatexRenderOptions = {}): LatexRenderResult {
  const src = source.replace(/\r\n?/g, '\n').replace(/[\uE000-\uE002]/g, '');
  const ctx = createCtx(detectLang(src), options.today ?? new Date());
  const parser = new Parser(ctx, src);
  const top = new Out(true);

  const begin = findBeginDocument(src);
  if (begin) {
    // 导言区：只为了收集 \title、\newcommand 等，产生的正文丢弃
    ctx.inPreamble = true;
    parser.parseInto(0, begin.start, new Out(true));
    ctx.inPreamble = false;
    const end = parser.findEnvEnd('document', begin.after, src.length);
    if (!end) parser.warn(begin.start, tr('缺少 \\end{document}'));
    parser.parseInto(begin.after, end ? end.contentEnd : src.length, top);
  } else {
    const dc = /\\documentclass/.exec(src);
    if (dc) parser.warn(dc.index, tr('缺少 \\begin{document}，正文要写在 document 环境里'));
    parser.parseInto(0, src.length, top);
  }
  top.finish();

  const blocks: LatexBlock[] = [...top.blocks];
  const lastLine = blocks[blocks.length - 1]?.endLine ?? 1;
  if (ctx.footnotes.length > 0) {
    const items = ctx.footnotes
      .map(
        (f) =>
          `<li data-anchor="${f.anchor}"><span class="ltx-fn-mark">${escapeHtml(f.mark)}</span><div>${f.html}</div></li>`,
      )
      .join('');
    blocks.push({
      line: lastLine,
      endLine: lastLine,
      html: `<section class="ltx-footnotes"><ol>${items}</ol></section>`,
    });
  }

  const bibDb = collectBib(ctx, options.bib);
  assignFallbackBibNumbers(ctx, bibDb);
  const resolve = makeResolver(ctx, bibDb);
  const re = new RegExp(`${PH_OPEN}([RCTB])(\\d+)${PH_CLOSE}`, 'g');
  for (const block of blocks) {
    if (block.html.includes(PH_OPEN)) {
      block.html = block.html.replace(re, (_m, kind: string, idx: string) =>
        resolve(kind, Number(idx)),
      );
    }
  }

  const outline = ctx.sections.map((s) => ({
    heading: s.number ? `${s.number} ${s.heading}` : s.heading,
    level: Math.min(6, Math.max(1, s.level)),
  }));

  return {
    html: blocks.map((b) => b.html).join(''),
    blocks,
    outline,
    sections: ctx.sections,
    warnings: dedupeWarnings(ctx.warnings),
    title: ctx.title ? latexToPlain(ctx.title.raw) || null : null,
  };
}

function detectLang(src: string): Lang {
  if (
    /\\documentclass\s*(\[[^\]]*\])?\s*\{\s*ctex/.test(src) ||
    /\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\b(ctex|xeCJK|CJKutf8)\b/.test(src)
  ) {
    return 'zh';
  }
  // 去掉注释后正文里有中文也按中文排版
  const body = src.replace(/(^|[^\\])%[^\n]*/g, '$1');
  return containsCjk(body) ? 'zh' : 'en';
}

function findBeginDocument(src: string): { start: number; after: number } | null {
  const re = /\\\\|\\%|%[^\n]*|\\begin\s*\{document\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith('\\begin')) return { start: m.index, after: m.index + m[0].length };
  }
  return null;
}

/** \bibliography{a,b} 引用到的、工程里存在的 .bib 条目（key → 条目）；没传 .bib 时为 null */
interface BibDb {
  entries: Map<string, BibEntry>;
  /** 引用了但工程里没有的 .bib 文件 */
  missing: string[];
  /** 实际读到的 .bib 文件名 */
  found: string[];
}

function collectBib(ctx: Ctx, bib: Record<string, BibEntry[]> | undefined): BibDb | null {
  if (!bib || ctx.bibCount > 0 || ctx.bibFiles.length === 0) return null;
  const entries = new Map<string, BibEntry>();
  const missing: string[] = [];
  const found: string[] = [];
  for (const raw of ctx.bibFiles) {
    if (!raw) continue;
    const name = /\.bib$/iu.test(raw) ? raw : `${raw}.bib`;
    const list = bib[name] ?? bib[name.replace(/^\.\//u, '')];
    if (!list) {
      missing.push(name);
      continue;
    }
    found.push(name);
    for (const e of list) if (!entries.has(e.key)) entries.set(e.key, e);
  }
  return { entries, missing, found };
}

/** 没有 thebibliography、但用了 \bibliography{…}：按首次引用顺序编号（有 .bib 时只给存在的条目编号） */
function assignFallbackBibNumbers(ctx: Ctx, db: BibDb | null): void {
  if (ctx.bibCount > 0 || ctx.bibFiles.length === 0) return;
  let n = 0;
  const add = (key: string) => {
    if (db && !db.entries.has(key)) return;
    if (!ctx.bib.has(key)) ctx.bib.set(key, (n += 1));
  };
  for (const cite of ctx.cites) cite.keys.forEach(add);
  if (db && ctx.nocite.includes('*')) [...db.entries.keys()].forEach(add);
  ctx.nocite.filter((k) => k !== '*').forEach(add);
}

function bibEntryHtml(entry: BibEntry): string {
  const f = formatBibEntry(entry);
  const parts: string[] = [];
  if (f.authors) parts.push(`<span class="ltx-bib-authors">${escapeHtml(f.authors)}</span>. `);
  if (f.title) parts.push(`<span class="ltx-bib-title">${escapeHtml(f.title)}</span>. `);
  if (f.venue) parts.push(`<em>${escapeHtml(f.venue)}</em>${f.year ? ', ' : '. '}`);
  if (f.year) parts.push(`${escapeHtml(f.year)}.`);
  return parts.join('') || `<code class="ltx-tt">${escapeHtml(entry.key)}</code>`;
}

function makeResolver(ctx: Ctx, db: BibDb | null): (kind: string, index: number) => string {
  const t = L10N[ctx.lang];
  const warn = (line: number, message: string, fixable = true) =>
    ctx.warnings.push({ line, message, ...(fixable ? {} : { fixable: false }) });
  const fallbackBib = ctx.bibCount === 0 && ctx.bibFiles.length > 0;
  if (db) {
    const line =
      ctx.sections.find((s) => s.anchor && s.number === '' && s.heading === t.references)?.line ??
      1;
    for (const name of db.missing) {
      warn(
        line,
        tr('工程里没有 {name}（\\bibliography 引用了它；在文件栏里新建或改名）', { name }),
        false,
      );
    }
  }
  return (kind, index) => {
    if (kind === 'R') {
      const ref = ctx.refs[index];
      if (!ref) return '';
      const info = ctx.labels.get(ref.key);
      if (!info) {
        warn(
          ref.line,
          tr('找不到标签 {key}（\\{kind} 引用了没有定义的 \\label）', {
            key: ref.key,
            kind: ref.kind,
          }),
        );
        return tr('<span class="ltx-ref-missing" title="找不到标签 {value}">??</span>', {
          value: escapeHtml(ref.key),
        });
      }
      let text = escapeHtml(info.num || '??');
      if (ref.kind === 'eqref') text = `(${text})`;
      if (ref.kind === 'autoref' || ref.kind === 'cref' || ref.kind === 'Cref') {
        const word =
          info.kind === 'figure'
            ? t.figure
            : info.kind === 'table'
              ? t.table
              : info.kind === 'equation'
                ? t.equation
                : info.kind === 'section'
                  ? t.section
                  : '';
        if (info.kind === 'equation') text = `(${text})`;
        if (word) {
          text =
            ctx.lang === 'zh'
              ? info.kind === 'section'
                ? tr('第 {text} {word}', { text, word })
                : `${word} ${text}`
              : `${word}&nbsp;${text}`;
        }
      }
      return info.anchor
        ? `<a class="ltx-ref" data-ref="${escapeHtml(info.anchor)}">${text}</a>`
        : text;
    }
    if (kind === 'C') {
      const cite = ctx.cites[index];
      if (!cite) return '';
      const parts = cite.keys.map((key) => {
        const n = ctx.bib.get(key);
        if (n === undefined) {
          warn(
            cite.line,
            ctx.bibCount === 0 && !fallbackBib
              ? tr(
                  '找不到参考文献 {key}（没有 \\bibliography{…}，也没有 thebibliography 里的 \\bibitem）',
                  { key },
                )
              : db && db.found.length > 0
                ? tr('找不到参考文献 {key}（{found} 里没有这个条目）', {
                    key,
                    found: db.found.join(tr('、')),
                  })
                : tr('找不到参考文献 {key}', { key }),
            false,
          );
          return '<span class="ltx-ref-missing">?</span>';
        }
        return `<a class="ltx-ref" data-ref="bib-${escapeHtml(anchorKey(key))}">${n}</a>`;
      });
      const note = cite.note ? `, ${escapeHtml(cite.note.replace(/~/g, ' '))}` : '';
      return `<span class="ltx-cite">[${parts.join(', ')}${note}]</span>`;
    }
    if (kind === 'T') {
      const items = ctx.sections
        .map(
          (s) =>
            `<li class="ltx-toc-l${s.level}"><a class="ltx-ref" data-ref="${s.anchor}">${s.number ? `<span class="ltx-secnum">${s.number}</span>` : ''}${escapeHtml(s.heading)}</a></li>`,
        )
        .join('');
      return `<nav class="ltx-toc"><div class="ltx-toc-title">${t.contents}</div><ol>${items}</ol></nav>`;
    }
    if (kind === 'B') {
      if (!fallbackBib) return '';
      if (db) {
        const items = [...ctx.bib.entries()]
          .sort((a, b) => a[1] - b[1])
          .map(([key, n]) => {
            const entry = db.entries.get(key);
            return `<li data-anchor="bib-${escapeHtml(anchorKey(key))}"><span class="ltx-bib-label">[${n}]</span><div class="ltx-bib-body">${entry ? bibEntryHtml(entry) : `<code class="ltx-tt">${escapeHtml(key)}</code>`}</div></li>`;
          })
          .join('');
        return items
          ? `<ol class="ltx-bib-list">${items}</ol>`
          : tr('<p class="ltx-note">还没有引用任何文献（用 \\cite{key} 引用 .bib 里的条目）。</p>');
      }
      const files = ctx.bibFiles.map((f) => escapeHtml(f)).join(tr('、'));
      const entries = [...ctx.bib.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(
          ([key, n]) =>
            `<li data-anchor="bib-${escapeHtml(anchorKey(key))}"><span class="ltx-bib-label">[${n}]</span><div class="ltx-bib-body"><code class="ltx-tt">${escapeHtml(key)}</code></div></li>`,
        )
        .join('');
      return tr(
        '<p class="ltx-note">预览不读取 .bib 文件（{files}），这里只列出正文引用到的条目。</p><ol class="ltx-bib-list">{entries}</ol>',
        { files, entries },
      );
    }
    return '';
  };
}

function dedupeWarnings(list: LatexWarning[]): LatexWarning[] {
  const seen = new Set<string>();
  const out: LatexWarning[] = [];
  for (const w of list) {
    const key = `${w.line}\u0001${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.sort((a, b) => a.line - b.line);
}
