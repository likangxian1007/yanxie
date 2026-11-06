import { tr } from './i18n';
/**
 * 幻灯片 Markdown → 页草稿 → 页面元素规划。服务端（create_document / agent 写入 / REST）与前端
 * （AI 生成幻灯片、草稿预览）共用这一份，两边生成的页完全一致。纯函数：不依赖 Yjs / DOM / Node 内置模块。
 *
 * 一、分页（parseSlideDrafts）
 *  1. 单独一行 `---`（也接受 `***` / `___`）是分页符（Marp / Slidev 写法）；代码块里的不算。
 *     文档开头的 YAML front-matter（`---` + `key: value` 行 + `---`）去掉；Slidev 每页开头的
 *     front-matter（紧跟分页符的 `key: value` 行 + `---`）也去掉，其中 `layout:` 作为版式提示。
 *  2. `# 标题` / `## 标题` 也开新页。当前页还没有标题时，它就是这一页的标题（所以 `---` 后面紧跟
 *     `# 标题` 不会多出空页）。用了 `---` 分页的文档里，如果每页都以 `#` 开头，页内的 `##` 只是小标题，
 *     不再分页；`###` 及更深的标题从不分页（正文里显示成加粗段落）。
 *  3. 演讲者备注：以 `>` 开头的行（沿用原约定）；不是指令的 HTML 注释 `<!-- … -->`（Marp 约定，可跨行）；
 *     以 `Note:` / `Notes:` / `备注：` / `讲稿：` 开头的段落及其后直到页尾的内容（reveal.js 约定）。
 *  4. `<!-- layout: title|content|two-column|section -->` 显式指定版式；Marp 指令注释
 *     （`<!-- _class: lead -->`、`<!-- paginate: true -->` 等）不进页面，`_class: lead` 作为标题页提示。
 *  5. 没有任何内容的页（例如连续两个 `---`）丢掉。
 *
 * 二、版式推断（inferSlideLayout，未显式指定时；显式的 title/section 页如果带表格、图片或超过 4 行 /
 *    240 字的正文，也改成 content，保证能放映）
 *    a. 正文有独占一行的 `|||`（或 Slidev 的 `::right::`）→ two-column（`---` 不再是两栏分隔符）
 *    b. 第 1 页，没有表格 / 图片 / 列表，正文不超过 4 行 → title
 *    c. 没有正文 → 第 1 页 title，其余 section
 *    d. 其他页只有一行不超过 40 字的副标题 → title
 *    e. 其余 → content
 *
 * 三、元素规划（planSlide，单位 pt，页面默认 960×540；占位符位置与前端 model/themes.ts 的母版一致）
 *    - 正文转成富文本（段落、多级列表、加粗 / 斜体 / 删除线 / 行内代码 / 链接，不留字面标记）；
 *      字号从版式默认值逐级缩小（最小 14pt）直到放得下，再放不下就按块拆成「（续）」页。
 *    - Markdown 表格转成 table 元素：单元格去掉行内标记（含加粗的单元格整格加粗），表头加粗；
 *      按内容分配列宽、按页面高度缩小字号与行高；数据行超过 12 行时拆成多页，续页重复表头。
 *    - 独占一行的图片 `![说明](地址)`：http(s) / 站内绝对路径 / data URL 生成图片元素；
 *      相对路径等无法访问的地址生成一个虚线框占位说明；`![bg](地址)` 作为背景图。
 *    - 只有表格（和图片）的页用 title-only，图文页用 image-text，其余用 content。
 */

// ---------------------------------------------------------------- 类型

export type SlideDraftLayout = 'title' | 'content' | 'two-column' | 'section';
export const SLIDE_DRAFT_LAYOUTS: readonly SlideDraftLayout[] = [
  'title',
  'content',
  'two-column',
  'section',
];

export interface SlideDraft {
  title: string;
  body: string;
  notes: string;
  layout: SlideDraftLayout;
}

/** Tiptap / ProseMirror JSON 子集（与前后端 richtext 的 PmNode 结构相同） */
export interface SlidePmMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface SlidePmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: SlidePmNode[];
  text?: string;
  marks?: SlidePmMark[];
}

export type PlannedLayout = SlideDraftLayout | 'title-only' | 'image-text';

export interface PlannedTextStyle {
  fontSize: number;
  color: string;
  fontFamily: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface PlannedText {
  type: 'text' | 'shape';
  /** 元素 id 的后缀（页内唯一：title / subtitle / body / body2 / bar / t2 / tbl1 / img1 …） */
  key: string;
  ph: 'title' | 'subtitle' | 'body' | null;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  style?: PlannedTextStyle;
  valign?: 'top' | 'middle' | 'bottom';
  doc: SlidePmNode;
  fill?: { type: 'color'; color: string } | null;
  stroke?: { color: string; width: number; dash?: 'solid' | 'dash' | 'dot' } | null;
}

export interface PlannedCell {
  text: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface PlannedTable {
  type: 'table';
  key: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  colW: number[];
  rowH: number[];
  style: { fontSize: number; color: string; fontFamily: string };
  header: boolean;
  cells: PlannedCell[][];
}

export interface PlannedImage {
  type: 'image';
  key: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  fit: 'contain';
}

export type PlannedElement = PlannedText | PlannedTable | PlannedImage;

export interface PlannedSlide {
  layout: PlannedLayout;
  title: string;
  notes: string;
  bg: { type: 'image'; src: string } | null;
  elements: PlannedElement[];
}

export interface SlidePageSize {
  width: number;
  height: number;
}

export const SLIDE_PAGE_SIZE: SlidePageSize = { width: 960, height: 540 };
/** 一页表格最多放的数据行（不含表头），超过就拆成续页 */
export const SLIDE_TABLE_MAX_ROWS = 12;

// ---------------------------------------------------------------- 行级语法

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HR = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/u;
const DASHES = /^---[ \t]*$/u;
const HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const COLUMN_SPLIT = /^\s*(?:\|\|\||::right::)\s*$/u;
const LAYOUT_MARK = /^layout:\s*(title|content|two-column|section)\s*$/u;
const LIST_ITEM = /^([ \t]*)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/u;
const NOTE_START =
  /^(?:\*\*|__)?(?:notes?|speaker\s*notes?|备注|讲稿|演讲者备注|演讲备注)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/iu;
const YAML_KEY = /^[A-Za-z_][\w-]*[ \t]*:(?:[ \t].*)?$/u;
const YAML_MORE = /^(?:[ \t]+\S.*|-[ \t].*|#.*)$/u;
const IMAGE_ONLY_LINE = /^\s*(?:!\[[^\]\n]*\]\([^)\n]*\)\s*)+$/u;
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"'\n]*["'])?\s*\)/gu;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/u;

/** Marp / Marpit 的指令名（注释里写这些的是指令，不是备注） */
const MARP_DIRECTIVES = new Set([
  'theme',
  'paginate',
  'header',
  'footer',
  'class',
  'backgroundcolor',
  'backgroundimage',
  'backgroundposition',
  'backgroundrepeat',
  'backgroundsize',
  'color',
  'size',
  'style',
  'headingdivider',
  'math',
  'title',
  'description',
  'author',
  'image',
  'keywords',
  'url',
  'marp',
  'transition',
  'lang',
  'inlinesvg',
  'layout',
  'fit',
]);

function slidevLayout(v: string): SlideDraftLayout | null {
  const s = v.trim().toLowerCase();
  if (['cover', 'intro', 'center', 'end', 'fact', 'statement', 'title', 'lead'].includes(s))
    return 'title';
  if (s === 'section') return 'section';
  if (s === 'two-cols' || s === 'two-cols-header' || s === 'two-column') return 'two-column';
  if (s === 'content' || s === 'default') return 'content';
  return null;
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && (lines[a] ?? '').trim() === '') a += 1;
  while (b > a && (lines[b - 1] ?? '').trim() === '') b -= 1;
  return lines.slice(a, b);
}

function stripOuterFence(text: string): string {
  const t = text.trim();
  if (!/^```(?:markdown|md|marp)?\s*\n/iu.test(t) || !/\n```\s*$/u.test(t)) return text;
  const lines = t.split('\n');
  lines.shift();
  lines.pop();
  return lines.join('\n');
}

/** lines[start] 起是不是一段 YAML（直到单独一行 `---`）；是则返回结束的 `---` 下标 */
function yamlBlockEnd(lines: string[], start: number): number {
  if (!YAML_KEY.test(lines[start] ?? '')) return -1;
  for (let j = start + 1; j < Math.min(lines.length, start + 40); j += 1) {
    const l = lines[j] ?? '';
    if (DASHES.test(l)) return j;
    if (!YAML_KEY.test(l) && !YAML_MORE.test(l)) return -1;
  }
  return -1;
}

function yamlLayout(lines: string[]): SlideDraftLayout | null {
  for (const l of lines) {
    const m = /^layout[ \t]*:[ \t]*["']?([\w-]+)["']?/u.exec(l);
    if (m) return slidevLayout(m[1]!);
  }
  return null;
}

/** 正文行里用的「独占一行的 HR」判断（列表项 `- - -` 也算 HR，与 CommonMark 一致） */
function isHr(line: string): boolean {
  return HR.test(line);
}

// ---------------------------------------------------------------- 分页

interface RawPage {
  title: string | null;
  body: string[];
  notes: string[];
  layout: SlideDraftLayout | null;
  hint: SlideDraftLayout | null;
  inNotes: boolean;
}

const newPage = (hint: SlideDraftLayout | null = null): RawPage => ({
  title: null,
  body: [],
  notes: [],
  layout: null,
  hint,
  inNotes: false,
});

const hasContent = (p: RawPage) => p.body.some((l) => l.trim() !== '');

/** 标题里的行内标记 / 注释去掉，只留文字 */
export function slidePlainText(md: string): string {
  return slideInlineNodes(md.replace(/<!--[\s\S]*?-->/gu, ''))
    .map((n) => (n.type === 'hardBreak' ? ' ' : (n.text ?? '')))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function parseSlideDrafts(markdown: string): SlideDraft[] {
  const lines = stripOuterFence(markdown).replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;
  let firstHint: SlideDraftLayout | null = null;
  // 文档开头的 front-matter
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  if (DASHES.test(lines[i] ?? '')) {
    const end = yamlBlockEnd(lines, i + 1);
    if (end > 0) {
      firstHint = yamlLayout(lines.slice(i + 1, end));
      i = end + 1;
    }
  }
  const start = i;

  // 预扫：是否用 `---` 分页；用了的话，各段第一个标题的级别决定页内哪些标题还分页
  let hrMode = false;
  let splitLevel = 2;
  {
    let fence: string | null = null;
    const firstLevels: number[] = [];
    let seenHeading = false;
    for (let j = start; j < lines.length; j += 1) {
      const l = lines[j] ?? '';
      const f = FENCE.exec(l);
      if (fence) {
        if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
        continue;
      }
      if (f) {
        fence = f[1]!;
        continue;
      }
      if (isHr(l)) {
        hrMode = true;
        seenHeading = false;
        if (DASHES.test(l)) {
          const end = yamlBlockEnd(lines, j + 1);
          if (end > 0) j = end;
        }
        continue;
      }
      const h = HEADING.exec(l);
      if (h && !seenHeading && h[1]!.length <= 2) {
        firstLevels.push(h[1]!.length);
        seenHeading = true;
      }
    }
    if (hrMode && firstLevels.length) splitLevel = Math.max(...firstLevels);
  }

  const pages: RawPage[] = [newPage(firstHint)];
  let cur = pages[0]!;
  let fence: string | null = null;
  const pushLine = (l: string) => (cur.inNotes ? cur.notes : cur.body).push(l);

  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const f = FENCE.exec(line);
    if (fence) {
      pushLine(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      pushLine(line);
      continue;
    }
    const trimmed = line.trim();

    // 分页符（以及紧跟它的 Slidev 每页 front-matter）
    if (isHr(line)) {
      let hint: SlideDraftLayout | null = null;
      if (DASHES.test(line)) {
        const end = yamlBlockEnd(lines, i + 1);
        if (end > 0) {
          hint = yamlLayout(lines.slice(i + 1, end));
          i = end;
        }
      }
      cur = newPage(hint);
      pages.push(cur);
      continue;
    }

    // HTML 注释：版式 / 指令 / 备注
    if (trimmed.startsWith('<!--')) {
      let text = trimmed;
      while (!text.includes('-->') && i + 1 < lines.length) {
        i += 1;
        text += `\n${lines[i] ?? ''}`;
      }
      const close = text.indexOf('-->');
      const inner = text.slice(4, close < 0 ? undefined : close).trim();
      const rest = close < 0 ? '' : text.slice(close + 3).trim();
      const lm = LAYOUT_MARK.exec(inner);
      const key = /^_?([A-Za-z][\w-]*)\s*:\s*(.*)$/su.exec(inner);
      if (lm) cur.layout = lm[1] as SlideDraftLayout;
      else if (key && MARP_DIRECTIVES.has(key[1]!.toLowerCase())) {
        const k = key[1]!.toLowerCase();
        const v = key[2]!.trim();
        if (inner.startsWith('_') && k === 'class' && /\blead\b/u.test(v)) cur.hint = 'title';
        else if (k === 'layout') cur.hint = slidevLayout(v) ?? cur.hint;
      } else if (inner === 'fit') {
        // Marp 的 `<!-- fit -->`：忽略
      } else if (inner) cur.notes.push(...inner.split('\n').map((l) => l.trim()));
      if (rest) {
        // 注释后面同一行还有内容：当普通行继续处理
        lines[i] = rest;
        i -= 1;
      }
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = slidePlainText(h[2] ?? '');
      if (level <= splitLevel) {
        if (cur.title === null && (hrMode || !hasContent(cur))) {
          cur.title = text;
          continue;
        }
        cur = newPage();
        cur.title = text;
        pages.push(cur);
        continue;
      }
      pushLine(line);
      continue;
    }

    if (!cur.inNotes) {
      const note = NOTE_START.exec(trimmed);
      if (note) {
        cur.inNotes = true;
        if (note[1]) cur.notes.push(note[1]);
        continue;
      }
      if (trimmed.startsWith('>')) {
        cur.notes.push(trimmed.replace(/^>\s?/u, ''));
        continue;
      }
    }
    pushLine(cur.inNotes ? trimmed : line.trimEnd());
  }

  const kept = pages.filter(
    (p) => p.title !== null || hasContent(p) || p.notes.some((l) => l.trim() !== ''),
  );
  return kept.map((p, index) => {
    const body = trimBlank(p.body).join('\n');
    const inferred = inferSlideLayout(index, body, p.hint);
    return {
      title: p.title ?? '',
      body,
      notes: trimBlank(p.notes).join('\n'),
      layout: p.layout ? normalizeSlideLayout(p.layout, body) : inferred,
    };
  });
}

// ---------------------------------------------------------------- 正文分段（文字 / 表格 / 图片）

export interface SlideMdTable {
  header: PlannedCell[];
  rows: PlannedCell[][];
}

type Seg =
  | { kind: 'text'; md: string }
  | { kind: 'table'; table: SlideMdTable }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'missing'; src: string; alt: string }
  | { kind: 'break' };

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  let code = false;
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k]!;
    if (ch === '\\' && s[k + 1] === '|') {
      cell += '|';
      k += 1;
    } else if (ch === '`') {
      code = !code;
      cell += ch;
    } else if (ch === '|' && !code) {
      out.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

const isRowLine = (l: string) => l.includes('|') && l.trim() !== '' && !COLUMN_SPLIT.test(l);
const isPipeRow = (l: string) => /^\s*\|.*\|\s*$/u.test(l) && !COLUMN_SPLIT.test(l);

function cellOf(raw: string, align?: PlannedCell['align']): PlannedCell {
  const nodes = slideInlineNodes(raw);
  const text = nodes
    .map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? '')))
    .join('')
    .trim();
  const bold = nodes.some((n) => n.marks?.some((m) => m.type === 'bold'));
  const c: PlannedCell = { text };
  if (bold) c.bold = true;
  if (align) c.align = align;
  return c;
}

/** 从 lines[i] 起解析一张表；不是表时返回 null */
function readTable(lines: string[], i: number): { table: SlideMdTable; next: number } | null {
  const first = lines[i] ?? '';
  const second = lines[i + 1] ?? '';
  let rowsRaw: string[] = [];
  let aligns: Array<PlannedCell['align']> = [];
  let j: number;
  if (isRowLine(first) && TABLE_DELIM.test(second) && second.includes('|')) {
    aligns = splitRow(second).map((c) => {
      const l = c.startsWith(':');
      const r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : undefined;
    });
    rowsRaw = [first];
    j = i + 2;
    while (j < lines.length && isRowLine(lines[j] ?? '') && !TABLE_DELIM.test(lines[j] ?? ''))
      rowsRaw.push(lines[j++]!);
  } else if (isPipeRow(first) && isPipeRow(second)) {
    // 没有分隔行的「表格」：连续的 `| … |` 行，第一行当表头
    j = i;
    while (j < lines.length && isPipeRow(lines[j] ?? '')) {
      if (!TABLE_DELIM.test(lines[j] ?? '')) rowsRaw.push(lines[j]!);
      j += 1;
    }
  } else return null;
  const grid = rowsRaw.map(splitRow);
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const norm = (r: string[]) =>
    Array.from({ length: cols }, (_, c) => cellOf(r[c] ?? '', aligns[c]));
  return { table: { header: norm(grid[0] ?? []), rows: grid.slice(1).map(norm) }, next: j };
}

const VALID_SRC = /^(?:https?:\/\/|\/(?!\/)|data:image\/)/iu;

function segmentBody(body: string): { segs: Seg[]; bg: string | null } {
  const lines = body.replace(/\r\n?/gu, '\n').split('\n');
  const segs: Seg[] = [];
  let text: string[] = [];
  let bg: string | null = null;
  const flush = () => {
    const t = trimBlank(text);
    if (t.length) segs.push({ kind: 'text', md: t.join('\n') });
    text = [];
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const f = FENCE.exec(line);
    if (fence) {
      text.push(line);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      text.push(line);
      continue;
    }
    if (isHr(line) || COLUMN_SPLIT.test(line)) {
      text.push('');
      continue;
    }
    const t = readTable(lines, i);
    if (t) {
      flush();
      segs.push({ kind: 'table', table: t.table });
      i = t.next - 1;
      continue;
    }
    if (IMAGE_ONLY_LINE.test(line)) {
      for (const m of line.matchAll(IMAGE)) {
        const alt = m[1] ?? '';
        const src = (m[2] ?? '').trim();
        const words = alt.split(/\s+/u).filter(Boolean);
        const isBg = words[0]?.toLowerCase() === 'bg';
        const caption = words
          .filter(
            (w) =>
              !/^(?:bg|fit|contain|cover|auto|left|right|[whxy]:.*|width:.*|height:.*|\d+%)$/iu.test(
                w,
              ),
          )
          .join(' ');
        if (isBg) {
          if (VALID_SRC.test(src)) bg = src;
          continue;
        }
        flush();
        segs.push(
          VALID_SRC.test(src)
            ? { kind: 'image', src, alt: caption }
            : { kind: 'missing', src: src || tr('（未写地址）'), alt: caption },
        );
      }
      continue;
    }
    text.push(line);
  }
  flush();
  return { segs, bg };
}

interface BodyStats {
  table: boolean;
  image: boolean;
  list: boolean;
  lines: number;
  chars: number;
  longest: number;
  columns: boolean;
}

function bodyStats(body: string): BodyStats {
  const { segs } = segmentBody(body);
  const textLines = segs
    .filter((s): s is Extract<Seg, { kind: 'text' }> => s.kind === 'text')
    .flatMap((s) => s.md.split('\n'))
    .filter((l) => l.trim() !== '');
  const plain = textLines.map((l) => slidePlainText(l));
  return {
    table: segs.some((s) => s.kind === 'table'),
    image: segs.some((s) => s.kind === 'image' || s.kind === 'missing'),
    list: textLines.some((l) => LIST_ITEM.test(l) && !isHr(l)),
    lines: textLines.length,
    chars: plain.reduce((a, l) => a + l.length, 0),
    longest: Math.max(0, ...plain.map((l) => l.length)),
    columns: body.split('\n').some((l) => COLUMN_SPLIT.test(l)),
  };
}

/** 显式写的 title / section：内容太多（表格、图片、超过 4 行或 240 字的正文）时改成 content */
export function normalizeSlideLayout(layout: SlideDraftLayout, body: string): SlideDraftLayout {
  if (layout !== 'title' && layout !== 'section') return layout;
  const s = bodyStats(body);
  if (s.table || s.image || s.lines > 4 || s.chars > 240) return 'content';
  return layout;
}

/** 规则二 */
export function inferSlideLayout(
  index: number,
  body: string,
  hint: SlideDraftLayout | null = null,
): SlideDraftLayout {
  const s = bodyStats(body);
  if (s.columns) return 'two-column';
  const plain = !s.table && !s.image && !s.list;
  if (hint && hint !== 'content') {
    if (hint === 'two-column') return 'content';
    if (plain && s.lines <= 4 && s.chars <= 240) return hint;
  }
  if (s.lines === 0 && !s.table && !s.image) return index === 0 ? 'title' : 'section';
  if (index === 0 && plain && s.lines <= 4 && s.chars <= 240) return 'title';
  if (index > 0 && plain && s.lines === 1 && s.longest <= 40) return 'title';
  return 'content';
}

/** 两栏：按第一行 `|||` / `::right::`（legacy=true 时也认 `---`）切成左右两栏 */
export function splitSlideColumns(body: string, legacy = false): [string, string] {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => COLUMN_SPLIT.test(l) || (legacy && /^\s*---\s*$/u.test(l)));
  if (idx < 0) return [body, ''];
  return [trimBlank(lines.slice(0, idx)).join('\n'), trimBlank(lines.slice(idx + 1)).join('\n')];
}

// ---------------------------------------------------------------- 行内 markdown → PM

const INLINE = new RegExp(
  [
    '\\\\([\\\\`*_{}\\[\\]()#+\\-.!|~$<>])', // 1 转义
    '(\\$\\$?)([^$\\n]+?)\\2', // 2,3 公式（原样保留）
    '(`+)([^`][\\s\\S]*?)\\4(?!`)', // 4,5 行内代码
    '!\\[([^\\]\\n]*)\\]\\(([^)\\n]*)\\)', // 6,7 行内图片 → 说明文字
    '\\[([^\\]\\n]+)\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+["\'][^"\'\\n]*["\'])?\\s*\\)', // 8,9 链接
    '\\*\\*\\*(?=\\S)([^*]+?)\\*\\*\\*', // 10 粗斜体
    '\\*\\*(?=\\S)(.+?)\\*\\*', // 11 粗体
    '(?<![\\w])__(?=\\S)(.+?)__(?!\\w)', // 12 粗体
    '~~(?=\\S)(.+?)~~', // 13 删除线
    '(?<![\\w*\\\\])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?!\\*)', // 14 斜体
    '(?<![\\w\\\\])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?![\\w])', // 15 斜体
    '(<br\\s*\\/?>)', // 16 换行
    '(<\\/?[A-Za-z][\\w-]*(?:\\s[^<>]*)?\\/?>)', // 17 其他 HTML 标签：去掉
  ].join('|'),
  'gu',
);

function withMark(nodes: SlidePmNode[], mark: SlidePmMark): SlidePmNode[] {
  return nodes.map((n) =>
    n.type === 'text'
      ? {
          ...n,
          marks: [...(n.marks ?? []).filter((m) => m.type !== mark.type), mark],
        }
      : n,
  );
}

/** 行内 markdown → PM 行内节点（text / hardBreak），不留字面标记 */
export function slideInlineNodes(src: string): SlidePmNode[] {
  const out: SlidePmNode[] = [];
  const text = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && !prev.marks) prev.text += t;
    else out.push({ type: 'text', text: t });
  };
  let last = 0;
  INLINE.lastIndex = 0;
  const matches = [...src.matchAll(INLINE)];
  for (const m of matches) {
    const at = m.index ?? 0;
    if (at > last) text(src.slice(last, at));
    last = at + m[0].length;
    if (m[1] !== undefined) text(m[1]);
    else if (m[2] !== undefined) text(m[0]);
    else if (m[4] !== undefined) {
      const code = m[5]!.replace(/^ (.+) $/su, '$1');
      out.push({ type: 'text', text: code, marks: [{ type: 'code' }] });
    } else if (m[6] !== undefined) text(m[6] || tr('图片'));
    else if (m[8] !== undefined) {
      const href = m[9]!;
      const inner = slideInlineNodes(m[8]);
      out.push(
        ...(/^(?:https?:|mailto:|\/)/iu.test(href)
          ? withMark(inner, { type: 'link', attrs: { href } })
          : inner),
      );
    } else if (m[10] !== undefined)
      out.push(
        ...withMark(withMark(slideInlineNodes(m[10]), { type: 'bold' }), { type: 'italic' }),
      );
    else if (m[11] !== undefined) out.push(...withMark(slideInlineNodes(m[11]), { type: 'bold' }));
    else if (m[12] !== undefined) out.push(...withMark(slideInlineNodes(m[12]), { type: 'bold' }));
    else if (m[13] !== undefined)
      out.push(...withMark(slideInlineNodes(m[13]), { type: 'strike' }));
    else if (m[14] !== undefined)
      out.push(...withMark(slideInlineNodes(m[14]), { type: 'italic' }));
    else if (m[15] !== undefined)
      out.push(...withMark(slideInlineNodes(m[15]), { type: 'italic' }));
    else if (m[16] !== undefined) out.push({ type: 'hardBreak' });
    // m[17]：HTML 标签，丢掉
  }
  if (last < src.length) text(src.slice(last));
  // 相邻同格式的文字合并
  const merged: SlidePmNode[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === 'text' &&
      n.type === 'text' &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
    )
      prev.text = `${prev.text ?? ''}${n.text ?? ''}`;
    else merged.push({ ...n });
  }
  return merged.filter((n) => n.type !== 'text' || n.text);
}

function paragraph(content: SlidePmNode[], bold = false): SlidePmNode {
  const c = bold ? withMark(content, { type: 'bold' }) : content;
  return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' };
}

// ---------------------------------------------------------------- 正文块 markdown → PM

/**
 * 正文 markdown → PM doc：段落（相邻行用换行连接）、多级 `- ` / `* ` / `1. ` 列表（缩进层级按实际缩进
 * 推断，2 格或 4 格都行）、`#…` 标题当加粗段落、``` 代码块（等宽字体段落）；`---` 分隔线丢掉。
 */
export function markdownToSlideDoc(md: string): SlidePmNode {
  const content: SlidePmNode[] = [];
  const lines = md.replace(/\r\n?/gu, '\n').split('\n');
  let para: string[] = [];
  let stack: Array<{ indent: number; list: SlidePmNode }> = [];
  let lastItem: SlidePmNode | null = null;
  let blankSince = false;
  const flushPara = () => {
    if (para.length) {
      const nodes: SlidePmNode[] = [];
      para.forEach((l, k) => {
        if (k > 0) nodes.push({ type: 'hardBreak' });
        nodes.push(...slideInlineNodes(l));
      });
      content.push(paragraph(nodes));
    }
    para = [];
  };
  const endLists = () => {
    stack = [];
    lastItem = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').replace(/\t/gu, '    ');
    const f = FENCE.exec(raw);
    if (f) {
      flushPara();
      endLists();
      const mark = f[1]!;
      const code: string[] = [];
      for (i += 1; i < lines.length; i += 1) {
        const l = lines[i] ?? '';
        const c = FENCE.exec(l);
        if (c && c[1]![0] === mark[0] && c[1]!.length >= mark.length) break;
        code.push(l);
      }
      const nodes: SlidePmNode[] = [];
      code.forEach((l, k) => {
        if (k > 0) nodes.push({ type: 'hardBreak' });
        if (l) nodes.push({ type: 'text', text: l, marks: [{ type: 'code' }] });
      });
      if (nodes.some((n) => n.type === 'text')) content.push({ type: 'paragraph', content: nodes });
      continue;
    }
    if (raw.trim() === '') {
      flushPara();
      blankSince = true;
      continue;
    }
    if (isHr(raw) || COLUMN_SPLIT.test(raw)) {
      flushPara();
      endLists();
      continue;
    }
    const li = LIST_ITEM.exec(raw);
    if (li) {
      flushPara();
      const indent = li[1]!.length;
      const ordered = li[3] !== undefined;
      const type = ordered ? 'orderedList' : 'bulletList';
      while (stack.length && indent < stack[stack.length - 1]!.indent) stack.pop();
      const top = stack[stack.length - 1];
      const item: SlidePmNode = {
        type: 'listItem',
        content: [paragraph(slideInlineNodes(li[4] ?? ''))],
      };
      const newList = (): SlidePmNode => {
        const l: SlidePmNode = { type, content: [] };
        const n = Number(li[3]);
        if (ordered && n !== 1) l.attrs = { start: n };
        return l;
      };
      if (!top) {
        const l = newList();
        content.push(l);
        stack = [{ indent, list: l }];
      } else if (indent > top.indent + 1) {
        const parentItem = top.list.content?.[top.list.content.length - 1];
        const l = newList();
        if (parentItem) (parentItem.content ??= []).push(l);
        else content.push(l);
        stack.push({ indent, list: l });
      } else if (top.list.type !== type) {
        // 同一级换了列表类型：新开一个兄弟列表
        const l = newList();
        const parent = stack[stack.length - 2];
        const parentItem = parent?.list.content?.[parent.list.content.length - 1];
        if (parentItem) (parentItem.content ??= []).push(l);
        else content.push(l);
        stack[stack.length - 1] = { indent: top.indent, list: l };
      }
      stack[stack.length - 1]!.list.content!.push(item);
      lastItem = item;
      blankSince = false;
      continue;
    }
    const h = HEADING.exec(raw);
    if (h) {
      flushPara();
      endLists();
      content.push(paragraph(slideInlineNodes(h[2] ?? ''), true));
      blankSince = false;
      continue;
    }
    // 列表项的续行（紧跟着，或缩进的）
    const indented = /^\s{2,}/u.test(raw);
    if (lastItem && (!blankSince || indented)) {
      const p = lastItem.content?.[0];
      if (p) (p.content ??= []).push({ type: 'hardBreak' }, ...slideInlineNodes(raw.trim()));
      blankSince = false;
      continue;
    }
    endLists();
    para.push(raw.trim());
    blankSince = false;
  }
  flushPara();
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}

// ---------------------------------------------------------------- 估算文字尺寸

const LH = 1.2;
const TABLE_LH = 1.3;
const PAD_X = 14.4;
const PAD_Y = 7.2;
const CELL_PAD_X = 10.8;
const CELL_PAD_Y = 7.2;
const GAP = 12;

function charEm(cp: number): number {
  if (cp === 32) return 0.3;
  if (cp < 0x7f) {
    if (cp >= 65 && cp <= 90) return 0.66;
    if (cp >= 48 && cp <= 57) return 0.56;
    if (cp === 105 || cp === 108 || cp === 106 || cp === 46 || cp === 44 || cp === 39) return 0.3;
    if (cp === 109 || cp === 119) return 0.85;
    return 0.54;
  }
  if (cp < 0x2e80) return cp >= 0x2010 && cp <= 0x2027 ? 0.9 : 0.6;
  return 1;
}

function textWidth(s: string, f: number): number {
  let w = 0;
  for (const ch of s) w += charEm(ch.codePointAt(0) ?? 0);
  return w * f * 1.05;
}

function lineCount(s: string, f: number, width: number): number {
  if (width <= f) return Math.max(1, s.length);
  return s
    .split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil((textWidth(l, f) + f * 0.3) / width)), 0);
}

function inlinePlain(nodes: SlidePmNode[] | undefined): string {
  return (nodes ?? []).map((n) => (n.type === 'hardBreak' ? '\n' : (n.text ?? ''))).join('');
}

/** PM doc 在给定字号、文字区宽度下的高度（与 slides.css：段落无外边距、列表缩进 1.3em、项间 0.2em 一致） */
export function slideDocHeight(doc: SlidePmNode, f: number, width: number): number {
  let h = 0;
  const lineH = f * LH;
  const list = (l: SlidePmNode, level: number) => {
    (l.content ?? []).forEach((item, idx) => {
      if (idx > 0) h += 0.2 * f;
      for (const c of item.content ?? []) {
        if (c.type === 'paragraph')
          h += lineCount(inlinePlain(c.content), f, width - 1.3 * f * (level + 1)) * lineH;
        else if (c.type === 'bulletList' || c.type === 'orderedList') {
          h += 0.2 * f;
          list(c, level + 1);
        }
      }
    });
  };
  for (const n of doc.content ?? []) {
    if (n.type === 'paragraph') h += lineCount(inlinePlain(n.content), f, width) * lineH;
    else if (n.type === 'bulletList' || n.type === 'orderedList') list(n, 0);
  }
  return h;
}

const boxHeight = (doc: SlidePmNode, f: number, w: number) =>
  slideDocHeight(doc, f, w - PAD_X) + PAD_Y + 4;

interface TableFit {
  colW: number[];
  rowH: number[];
  h: number;
}

function fitTable(t: SlideMdTable, f: number, width: number): TableFit {
  const rows = [t.header, ...t.rows];
  const cols = t.header.length;
  const longest = (c: PlannedCell, bold: boolean) =>
    Math.max(0, ...c.text.split('\n').map((l) => textWidth(l, f) * (bold ? 1.06 : 1)));
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(
      f * 2.5,
      ...rows.map(
        (r, ri) => longest(r[c] ?? { text: '' }, ri === 0 || !!r[c]?.bold) + CELL_PAD_X + 4,
      ),
    ),
  );
  const sum = natural.reduce((a, b) => a + b, 0);
  let colW: number[];
  if (sum <= width) colW = natural.map((n) => (n * width) / sum);
  else {
    // 水位分配：窄列按需要给，剩下的宽列平分
    colW = new Array<number>(cols).fill(0);
    let rest = width;
    let open = natural.map((_, k) => k);
    for (;;) {
      const share = rest / Math.max(1, open.length);
      const fixed = open.filter((k) => natural[k]! <= share);
      if (!fixed.length) {
        for (const k of open) colW[k] = share;
        break;
      }
      for (const k of fixed) {
        colW[k] = natural[k]!;
        rest -= natural[k]!;
      }
      open = open.filter((k) => !fixed.includes(k));
      if (!open.length) break;
    }
  }
  colW = colW.map((w) => Math.round(w * 10) / 10);
  const rowH = rows.map((r) => {
    const lines = Math.max(
      1,
      ...r.map((c, k) => lineCount(c.text, f * 1.03, Math.max(1, (colW[k] ?? 0) - CELL_PAD_X - 2))),
    );
    return Math.round((lines * f * TABLE_LH + CELL_PAD_Y + 2) * 10) / 10;
  });
  return { colW, rowH, h: rowH.reduce((a, b) => a + b, 0) };
}

function fitTitleFont(text: string, sizes: number[], width: number, height: number): number {
  for (const f of sizes) {
    if (lineCount(text, f * 1.04, width - PAD_X) * f * LH + PAD_Y <= height) return f;
  }
  return sizes[sizes.length - 1]!;
}

// ---------------------------------------------------------------- 规划

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function boxOf(size: SlidePageSize, fx: number, fy: number, fw: number, fh: number): Region {
  return {
    x: r1(size.width * fx),
    y: r1(size.height * fy),
    w: r1(size.width * fw),
    h: r1(size.height * fh),
  };
}

const TEXT_STEPS = [22, 20, 18, 17, 16, 15, 14];
const TABLE_STEPS = [18, 16, 15, 14, 13, 12, 11];
const steps = (base: number) => [base, ...TEXT_STEPS.filter((s) => s < base)];
const IMAGE_MIN = 120;
const MISSING_H = 84;

const textStyle = (fontSize: number, extra: Partial<PlannedTextStyle> = {}): PlannedTextStyle => ({
  fontSize,
  color: 'theme:fg',
  fontFamily: 'theme:body',
  ...extra,
});

function titleEl(
  key: string,
  b: Region,
  text: string,
  size: number,
  align: 'left' | 'center',
  valign: 'middle' | 'bottom' | 'top',
): PlannedText {
  return {
    type: 'text',
    key,
    ph: 'title',
    name: tr('标题'),
    ...b,
    style: textStyle(size, { fontFamily: 'theme:title', bold: true, align }),
    valign,
    doc: {
      type: 'doc',
      content: [
        text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' },
      ],
    },
  };
}

function missingDoc(src: string, alt: string): SlidePmNode {
  return {
    type: 'doc',
    content: [
      paragraph([
        {
          type: 'text',
          text: tr('图片未找到：{value}', {
            value: alt ? tr('{alt}（{src}）', { alt, src }) : src,
          }),
        },
      ]),
      paragraph([{ type: 'text', text: tr('请把图片上传到项目文件，再在编辑器里插入') }]),
    ],
  };
}

interface Placed {
  els: PlannedElement[];
  ok: boolean;
}

/** 在一个区域里自上而下放一组段落 / 表格 / 图片，字号逐级缩小直到放得下 */
function flow(
  segs: Seg[],
  region: Region,
  baseText: number,
  firstBodyKey: { key: string; ph: 'body' | null },
  counter: { n: number },
  force: boolean,
): Placed {
  const textSizes = steps(baseText);
  const n = Math.max(textSizes.length, TABLE_STEPS.length);
  const docs = segs.map((s) => (s.kind === 'text' ? markdownToSlideDoc(s.md) : null));
  const onlyText = segs.length === 1 && segs[0]!.kind === 'text';
  const nFlex = segs.filter((s) => s.kind === 'image').length;
  for (let k = 0; k < n; k += 1) {
    const ft = textSizes[Math.min(k, textSizes.length - 1)]!;
    const fb = TABLE_STEPS[Math.min(k, TABLE_STEPS.length - 1)]!;
    const heights = segs.map((s, idx) => {
      if (s.kind === 'text') return boxHeight(docs[idx]!, ft, region.w);
      if (s.kind === 'table') return fitTable(s.table, fb, region.w).h;
      if (s.kind === 'missing') return MISSING_H;
      return 0;
    });
    const gaps = GAP * Math.max(0, segs.length - 1);
    const fixed = heights.reduce((a, b) => a + b, 0) + gaps;
    const last = k === n - 1;
    if (fixed + nFlex * IMAGE_MIN > region.h && !(last && force)) continue;
    const imgH = nFlex ? Math.max(IMAGE_MIN, (region.h - fixed) / nFlex) : 0;
    const els: PlannedElement[] = [];
    let y = region.y;
    let textNo = 0;
    segs.forEach((s, idx) => {
      if (s.kind === 'text') {
        const first = textNo === 0;
        textNo += 1;
        const h = onlyText ? region.h : Math.min(heights[idx]!, region.y + region.h - y);
        els.push({
          type: 'text',
          key: first ? firstBodyKey.key : `t${++counter.n}`,
          ph: first ? firstBodyKey.ph : null,
          name: first ? tr('正文') : tr('文本'),
          x: region.x,
          y: r1(y),
          w: region.w,
          h: r1(Math.max(h, ft * LH + PAD_Y)),
          style: textStyle(ft),
          valign: 'top',
          doc: docs[idx]!,
        });
        y += heights[idx]! + GAP;
      } else if (s.kind === 'table') {
        const t = fitTable(s.table, fb, region.w);
        els.push({
          type: 'table',
          key: `tbl${++counter.n}`,
          name: tr('表格'),
          x: region.x,
          y: r1(y),
          w: r1(t.colW.reduce((a, b) => a + b, 0)),
          h: r1(t.h),
          colW: t.colW,
          rowH: t.rowH,
          style: { fontSize: fb, color: 'theme:fg', fontFamily: 'theme:body' },
          header: true,
          cells: [
            s.table.header.map((c) => ({ ...c, bold: true })),
            ...s.table.rows.map((r) => r.map((c) => ({ ...c }))),
          ],
        });
        y += t.h + GAP;
      } else if (s.kind === 'image') {
        els.push({
          type: 'image',
          key: `img${++counter.n}`,
          name: s.alt || tr('图片'),
          x: region.x,
          y: r1(y),
          w: region.w,
          h: r1(imgH),
          src: s.src,
          fit: 'contain',
        });
        y += imgH + GAP;
      } else if (s.kind === 'missing') {
        els.push(missingEl(s, { x: region.x, y: r1(y), w: region.w, h: MISSING_H }, counter));
        y += MISSING_H + GAP;
      }
    });
    return { els, ok: fixed + nFlex * IMAGE_MIN <= region.h };
  }
  return { els: [], ok: false };
}

function missingEl(
  s: { src: string; alt: string },
  b: Region,
  counter: { n: number },
): PlannedText {
  return {
    type: 'text',
    key: `ph${++counter.n}`,
    ph: null,
    name: tr('图片占位'),
    ...b,
    style: textStyle(16, { color: 'theme:muted', align: 'center' }),
    valign: 'middle',
    doc: missingDoc(s.src, s.alt),
    stroke: { color: '#9CA3AF', width: 1, dash: 'dash' },
  };
}

/** 文字段拆成可以分页的块：段落、顶层列表项（连同子项）、标题（跟着下一块走） */
function textUnits(md: string): string[] {
  const units: string[][] = [];
  let cur: string[] = [];
  let kind: 'p' | 'li' | null = null;
  let pendingHeading: string[] = [];
  const close = () => {
    if (cur.length) {
      units.push([...pendingHeading, ...cur]);
      pendingHeading = [];
    }
    cur = [];
    kind = null;
  };
  let fence = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line)) {
      if (!fence) {
        close();
        kind = 'p';
      }
      fence = !fence;
      cur.push(line);
      continue;
    }
    if (fence) {
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      if (kind === 'p') close();
      continue;
    }
    if (HEADING.test(line)) {
      close();
      pendingHeading.push(line);
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li && li[1]!.length < 2) {
      close();
      kind = 'li';
      cur.push(line);
      continue;
    }
    if (kind === 'li' && (li || /^\s{2,}/u.test(line))) {
      cur.push(line);
      continue;
    }
    if (kind !== 'p') {
      close();
      kind = 'p';
    }
    cur.push(line);
  }
  close();
  if (pendingHeading.length) units.push(pendingHeading);
  return units.map((u) => u.join('\n'));
}

/** 放不下时按块拆页（续页重复表头） */
function paginate(segs: Seg[], region: Region, baseText: number): Seg[][] {
  const ft = Math.min(baseText, 16);
  const fb = 13;
  const pages: Seg[][] = [[]];
  let used = 0;
  const page = () => pages[pages.length - 1]!;
  const add = (s: Seg, h: number) => {
    if (page().length && used + GAP + h > region.h) {
      pages.push([]);
      used = 0;
    }
    used += (page().length ? GAP : 0) + h;
    const prev = page()[page().length - 1];
    if (s.kind === 'text' && prev?.kind === 'text') prev.md = `${prev.md}\n\n${s.md}`;
    else page().push(s.kind === 'text' ? { ...s } : s);
  };
  for (const s of segs) {
    if (s.kind === 'text') {
      for (const u of textUnits(s.md))
        add({ kind: 'text', md: u }, boxHeight(markdownToSlideDoc(u), ft, region.w));
    } else if (s.kind === 'table') {
      let rows = s.table.rows;
      while (rows.length) {
        const all = fitTable({ header: s.table.header, rows }, fb, region.w);
        const room = region.h - used - (page().length ? GAP : 0);
        let take = rows.length;
        let h = all.h;
        while (take > 1 && h > room) {
          take -= 1;
          h = all.rowH.slice(0, take + 1).reduce((a, b) => a + b, 0);
        }
        if (h > room && page().length) {
          pages.push([]);
          used = 0;
          continue;
        }
        if (take < rows.length && take < 2 && page().length) {
          pages.push([]);
          used = 0;
          continue;
        }
        add({ kind: 'table', table: { header: s.table.header, rows: rows.slice(0, take) } }, h);
        rows = rows.slice(take);
        if (rows.length) {
          pages.push([]);
          used = 0;
        }
      }
    } else if (s.kind === 'image') add(s, IMAGE_MIN);
    else if (s.kind === 'missing') add(s, MISSING_H);
  }
  return pages.filter((p) => p.length);
}

/** 数据行太多的表先切成几张（平均分），各占一页 */
function chunkTables(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (s.kind !== 'table' || s.table.rows.length <= SLIDE_TABLE_MAX_ROWS) {
      out.push(s);
      continue;
    }
    const n = Math.ceil(s.table.rows.length / SLIDE_TABLE_MAX_ROWS);
    const per = Math.ceil(s.table.rows.length / n);
    for (let k = 0; k < n; k += 1) {
      if (k > 0) out.push({ kind: 'break' });
      out.push({
        kind: 'table',
        table: { header: s.table.header, rows: s.table.rows.slice(k * per, (k + 1) * per) },
      });
    }
  }
  return out;
}

function clampAll(els: PlannedElement[], size: SlidePageSize): PlannedElement[] {
  return els.map((e) => {
    const x = Math.min(Math.max(0, e.x), size.width - 10);
    const y = Math.min(Math.max(0, e.y), size.height - 10);
    return {
      ...e,
      x: r1(x),
      y: r1(y),
      w: r1(Math.min(e.w, size.width - x)),
      h: r1(Math.min(e.h, size.height - y)),
    };
  });
}

export interface SlidePlanOptions {
  /** 两栏页的正文也认 `---` 分栏（旧的 SlideInput 写法） */
  legacyColumns?: boolean;
}

/** 一份草稿 → 一页或几页（太长时拆出「（续）」页）的元素规划 */
export function planSlide(
  draft: SlideDraft,
  size: SlidePageSize = SLIDE_PAGE_SIZE,
  opts: SlidePlanOptions = {},
): PlannedSlide[] {
  const title = slidePlainText(draft.title);
  const { segs, bg: bgSrc } = segmentBody(draft.body);
  const bg = bgSrc ? { type: 'image' as const, src: bgSrc } : null;
  const layout = normalizeSlideLayout(draft.layout, draft.body);
  const H = size.height;
  const counter = { n: 1 };
  const one = (l: PlannedLayout, els: PlannedElement[]): PlannedSlide[] => [
    { layout: l, title, notes: draft.notes, bg, elements: clampAll(els, size) },
  ];
  const textOnly = segs.every((s) => s.kind === 'text');
  const md = segs
    .filter((s): s is Extract<Seg, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.md)
    .join('\n\n');

  if ((layout === 'title' || layout === 'section') && textOnly) {
    const doc = markdownToSlideDoc(md);
    const isTitle = layout === 'title';
    const tBox = isTitle
      ? boxOf(size, 0.08, 0.28, 0.84, 0.22)
      : boxOf(size, 0.08, 0.43, 0.84, 0.17);
    const sBox = isTitle
      ? boxOf(size, 0.14, 0.54, 0.72, 0.16)
      : boxOf(size, 0.08, 0.61, 0.84, 0.15);
    const base = isTitle ? 22 : 20;
    // 副标题长：先往下长到页面 92% 处；标题页还可以整体往上挪（标题最高到 8%），上下各分一半
    const downRoom = Math.max(0, H * 0.92 - (sBox.y + sBox.h));
    const upRoom = isTitle ? Math.max(0, tBox.y - H * 0.08) : 0;
    const maxH = sBox.h + downRoom + upRoom;
    let f = base;
    let need = sBox.h;
    for (const s of steps(base)) {
      f = s;
      need = md ? boxHeight(doc, s, sBox.w) : sBox.h;
      if (need <= maxH) break;
    }
    const grow = Math.max(0, Math.min(need, maxH) - sBox.h);
    const shift = Math.min(upRoom, Math.max(grow / 2, grow - downRoom));
    const titleSize = fitTitleFont(
      title,
      isTitle ? [44, 40, 36, 32, 28] : [40, 36, 32, 28],
      tBox.w,
      tBox.h,
    );
    const els: PlannedElement[] = [];
    if (!isTitle)
      els.push({
        type: 'shape',
        key: 'bar',
        ph: null,
        name: tr('装饰条'),
        ...boxOf(size, 0.08, 0.4, 0.07, 0.012),
        doc: { type: 'doc', content: [{ type: 'paragraph' }] },
        fill: { type: 'color', color: 'theme:accent' },
        stroke: null,
      });
    els.push(
      titleEl(
        'title',
        { ...tBox, y: r1(tBox.y - shift) },
        title,
        titleSize,
        isTitle ? 'center' : 'left',
        isTitle ? 'bottom' : 'top',
      ),
      {
        type: 'text',
        key: 'subtitle',
        ph: 'subtitle',
        name: tr('副标题'),
        ...sBox,
        y: r1(sBox.y - shift),
        h: r1(sBox.h + grow),
        style: textStyle(
          f,
          isTitle ? { color: 'theme:muted', align: 'center' } : { color: 'theme:muted' },
        ),
        valign: 'top',
        doc,
      },
    );
    return one(layout, els);
  }

  const tBox = boxOf(size, 0.06, 0.06, 0.88, 0.15);
  const titleSize = fitTitleFont(title, [32, 30, 28, 26, 24], tBox.w, tBox.h);
  const head = (t: string) => titleEl('title', tBox, t, titleSize, 'left', 'middle');

  if (layout === 'two-column') {
    const [l, r] = splitSlideColumns(draft.body, opts.legacyColumns);
    const left = segmentBody(l).segs;
    const right = segmentBody(r).segs;
    const lb = boxOf(size, 0.06, 0.25, 0.425, 0.66);
    const rb = boxOf(size, 0.515, 0.25, 0.425, 0.66);
    const colSegs = (s: Seg[]): Seg[] => (s.length ? s : [{ kind: 'text', md: '' }]);
    const a = flow(colSegs(left), lb, 20, { key: 'body', ph: 'body' }, counter, false);
    const b = flow(colSegs(right), rb, 20, { key: 'body2', ph: 'body' }, counter, false);
    if (a.ok && b.ok) return one('two-column', [head(title), ...a.els, ...b.els]);
    // 两栏放不下：退回单栏顺序排，可以拆页
    return planFlow([...left, ...right]);
  }

  const imgs = segs.filter((s) => s.kind === 'image' || s.kind === 'missing');
  const tables = segs.some((s) => s.kind === 'table');
  const texts = segs.filter((s) => s.kind === 'text');
  const region = boxOf(size, 0.06, 0.25, 0.88, 0.66);

  if (imgs.length && !tables) {
    if (texts.length) {
      // 图文：左边文字，右边图片（竖排）
      const lb = boxOf(size, 0.06, 0.25, 0.42, 0.66);
      const rb = boxOf(size, 0.52, 0.25, 0.42, 0.66);
      const a = flow([{ kind: 'text', md }], lb, 20, { key: 'body', ph: 'body' }, counter, false);
      if (a.ok) {
        const each = (rb.h - GAP * (imgs.length - 1)) / imgs.length;
        if (each >= 80) {
          const pics = imgs.map((s, k) => {
            const b = { x: rb.x, y: r1(rb.y + k * (each + GAP)), w: rb.w, h: r1(each) };
            return s.kind === 'image'
              ? ({
                  type: 'image',
                  key: `img${++counter.n}`,
                  name: s.alt || tr('图片'),
                  ...b,
                  src: s.src,
                  fit: 'contain',
                } as PlannedImage)
              : missingEl(s as { src: string; alt: string }, b, counter);
          });
          return one('image-text', [head(title), ...a.els, ...pics]);
        }
      }
    } else {
      // 只有图片：并排铺满正文区
      const each = (region.w - GAP * (imgs.length - 1)) / imgs.length;
      const pics = imgs.map((s, k) => {
        const b = { x: r1(region.x + k * (each + GAP)), y: region.y, w: r1(each), h: region.h };
        return s.kind === 'image'
          ? ({
              type: 'image',
              key: `img${++counter.n}`,
              name: s.alt || tr('图片'),
              ...b,
              src: s.src,
              fit: 'contain',
            } as PlannedImage)
          : missingEl(
              s as { src: string; alt: string },
              {
                ...b,
                h: Math.min(b.h, 160),
                y: r1(region.y + (region.h - Math.min(b.h, 160)) / 2),
              },
              counter,
            );
      });
      return one('title-only', [head(title), ...pics]);
    }
  }

  return planFlow(segs);

  function planFlow(all: Seg[]): PlannedSlide[] {
    const groups: Seg[][] = [[]];
    for (const s of chunkTables(all)) {
      if (s.kind === 'break') groups.push([]);
      else groups[groups.length - 1]!.push(s);
    }
    const pages: Seg[][] = [];
    for (const g of groups) {
      if (!g.length) continue;
      const tryFit = flow(g, region, 22, { key: 'body', ph: 'body' }, { n: 1 }, false);
      if (tryFit.ok) pages.push(g);
      else pages.push(...paginate(g, region, 22));
    }
    if (!pages.length) pages.push([{ kind: 'text', md: '' }]);
    return pages.map((p, idx) => {
      const c = { n: 1 };
      const placed = flow(p, region, 22, { key: 'body', ph: 'body' }, c, true);
      const hasText = p.some((s) => s.kind === 'text');
      const t = idx === 0 ? title : tr('{value}（续）', { value: title || tr('续页') });
      return {
        layout: hasText ? 'content' : 'title-only',
        title: t,
        notes: idx === 0 ? draft.notes : '',
        bg,
        elements: clampAll([head(t), ...placed.els], size),
      };
    });
  }
}

/** markdown → 所有页的元素规划（服务端新建 / 写入、前端 AI 插入都走这里） */
export function planSlidesMarkdown(markdown: string, size: SlidePageSize = SLIDE_PAGE_SIZE) {
  return parseSlideDrafts(markdown).flatMap((d) => planSlide(d, size));
}
