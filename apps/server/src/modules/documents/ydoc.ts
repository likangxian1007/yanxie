import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import {
  ApiError,
  LATEX_YDOC,
  YDOC_FIELD,
  type DocumentEdit,
  type DocumentKind,
  type DocumentOutlineItem,
} from '@srh/shared';
import { footnotesOf, markdownToPm, pmText, pmToMarkdown, type PmNode } from './markdown';
import {
  applySlidesEdit,
  initSlides,
  replaceSlidesContent,
  slidesOutline,
  slidesToMarkdown,
} from './slides';
import {
  collectSpecialAttrs,
  headingKey,
  pmBlocksToY,
  pmInlineToY,
  replaceDocText,
  yToJson,
  type KeptAttrs,
} from './doc-edit';
import { DOC_PAGE_FIELD } from './pm-word';
import {
  SHEET_MAX,
  SheetEditError,
  clearSheet,
  colName,
  ensureWorkbook,
  listSheets,
  nextFreeRow,
  replaceWorkbook,
  sheetForEdit,
  sheetToMarkdown,
  splitSheetSections,
  writeCells,
  type CellInput,
} from './sheet-model';

/**
 * 四类文档在 Y.Doc 里的读写（结构见 @srh/shared YDOC_FIELD）。
 * 所有写操作都应在调用方的 doc.transact 里执行，这样对在线编辑者是一次原子更新。
 */

// ---------------------------------------------------------------- 富文本（doc）

function fragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(YDOC_FIELD.doc);
}

export function docJson(doc: Y.Doc): PmNode {
  return yXmlFragmentToProsemirrorJSON(fragment(doc)) as PmNode;
}

/**
 * markdown → 一组可直接插入 fragment 的 Y 节点（先按 schema 校验）。
 * kept：重写前旧节点上 markdown 写不出的属性（图片宽度、嵌入高度…），见 doc-edit.ts。
 */
function markdownToYNodes(
  markdown: string,
  kept?: KeptAttrs,
  footnotes?: Map<string, string>,
): (Y.XmlElement | Y.XmlText)[] {
  return pmBlocksToY(markdownToPm(markdown, footnotes).content ?? [], kept);
}

function yNodeText(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[])
      .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
      .join('');
  }
  if (node instanceof Y.XmlElement) {
    return node
      .toArray()
      .map((c) => yNodeText(c as Y.XmlElement))
      .join('');
  }
  return '';
}

interface TopHeading {
  index: number;
  level: number;
  text: string;
}

function topHeadings(frag: Y.XmlFragment): TopHeading[] {
  const out: TopHeading[] = [];
  frag.toArray().forEach((n, index) => {
    if (n instanceof Y.XmlElement && n.nodeName === 'heading') {
      out.push({ index, level: Number(n.getAttribute('level') ?? 1), text: yNodeText(n).trim() });
    }
  });
  return out;
}

const normHeading = (s: string) =>
  s
    .replace(/^#+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();

interface Section {
  /** 标题下标、小节结束下标（不含） */
  start: number;
  end: number;
  level: number;
  text: string;
  /**
   * 紧挨在它前面、同名同级的空标题（之前的编辑留下的重复标题）从这里开始；没有时等于 start。
   * 这些空壳只有标题没有正文，小节定位到最后一个，replace_section 时一并删掉。
   */
  dupStart: number;
}

/** 找到标题所在小节。先按原文比，再按宽松规则比（忽略 `#`、编号前后空白、全半角标点） */
function findSection(frag: Y.XmlFragment, heading: string): Section {
  const target = normHeading(heading);
  const all = topHeadings(frag);
  let i = all.findIndex((h) => normHeading(h.text) === target);
  if (i < 0) {
    const key = headingKey(heading);
    i = key ? all.findIndex((h) => headingKey(h.text) === key) : -1;
  }
  if (i < 0) {
    throw new ApiError('not_found', `文档里没有标题「${target}」`, {
      headings: all.map((h) => h.text),
    });
  }
  const dupStart = all[i]!.index;
  while (
    all[i + 1] &&
    all[i + 1]!.index === all[i]!.index + 1 &&
    all[i + 1]!.level === all[i]!.level &&
    headingKey(all[i + 1]!.text) === headingKey(all[i]!.text)
  ) {
    i += 1;
  }
  const h = all[i]!;
  const next = all.slice(i + 1).find((x) => x.level <= h.level);
  return {
    start: h.index,
    end: next ? next.index : frag.length,
    level: h.level,
    text: h.text,
    dupStart,
  };
}

/** 要写入的内容以同名标题开头（agent 常把本节标题连同正文一起写）：返回这个标题节点 */
function leadingSameHeading(blocks: PmNode[], sec: Section): PmNode | null {
  const first = blocks[0];
  if (first?.type !== 'heading') return null;
  return headingKey(pmText(first)) === headingKey(sec.text) ? first : null;
}

/**
 * agent 常把一级标题写成 `##`：开头的标题当作本节标题时沿用原级别，
 * 后面的子标题按同样的差值平移（`##`→`#` 时 `###`→`##`），大纲层级不被悄悄改掉。
 */
function shiftHeadings(blocks: PmNode[], delta: number): void {
  if (!delta) return;
  for (const b of blocks) {
    if (b.type !== 'heading') continue;
    const lv = Number(b.attrs?.level ?? 1) + delta;
    b.attrs = { ...(b.attrs ?? {}), level: Math.min(6, Math.max(1, lv)) };
  }
}

function replaceSection(doc: Y.Doc, heading: string, markdown: string) {
  const frag = fragment(doc);
  const sec = findSection(frag, heading);
  const kept = collectSpecialAttrs(frag.slice(sec.start + 1, sec.end));
  const blocks = markdownToPm(markdown, footnotesOf(docJson(doc))).content ?? [];
  // 以同名标题（或同级标题）开头：当作这一节的新标题，不再在原标题下面多写一个
  let title = leadingSameHeading(blocks, sec);
  if (
    !title &&
    blocks[0]?.type === 'heading' &&
    Number(blocks[0].attrs?.level ?? 1) === sec.level
  ) {
    title = blocks[0];
  }
  if (title) {
    blocks.shift();
    shiftHeadings(blocks, sec.level - Number(title.attrs?.level ?? 1));
  }
  const nodes = pmBlocksToY(blocks, kept); // 先校验，再删除

  const old = frag.get(sec.start) as Y.XmlElement;
  let titleKids: (Y.XmlElement | Y.XmlText)[] | null = null;
  if (title) {
    if (headingKey(pmText(title)) !== headingKey(yNodeText(old))) {
      // 改名（只差空白、全半角时不算改名，保留原文）：就地换文字，沿用原标题的字体和段落格式
      const cur = yToJson(old).content ?? [];
      const base = cur.find((n) => n.type === 'text')?.marks ?? [];
      const content = (title.content ?? []).map((n) =>
        n.type === 'text'
          ? {
              ...n,
              marks: [
                ...base.filter((b) => !(n.marks ?? []).some((m) => m.type === b.type)),
                ...(n.marks ?? []),
              ],
            }
          : n,
      );
      titleKids = pmInlineToY({
        type: 'heading',
        attrs: { ...(old.getAttributes() as Record<string, unknown>) },
        content,
      });
    }
  }

  // 从后往前改，前面的下标不变
  if (sec.end - sec.start - 1 > 0) frag.delete(sec.start + 1, sec.end - sec.start - 1);
  if (nodes.length) frag.insert(sec.start + 1, nodes);
  if (titleKids) {
    if (old.length) old.delete(0, old.length);
    if (titleKids.length) old.insert(0, titleKids);
  }
  if (sec.start > sec.dupStart) frag.delete(sec.dupStart, sec.start - sec.dupStart);
}

function applyDocEdit(doc: Y.Doc, edit: DocumentEdit): void {
  const frag = fragment(doc);
  // markdown 里脚注写成 `[^n]`、定义在全文末尾；只改一节时按现有编号带回脚注内容
  const notes = () => footnotesOf(docJson(doc));
  switch (edit.op) {
    case 'append':
      frag.insert(frag.length, markdownToYNodes(edit.markdown));
      return;
    case 'insert_after_heading': {
      const sec = findSection(frag, edit.heading);
      const blocks = markdownToPm(edit.markdown).content ?? [];
      const lead = leadingSameHeading(blocks, sec);
      if (lead) {
        blocks.shift();
        shiftHeadings(blocks, sec.level - Number(lead.attrs?.level ?? 1));
      }
      const nodes = pmBlocksToY(blocks);
      if (nodes.length) frag.insert(sec.end, nodes);
      return;
    }
    case 'replace_section':
      replaceSection(doc, edit.heading, edit.markdown);
      return;
    case 'replace_text': {
      const occurrence = 'occurrence' in edit ? edit.occurrence : undefined;
      replaceDocText(frag, edit.find, edit.replace, {
        all: edit.all ?? false,
        ...(occurrence ? { occurrence } : {}),
        notes: notes(),
      });
      return;
    }
    case 'replace_all':
      {
        const kept = collectSpecialAttrs(frag.toArray());
        const nodes = markdownToYNodes(edit.markdown, kept, notes()); // 先校验，再删除
        if (frag.length) frag.delete(0, frag.length);
        frag.insert(0, nodes);
      }
      return;
    default:
      throw unsupported('doc', edit.op);
  }
}

// ---------------------------------------------------------------- LaTeX

function latexText(doc: Y.Doc): Y.Text {
  return doc.getText(YDOC_FIELD.latex);
}

function applyLatexEdit(doc: Y.Doc, edit: DocumentEdit): void {
  const text = latexText(doc);
  const src = text.toString();
  switch (edit.op) {
    case 'append': {
      const endDoc = src.lastIndexOf('\\end{document}');
      const at = endDoc >= 0 ? endDoc : src.length;
      const before = src.slice(0, at);
      const chunk = `${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${edit.markdown.trim()}\n${endDoc >= 0 ? '\n' : ''}`;
      text.insert(at, chunk);
      return;
    }
    case 'replace_text': {
      let from = 0;
      let count = 0;
      for (;;) {
        const idx = text.toString().indexOf(edit.find, from);
        if (idx < 0) break;
        text.delete(idx, edit.find.length);
        text.insert(idx, edit.replace);
        count += 1;
        from = idx + edit.replace.length;
        if (!edit.all) break;
      }
      if (count === 0) throw new ApiError('not_found', `源码里找不到「${edit.find.slice(0, 40)}」`);
      return;
    }
    case 'replace_all':
      text.delete(0, text.length);
      text.insert(0, edit.markdown);
      return;
    case 'insert_after_heading':
    case 'replace_section': {
      const sections = latexSections(src);
      const target = normHeading(edit.heading);
      const i = sections.findIndex((s) => s.heading === target);
      if (i < 0) throw new ApiError('not_found', `源码里没有小节「${target}」`);
      const s = sections[i]!;
      const next = sections.slice(i + 1).find((x) => x.level <= s.level);
      const endDoc = src.lastIndexOf('\\end{document}');
      const end = next ? next.offset : endDoc >= 0 ? endDoc : src.length;
      const body = `${edit.markdown.trim()}\n\n`;
      if (edit.op === 'insert_after_heading') text.insert(end, body);
      else {
        text.delete(s.bodyStart, end - s.bodyStart);
        text.insert(s.bodyStart, `\n${body}`);
      }
      return;
    }
    default:
      throw unsupported('latex', edit.op);
  }
}

interface LatexSection {
  heading: string;
  level: number;
  offset: number;
  bodyStart: number;
}

const LATEX_LEVEL: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3 };

function latexSections(src: string): LatexSection[] {
  const out: LatexSection[] = [];
  const re = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/gu;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // 跳过注释行
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (src.slice(lineStart, m.index).includes('%')) continue;
    out.push({
      heading: normHeading(m[2] ?? ''),
      level: LATEX_LEVEL[m[1]!] ?? 1,
      offset: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 表格（sheet）

export { colName };

export function parseA1(ref: string): { r: number; c: number } {
  const m = /^([A-Z]{1,3})([1-9][0-9]*)$/u.exec(ref.toUpperCase());
  if (!m) throw new ApiError('validation_failed', `单元格地址不对：${ref}`);
  let c = 0;
  for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

/** 与前端表格编辑器的上限一致（sheet-model.ts） */
export { SHEET_MAX };

/** CSV 一行一行解析（支持引号、转义引号、引号内换行） */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = src.replace(/\r\n?/gu, '\n');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',' || ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** markdown 表格或 CSV → 二维数组；带行列号的表格（本服务导出的格式）去掉行号列 */
export function parseGrid(src: string): string[][] {
  const lines = src.trim().split(/\r?\n/u);
  const tableLines = lines.filter((l) => /^\s*\|.*\|\s*$/u.test(l));
  if (tableLines.length >= 2) {
    const rows = tableLines
      .filter((l) => !/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/u.test(l))
      .map((l) =>
        l
          .trim()
          .replace(/^\|/u, '')
          .replace(/\|$/u, '')
          .split(/(?<!\\)\|/u)
          .map((c) => c.trim().replace(/\\\|/gu, '|')),
      );
    // 读出来原样写回：`|   | A | B |` 表头 + 每行首格行号 → 去掉
    const head = rows[0] ?? [];
    const numbered =
      head[0] === '' &&
      head.slice(1).every((h, i) => h === colName(i)) &&
      rows.slice(1).every((r, i) => r[0] === String(i + 1));
    if (numbered && head.length > 1) return rows.slice(1).map((r) => r.slice(1));
    return rows;
  }
  return parseCsv(src);
}

function toInputs(grid: string[][], r0: number): CellInput[] {
  const out: CellInput[] = [];
  grid.forEach((row, r) => row.forEach((value, c) => out.push({ r: r0 + r, c, value })));
  return out;
}

function sheetError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SheetEditError) throw new ApiError('validation_failed', e.message);
    throw e;
  }
}

function applySheetEdit(doc: Y.Doc, edit: DocumentEdit): void {
  sheetError(() => {
    if (edit.op === 'set_cells') {
      const parsed = edit.cells.map((cell) => ({ ...parseA1(cell.ref), value: cell.value }));
      const sheet = sheetForEdit(doc, edit.sheet, true);
      writeCells(doc, sheet, parsed);
      return;
    }
    if (edit.op === 'replace_all' || edit.op === 'append') {
      for (const section of splitSheetSections(edit.markdown)) {
        const grid = parseGrid(section.body);
        const sheet = sheetForEdit(doc, section.name, true);
        const r0 = edit.op === 'append' ? nextFreeRow(sheet) : 0;
        if (edit.op === 'replace_all') clearSheet(doc, sheet);
        writeCells(doc, sheet, toInputs(grid, r0));
      }
      return;
    }
    throw unsupported('sheet', edit.op);
  });
}

// ---------------------------------------------------------------- 幻灯片（slides）：见 slides.ts

export { parseSlidesMarkdown } from './slides';

// ---------------------------------------------------------------- 通用入口

function unsupported(kind: DocumentKind, op: string): ApiError {
  return new ApiError('bad_request', `${kind} 类型的文档不支持 ${op} 操作`);
}

/** 新建文档时写入初始内容 */
export function initContent(
  doc: Y.Doc,
  kind: DocumentKind,
  markdown: string | undefined,
  title: string,
) {
  doc.transact(() => {
    if (kind === 'doc') {
      if (markdown?.trim()) fragment(doc).insert(0, markdownToYNodes(markdown));
    } else if (kind === 'latex') {
      latexText(doc).insert(0, markdown?.trim() ? markdown : defaultLatex(title));
    } else if (kind === 'sheet') {
      ensureWorkbook(doc);
      if (markdown?.trim()) applySheetEdit(doc, { op: 'replace_all', markdown });
    } else {
      initSlides(doc, markdown, title);
    }
  });
}

function defaultLatex(title: string): string {
  return [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '',
    `\\title{${title || 'Untitled'}}`,
    '\\author{}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\section{Introduction}',
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

/** 应用一次结构化编辑（调用方负责 transact） */
export function applyEdit(doc: Y.Doc, kind: DocumentKind, edit: DocumentEdit): void {
  if (kind === 'doc') applyDocEdit(doc, edit);
  else if (kind === 'latex') applyLatexEdit(doc, edit);
  else if (kind === 'sheet') applySheetEdit(doc, edit);
  else applySlidesEdit(doc, edit);
}

export function toMarkdown(doc: Y.Doc, kind: DocumentKind): string {
  if (kind === 'doc') return pmToMarkdown(docJson(doc));
  if (kind === 'latex') return latexText(doc).toString();
  if (kind === 'sheet') return sheetToMarkdown(doc);
  return slidesToMarkdown(doc);
}

export function outlineOf(doc: Y.Doc, kind: DocumentKind): DocumentOutlineItem[] {
  if (kind === 'doc') {
    return (docJson(doc).content ?? [])
      .filter((n) => n.type === 'heading')
      .map((n) => ({ heading: pmText(n).trim(), level: Math.min(6, Number(n.attrs?.level ?? 1)) }))
      .filter((h) => h.heading);
  }
  if (kind === 'latex') {
    return latexSections(latexText(doc).toString()).map((s) => ({
      heading: s.heading,
      level: s.level,
    }));
  }
  if (kind === 'slides') {
    return slidesOutline(doc);
  }
  // 表格：多张工作表时列出可见的表名
  const sheets = listSheets(doc).filter((s) => !s.hidden);
  return sheets.length > 1 ? sheets.map((s) => ({ heading: s.name, level: 1 })) : [];
}

/** 用 source 的内容整体替换 target（版本恢复），作为一次 Yjs 更新 */
export function replaceContent(target: Y.Doc, source: Y.Doc, kind: DocumentKind) {
  target.transact(() => {
    if (kind === 'doc') {
      const t = fragment(target);
      if (t.length) t.delete(0, t.length);
      t.insert(
        0,
        fragment(source)
          .toArray()
          .map((n) => (n as Y.XmlElement).clone()),
      );
      // 页面设置（纸张、页边距）也恢复到该版本
      const tp = target.getMap<unknown>(DOC_PAGE_FIELD);
      const sp = source.getMap<unknown>(DOC_PAGE_FIELD);
      for (const key of [...tp.keys()]) if (!sp.has(key)) tp.delete(key);
      sp.forEach((v, key) => tp.set(key, v));
    } else if (kind === 'latex') {
      const t = latexText(target);
      t.delete(0, t.length);
      t.insert(0, latexText(source).toString());
      // 辅助文件（references.bib 等）与图片引用也恢复到该版本
      const tf = target.getMap<Y.Text>(LATEX_YDOC.files);
      const sf = source.getMap<Y.Text>(LATEX_YDOC.files);
      for (const key of [...tf.keys()]) if (!sf.has(key)) tf.delete(key);
      sf.forEach((v, key) => {
        const content = v instanceof Y.Text ? v.toString() : String(v ?? '');
        const existing = tf.get(key);
        if (existing instanceof Y.Text) {
          // 原地替换，在线编辑者的编辑器绑定不断
          if (existing.toString() !== content) {
            existing.delete(0, existing.length);
            existing.insert(0, content);
          }
          return;
        }
        const text = new Y.Text();
        text.insert(0, content);
        tf.set(key, text);
      });
      const ta = target.getMap<unknown>(LATEX_YDOC.assets);
      const sa = source.getMap<unknown>(LATEX_YDOC.assets);
      for (const key of [...ta.keys()]) if (!sa.has(key)) ta.delete(key);
      sa.forEach((v, key) => ta.set(key, v));
    } else if (kind === 'sheet') {
      replaceWorkbook(target, source);
    } else {
      replaceSlidesContent(target, source);
    }
  });
}
