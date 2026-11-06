import * as Y from 'yjs';
import { LATEX_YDOC, SHEET_YDOC, YDOC_FIELD, type DocumentKind } from '@srh/shared';
// Word 式页面设置（纸张、页边距）不算内容
import { DOC_PAGE_FIELD } from '../editors/rich/word/page';

/**
 * “空白文档”判断：新建后还没人写过内容（文档页据此显示“从文件导入”）。
 * 判断宁严勿松——导入成功后会删掉这份空白文档，只有确定没有内容时才算空白：
 * 已知字段按新建时的初始内容比对，任何不认识的非空字段（其他线程新加的结构）都算有内容。
 */

type Internal = { _map: Map<string, unknown>; _start: unknown };

function shareIsEmpty(type: unknown): boolean {
  const t = type as Internal;
  return t._start === null && t._map.size === 0;
}

function textIsBlank(t: unknown): boolean {
  if (t === undefined || t === null) return true;
  if (t instanceof Y.Text) return t.toString().trim() === '';
  return typeof t === 'string' && t.trim() === '';
}

function richIsBlank(doc: Y.Doc): boolean {
  const frag = doc.getXmlFragment(YDOC_FIELD.doc);
  return frag
    .toArray()
    .every((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph' && n.length === 0);
}

/** 新建时的 LaTeX 模板：正文里只有 \maketitle 和空的 \section{Introduction} */
export function latexSourceIsTemplate(src: string): boolean {
  const code = src
    .split('\n')
    .map((l) => l.replace(/(^|[^\\])%.*$/u, '$1'))
    .join('\n');
  const begin = code.indexOf('\\begin{document}');
  const end = code.indexOf('\\end{document}');
  if (code.trim() === '') return true;
  if (begin < 0 || end < begin) return false;
  const body = code
    .slice(begin + '\\begin{document}'.length, end)
    .replace(/\\maketitle/gu, '')
    .replace(/\\section\*?\{Introduction\}/gu, '')
    .trim();
  if (body) return false;
  const preamble = code
    .slice(0, begin)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return preamble.every((l) =>
    /^\\(documentclass(\[[^\]]*\])?\{article\}|usepackage\{amsmath\}|title\{[^}]*\}|author\{\})$/u.test(
      l,
    ),
  );
}

function latexIsBlank(doc: Y.Doc): boolean {
  if (doc.getMap(LATEX_YDOC.files).size > 0 || doc.getMap(LATEX_YDOC.assets).size > 0) return false;
  return latexSourceIsTemplate(doc.getText(YDOC_FIELD.latex).toString());
}

/** 表格 v1 的旧格式表（迁移时清空，同 editors/sheet/model/migrate.ts 的 LEGACY_FORMATS）；v2 每张表的 `sheet:<id>:<part>` 里只有这几样算“内容” */
const SHEET_LEGACY_FORMATS = 'formats';
const SHEET_CONTENT_PARTS = new Set<string>(['cells', 'fmt', 'merges']);
const SHEET_TYPE_RE = /^sheet:[^:]+:([a-z]+)$/u;

/**
 * 表格：v1（`cells` + `sheet`）只看单元格；v2 工作簿（API.md §2.7.1）只有一张表，
 * 且每张表的单元格、单元格格式、合并都是空的（行列 id、行高列宽、冻结这些不算内容）。
 */
function sheetIsBlank(doc: Y.Doc): boolean {
  if (doc.getMap(YDOC_FIELD.sheetCells).size > 0) return false;
  if (doc.getMap(SHEET_LEGACY_FORMATS).size > 0) return false;
  const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
  for (const [key, value] of meta.entries()) {
    if (key === 'rows' || key === 'cols' || key === 'migrated') continue;
    if (key === 'colWidths' && value instanceof Y.Map && value.size === 0) continue;
    return false;
  }
  const order = new Set(doc.getArray<unknown>(SHEET_YDOC.order).toArray());
  if (order.size > 1) return false;
  for (const [key, type] of doc.share) {
    const part = SHEET_TYPE_RE.exec(key)?.[1];
    if (part && SHEET_CONTENT_PARTS.has(part) && !shareIsEmpty(type)) return false;
  }
  return true;
}

function sheetFieldKnown(key: string): boolean {
  return (
    key === YDOC_FIELD.sheetCells ||
    key === YDOC_FIELD.sheetMeta ||
    key === SHEET_LEGACY_FORMATS ||
    key === SHEET_YDOC.order ||
    key === SHEET_YDOC.info ||
    key === SHEET_YDOC.styles ||
    SHEET_TYPE_RE.test(key)
  );
}

/** Y.XmlFragment / XmlElement 的纯文字（块之间换行） */
function xmlPlainText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[])
      .map((d) => (typeof d.insert === 'string' ? d.insert : ' '))
      .join('');
  }
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText || child instanceof Y.XmlElement ? xmlPlainText(child) : '',
    )
    .join('\n');
}

const squash = (s: string) => s.replace(/\s+/gu, ' ').trim();

/**
 * 幻灯片 v2 页（API.md §2.7.1）：只有占位符文本框，标题占位符为空或等于文档标题、其余占位符为空，
 * 没有背景、没有别的元素（图片 / 表格 / 自己画的形状都算内容）。
 */
function slideV2IsBlank(page: Y.Map<unknown>, title: string): boolean {
  if (page.get('bg') !== undefined && page.get('bg') !== null) return false;
  if (!textIsBlank(page.get('notes'))) return false;
  const els = page.get('elements');
  if (!(els instanceof Y.Map)) return false;
  for (const el of (els as Y.Map<unknown>).values()) {
    if (!(el instanceof Y.Map)) return false;
    const ph = el.get('ph');
    if (typeof ph !== 'string' || !ph) return false;
    const type = el.get('type');
    if (type !== 'text' && type !== 'shape') return false;
    const text = el.get('text');
    const plain = text instanceof Y.XmlFragment ? squash(xmlPlainText(text)) : '';
    if (!plain) continue;
    if (ph === 'title' && plain === squash(title)) continue;
    return false;
  }
  return true;
}

function slidesIsBlank(doc: Y.Doc, title: string): boolean {
  const slides = doc.getArray<unknown>(YDOC_FIELD.slides);
  if (slides.length > 1) return false;
  const first = slides.get(0);
  if (first === undefined) return true;
  if (!(first instanceof Y.Map)) return false;
  if (first.has('elements') || first.get('v') === 2) return slideV2IsBlank(first, title);
  for (const [key, value] of first.entries()) {
    if (key === 'id' || key === 'layout' || key === 'order') continue;
    if (key === 'title') {
      const t = value instanceof Y.Text ? value.toString().trim() : String(value ?? '').trim();
      if (t && t !== title.trim()) return false;
      continue;
    }
    if ((key === 'body' || key === 'notes') && textIsBlank(value)) continue;
    return false;
  }
  return true;
}

/**
 * 幻灯片的页面尺寸 / 主题（与 editors/slides/model/deck.ts 的 SLIDES_META_FIELD 一致；
 * 这里不直接引用，免得文档页为了判断空白就加载整个幻灯片模型。markup.test.ts 校验两边一致）
 */
const SLIDES_META_FIELD = 'slidesMeta';

const KNOWN_FIELD: Record<DocumentKind, (key: string) => boolean> = {
  doc: (key) => key === YDOC_FIELD.doc || key === DOC_PAGE_FIELD,
  latex: (key) => key === YDOC_FIELD.latex || key === LATEX_YDOC.files || key === LATEX_YDOC.assets,
  sheet: sheetFieldKnown,
  slides: (key) => key === YDOC_FIELD.slides || key === SLIDES_META_FIELD,
};

export function isBlankDoc(kind: DocumentKind, doc: Y.Doc, title: string): boolean {
  // 不认识的顶层字段只要有内容就不算空白
  for (const [key, type] of doc.share) {
    if (!KNOWN_FIELD[kind](key) && !shareIsEmpty(type)) return false;
  }
  switch (kind) {
    case 'doc':
      return richIsBlank(doc);
    case 'latex':
      return latexIsBlank(doc);
    case 'sheet':
      return sheetIsBlank(doc);
    case 'slides':
      return slidesIsBlank(doc, title);
    default:
      return false;
  }
}
