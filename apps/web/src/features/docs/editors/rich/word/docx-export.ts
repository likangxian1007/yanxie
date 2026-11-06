import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Math as DocxMath,
  MathRun,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import { latexToMath } from 'docx/math';
import { withBase } from '@/lib/base-path';
import { DEFAULT_FONT_PT, splitFontStack, toPt } from './format';
import { mmToTwip, paperMm, type PageSetup, DEFAULT_PAGE } from './page';
import { LIST_STYLES, INDENT_EM } from './schema';
import { tr } from '@/lib/i18n';

/**
 * 富文本（ProseMirror JSON）→ .docx，用 docx 库（MIT）生成。
 * 对应关系：
 * - 标题 → Word 内置“标题 n”样式（目录、导航窗格都认）；正文段落带对齐、行距、段前段后、首行缩进、左缩进
 * - 文字：粗斜下划删除线、上下标、颜色、字体（拉丁 / 中文分别写 w:ascii / w:eastAsia）、字号、高亮（底纹）、行内代码
 * - 列表：多级编号，每个列表各自从头编号（numbering instance），编号样式（1. / a. / i. / 一、 / 圆点…）
 * - 表格：合并单元格（colspan / rowspan）、列宽、单元格底色、标题行（跨页重复）
 * - 图片：取回原图嵌入，按文档里的显示宽度，不超过版心宽
 * - 脚注 → Word 脚注；分页符 → 分页；目录 → Word 目录域（预填条目，打开时更新页码）；公式 → Word 公式（OMML）
 * - 页面：纸张、方向、页边距；页眉 = 文档标题，页脚 = “第 X 页 / 共 Y 页”
 */

export interface PmJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmJSON[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface ImageData {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  width: number;
  height: number;
}

export interface DocxExportOptions {
  title: string;
  page?: PageSetup;
  /** 取图片字节；取不到返回 null（导出时换成“［图片］”文字） */
  loadImage?: (src: string) => Promise<ImageData | null>;
  /** 页眉显示标题（默认 true） */
  header?: boolean;
}

type Block = Paragraph | Table | TableOfContents;

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** 标题字号（磅），与编辑器 rich.css 一致 */
const HEADING_PT = [18, 14, 12, 11, 11, 11];

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const LEVEL_FORMAT: Record<
  string,
  { format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: (n: number) => string }
> = {
  decimal: { format: LevelFormat.DECIMAL, text: (n) => `%${n}.` },
  'decimal-leading-zero': { format: LevelFormat.DECIMAL_ZERO, text: (n) => `%${n}.` },
  'lower-alpha': { format: LevelFormat.LOWER_LETTER, text: (n) => `%${n}.` },
  'upper-alpha': { format: LevelFormat.UPPER_LETTER, text: (n) => `%${n}.` },
  'lower-roman': { format: LevelFormat.LOWER_ROMAN, text: (n) => `%${n}.` },
  'upper-roman': { format: LevelFormat.UPPER_ROMAN, text: (n) => `%${n}.` },
  'cjk-ideographic': { format: LevelFormat.CHINESE_COUNTING, text: (n) => tr('%{n}、', { n }) },
};
const BULLETS: Record<string, string> = { disc: '●', circle: '○', square: '■' };
/** 没指定样式时按层级轮换（和编辑器的 CSS 一致） */
const ORDERED_BY_DEPTH = ['decimal', 'lower-alpha', 'lower-roman'];
const BULLET_BY_DEPTH = ['disc', 'circle', 'square'];

const hex = (c: unknown): string | undefined => {
  if (typeof c !== 'string') return undefined;
  const m = /^#?([0-9a-f]{6})$/iu.exec(c.trim());
  return m ? m[1]!.toUpperCase() : undefined;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  color?: string;
  shading?: string;
  font?: { ascii?: string; eastAsia?: string };
  sizePt?: number;
  code?: boolean;
  link?: string;
}

class Exporter {
  private footnotes: Record<number, { children: Paragraph[] }> = {};
  private footnoteCount = 0;
  private numbering = new Map<string, { reference: string; levels: object[] }>();
  private instance = 0;
  private images = new Map<string, Promise<ImageData | null>>();
  hasToc = false;
  /** 版心宽（twip / 像素） */
  readonly contentTwip: number;
  readonly contentPx: number;

  constructor(private readonly opts: DocxExportOptions) {
    const page = opts.page ?? DEFAULT_PAGE;
    const { width } = paperMm(page);
    const contentMm = Math.max(20, width - page.marginLeft - page.marginRight);
    this.contentTwip = mmToTwip(contentMm);
    this.contentPx = (contentMm / 25.4) * 96;
  }

  /** 先把所有图片并行取回来 */
  async preload(doc: PmJSON) {
    const walk = (n: PmJSON) => {
      if (n.type === 'image') {
        const src = String(n.attrs?.src ?? '');
        if (src && !this.images.has(src) && this.opts.loadImage) {
          this.images.set(
            src,
            this.opts.loadImage(src).catch(() => null),
          );
        }
      }
      for (const c of n.content ?? []) walk(c);
    };
    walk(doc);
    await Promise.all(this.images.values());
  }

  private async image(src: string): Promise<ImageData | null> {
    return (await this.images.get(src)) ?? null;
  }

  // ------------------------------------------------------------ 块

  async blocks(
    nodes: PmJSON[] | undefined,
    ctx: { listDepth?: number; inCell?: boolean } = {},
  ): Promise<Block[]> {
    const out: Block[] = [];
    for (const n of nodes ?? []) out.push(...(await this.block(n, ctx)));
    return out;
  }

  private async block(n: PmJSON, ctx: { listDepth?: number; inCell?: boolean }): Promise<Block[]> {
    switch (n.type) {
      case 'paragraph':
        return [await this.paragraph(n)];
      case 'heading':
        return [
          await this.paragraph(n, { heading: Math.min(6, Math.max(1, num(n.attrs?.level) ?? 1)) }),
        ];
      case 'bulletList':
      case 'orderedList':
        return this.list(n, ctx.listDepth ?? 0);
      case 'taskList': {
        const out: Block[] = [];
        for (const item of n.content ?? []) {
          const checked = !!item.attrs?.checked;
          const [first, ...rest] = item.content ?? [];
          out.push(
            await this.paragraph(first ?? { type: 'paragraph' }, {
              prefix: checked ? '☑ ' : '☐ ',
              indentTwip: (ctx.listDepth ?? 0) * 420,
            }),
          );
          out.push(...(await this.blocks(rest, { ...ctx, listDepth: (ctx.listDepth ?? 0) + 1 })));
        }
        return out;
      }
      case 'blockquote': {
        const inner = await this.blocks(n.content, ctx);
        return inner.map((b) => b);
      }
      case 'codeBlock': {
        const lines = (n.content ?? [])
          .map((c) => c.text ?? '')
          .join('')
          .split('\n');
        return [
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
            spacing: { before: 60, after: 60, line: 276, lineRule: LineRuleType.AUTO },
            children: lines.flatMap((line, i) => [
              new TextRun({
                text: line,
                font: 'Consolas',
                size: 19,
                ...(i > 0 ? { break: 1 } : {}),
              }),
            ]),
          }),
        ];
      }
      case 'horizontalRule':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } },
            children: [],
          }),
        ];
      case 'pageBreak':
        return [new Paragraph({ children: [new PageBreak()] })];
      case 'tableOfContents': {
        this.hasToc = true;
        const max = Math.min(6, Math.max(1, num(n.attrs?.maxLevel) ?? 3));
        return [
          new Paragraph({
            children: [new TextRun({ text: tr('目录'), bold: true, size: 28 })],
            spacing: { after: 120 },
          }),
          new TableOfContents(tr('目录'), { hyperlink: true, headingStyleRange: `1-${max}` }),
        ];
      }
      case 'table':
        return [await this.table(n)];
      case 'image':
        return this.imageBlock(n);
      case 'blockMath': {
        const latex = String(n.attrs?.latex ?? '');
        return [new Paragraph({ alignment: AlignmentType.CENTER, children: [mathRun(latex)] })];
      }
      case 'fileAttachment': {
        const name = String(n.attrs?.name ?? tr('附件'));
        const href = absoluteUrl(String(n.attrs?.href ?? ''));
        return [
          new Paragraph({
            children: [
              href
                ? new ExternalHyperlink({
                    link: href,
                    children: [new TextRun({ text: `📎 ${name}`, style: 'Hyperlink' })],
                  })
                : new TextRun(`📎 ${name}`),
            ],
          }),
        ];
      }
      case 'docEmbed': {
        const title = String(n.attrs?.title ?? '') || tr('内嵌文档');
        return [
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
            children: [
              new TextRun({ text: tr('［内嵌文档：{title}］', { title }), color: '595959' }),
            ],
          }),
        ];
      }
      default:
        if (n.content?.length) return this.blocks(n.content, ctx);
        return [];
    }
  }

  private async paragraph(
    n: PmJSON,
    extra: {
      heading?: number;
      numbering?: { reference: string; level: number; instance: number };
      prefix?: string;
      indentTwip?: number;
    } = {},
  ): Promise<Paragraph> {
    const a = n.attrs ?? {};
    // 标题的加粗由 headingN 样式提供（见 build() 里的 styles），不在每个文字块上直接加粗：
    // 直接加粗在 Word 里显示一样，但再导入时会变成正文的加粗标记，导出 → 导入一次就多一层 **…**
    const runs = await this.inlines(n.content, {});
    if (extra.prefix) runs.unshift(new TextRun(extra.prefix));
    // 缩进按“字符”算：编辑器里 1em = 段落本身的字号（不看段内文字另设的字号），这里一致
    const fontPt = extra.heading ? HEADING_PT[extra.heading - 1]! : DEFAULT_FONT_PT;
    const spacing: IParagraphOptions['spacing'] = {
      ...(num(a.spaceBefore) !== null ? { before: Math.round(num(a.spaceBefore)! * 20) } : {}),
      ...(num(a.spaceAfter) !== null ? { after: Math.round(num(a.spaceAfter)! * 20) } : {}),
      ...(num(a.lineHeight) !== null
        ? { line: Math.round(num(a.lineHeight)! * 240), lineRule: LineRuleType.AUTO }
        : {}),
    };
    const textIndent = num(a.textIndent);
    const indentLevels = num(a.indent) ?? 0;
    const left = indentLevels * INDENT_EM * fontPt * 20 + (extra.indentTwip ?? 0);
    const indent: IParagraphOptions['indent'] = {
      ...(left > 0 ? { left: Math.round(left) } : {}),
      ...(textIndent && textIndent > 0 ? { firstLine: Math.round(textIndent * fontPt * 20) } : {}),
      ...(textIndent && textIndent < 0 ? { hanging: Math.round(-textIndent * fontPt * 20) } : {}),
    };
    const align = typeof a.textAlign === 'string' ? ALIGN[a.textAlign] : undefined;
    return new Paragraph({
      children: runs,
      ...(extra.heading ? { heading: HEADINGS[extra.heading - 1] } : {}),
      ...(align ? { alignment: align } : {}),
      ...(Object.keys(spacing).length ? { spacing } : {}),
      ...(Object.keys(indent).length ? { indent } : {}),
      ...(extra.numbering ? { numbering: extra.numbering } : {}),
    });
  }

  private listReference(type: string, style: string, depth: number, start: number): string {
    const key = `${type}:${style}:${start}`;
    const existing = this.numbering.get(key);
    if (existing) return existing.reference;
    const reference = `list-${this.numbering.size + 1}`;
    const levels = Array.from({ length: 9 }, (_, level) => {
      const indent = { left: 420 * (level + 1), hanging: 420 };
      if (type === 'bulletList') {
        const bullet = BULLETS[style] ?? BULLETS[BULLET_BY_DEPTH[level % 3]!]!;
        return {
          level,
          format: LevelFormat.BULLET,
          text: bullet,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent }, run: { font: 'Arial', size: 16 } },
        };
      }
      const f = LEVEL_FORMAT[style] ?? LEVEL_FORMAT[ORDERED_BY_DEPTH[level % 3]!]!;
      return {
        level,
        format: f.format,
        text: f.text(level + 1),
        start: level === depth ? start : 1,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent } },
      };
    });
    this.numbering.set(key, { reference, levels });
    return reference;
  }

  private async list(n: PmJSON, depth: number): Promise<Block[]> {
    const type = n.type;
    const level = Math.min(8, depth);
    const explicit = typeof n.attrs?.listStyle === 'string' ? String(n.attrs.listStyle) : '';
    const valid = explicit && explicit in LIST_STYLES ? explicit : '';
    const style =
      valid || (type === 'bulletList' ? BULLET_BY_DEPTH[level % 3]! : ORDERED_BY_DEPTH[level % 3]!);
    const start = type === 'orderedList' ? Math.max(1, num(n.attrs?.start) ?? 1) : 1;
    const reference = this.listReference(type, style, level, start);
    this.instance += 1;
    const instance = this.instance;
    const out: Block[] = [];
    for (const item of n.content ?? []) {
      let first = true;
      for (const child of item.content ?? []) {
        if (child.type === 'paragraph' && first) {
          out.push(await this.paragraph(child, { numbering: { reference, level, instance } }));
          first = false;
        } else if (child.type === 'paragraph') {
          out.push(await this.paragraph(child, { indentTwip: 420 * (level + 1) }));
        } else {
          first = false;
          out.push(...(await this.block(child, { listDepth: depth + 1 })));
        }
      }
    }
    return out;
  }

  private async table(n: PmJSON): Promise<Table> {
    const rows = n.content ?? [];
    // 列数与列宽：按第一行（含 colspan）
    const firstCells = rows[0]?.content ?? [];
    const widths: (number | null)[] = [];
    for (const cell of firstCells) {
      const span = Math.max(1, num(cell.attrs?.colspan) ?? 1);
      const cw = Array.isArray(cell.attrs?.colwidth) ? (cell.attrs!.colwidth as unknown[]) : [];
      for (let i = 0; i < span; i += 1) widths.push(num(cw[i]) ?? null);
    }
    const cols = Math.max(1, widths.length);
    const known = widths.filter((w): w is number => w !== null);
    const knownSum = known.reduce((s, w) => s + w, 0);
    const missing = cols - known.length;
    const restPx = Math.max(missing * 60, this.contentPx - knownSum);
    let colPx = widths.map((w) => w ?? restPx / Math.max(1, missing));
    const total = colPx.reduce((s, w) => s + w, 0);
    if (total > this.contentPx) colPx = colPx.map((w) => (w * this.contentPx) / total);
    const columnWidths = colPx.map((w) => Math.round(w * 15));
    let headerDone = false;
    const tableRows: TableRow[] = [];
    for (const row of rows) {
      const cells = row.content ?? [];
      const isHeader =
        !headerDone && cells.length > 0 && cells.every((c) => c.type === 'tableHeader');
      if (!isHeader) headerDone = true;
      const out: TableCell[] = [];
      for (const cell of cells) {
        const children = (await this.blocks(cell.content, { inCell: true })).filter(
          (b): b is Paragraph | Table => !(b instanceof TableOfContents),
        );
        const fill =
          hex(cell.attrs?.backgroundColor) ?? (cell.type === 'tableHeader' ? 'F2F2F2' : undefined);
        const colspan = Math.max(1, num(cell.attrs?.colspan) ?? 1);
        const rowspan = Math.max(1, num(cell.attrs?.rowspan) ?? 1);
        out.push(
          new TableCell({
            children: children.length ? children : [new Paragraph('')],
            ...(colspan > 1 ? { columnSpan: colspan } : {}),
            ...(rowspan > 1 ? { rowSpan: rowspan } : {}),
            ...(fill ? { shading: { type: ShadingType.CLEAR, fill, color: 'auto' } } : {}),
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          }),
        );
      }
      tableRows.push(new TableRow({ children: out, ...(isHeader ? { tableHeader: true } : {}) }));
    }
    return new Table({
      rows: tableRows,
      columnWidths,
      width: { size: columnWidths.reduce((s, w) => s + w, 0), type: WidthType.DXA },
    });
  }

  private async imageBlock(n: PmJSON): Promise<Paragraph[]> {
    const src = String(n.attrs?.src ?? '');
    const caption = String(n.attrs?.caption ?? '');
    const align = ALIGN[String(n.attrs?.align ?? 'center')] ?? AlignmentType.CENTER;
    const img = src ? await this.image(src) : null;
    const out: Paragraph[] = [];
    if (img) {
      const want = num(n.attrs?.width) ?? img.width;
      const width = Math.max(8, Math.min(want, this.contentPx));
      const height = Math.max(8, Math.round((width * img.height) / Math.max(1, img.width)));
      out.push(
        new Paragraph({
          alignment: align,
          children: [
            new ImageRun({
              type: img.type,
              data: img.data,
              transformation: { width: Math.round(width), height },
              altText: {
                name: String(n.attrs?.alt ?? '') || tr('图片'),
                description: caption,
                title: caption,
              },
            }),
          ],
        }),
      );
    } else {
      out.push(
        new Paragraph({
          alignment: align,
          children: [new TextRun({ text: tr('［图片］'), color: '7F7F7F' })],
        }),
      );
    }
    if (caption) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: caption, size: 18, color: '595959' })],
        }),
      );
    }
    return out;
  }

  // ------------------------------------------------------------ 行内

  private async inlines(nodes: PmJSON[] | undefined, base: RunStyle): Promise<ParagraphChild[]> {
    const out: ParagraphChild[] = [];
    // 连续带同一链接的文字合成一个超链接
    let link: { href: string; runs: TextRun[] } | null = null;
    const flush = () => {
      if (link) out.push(new ExternalHyperlink({ link: link.href, children: link.runs }));
      link = null;
    };
    for (const n of nodes ?? []) {
      if (n.type === 'text') {
        const style = { ...base, ...runStyle(n.marks) };
        const run = textRun(n.text ?? '', style);
        const href = style.link ? absoluteUrl(style.link) : '';
        if (href) {
          if (link && link.href !== href) flush();
          link ??= { href, runs: [] };
          link.runs.push(run);
        } else {
          flush();
          out.push(run);
        }
        continue;
      }
      flush();
      switch (n.type) {
        case 'hardBreak':
          out.push(new TextRun({ text: '', break: 1 }));
          break;
        case 'footnote': {
          this.footnoteCount += 1;
          const id = this.footnoteCount;
          const content = String(n.attrs?.content ?? '');
          this.footnotes[id] = {
            children: (content || ' ').split('\n').map((line) => new Paragraph(line)),
          };
          out.push(new FootnoteReferenceRun(id));
          break;
        }
        case 'inlineMath':
          out.push(mathRun(String(n.attrs?.latex ?? '')));
          break;
        case 'mention':
          out.push(textRun(`@${String(n.attrs?.label ?? '')}`, { ...base, color: '3E63DD' }));
          break;
        case 'image': {
          // 行内图片（理论上不会出现）：当块处理
          break;
        }
        default:
          if (n.text) out.push(textRun(n.text, base));
      }
    }
    flush();
    return out;
  }

  build(children: Block[]): Document {
    const page = this.opts.page ?? DEFAULT_PAGE;
    const { width, height } = paperMm(page);
    const title = this.opts.title;
    return new Document({
      title,
      creator: tr('研协'),
      ...(this.hasToc ? { features: { updateFields: true } } : {}),
      styles: {
        default: {
          document: {
            run: {
              font: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑' }, // i18n-ignore 字体名
              size: DEFAULT_FONT_PT * 2,
            },
            paragraph: { spacing: { after: 120, line: 360, lineRule: LineRuleType.AUTO } },
          },
          ...Object.fromEntries(
            HEADING_PT.map((pt, i) => [
              `heading${i + 1}`,
              {
                run: { size: pt * 2, bold: true, color: '1F1F1F' },
                paragraph: {
                  spacing: {
                    before: i === 0 ? 360 : 240,
                    after: 120,
                    line: 300,
                    lineRule: LineRuleType.AUTO,
                  },
                  keepNext: true,
                },
              },
            ]),
          ),
          hyperlink: { run: { color: '0563C1', underline: {} } },
        },
      },
      numbering: { config: [...this.numbering.values()] as never },
      footnotes: this.footnotes,
      sections: [
        {
          properties: {
            page: {
              size: {
                // docx 库要求传纵向尺寸，横向时由 orientation 交换
                width: mmToTwip(Math.min(width, height)),
                height: mmToTwip(Math.max(width, height)),
                orientation:
                  page.orientation === 'landscape'
                    ? PageOrientation.LANDSCAPE
                    : PageOrientation.PORTRAIT,
              },
              margin: {
                top: mmToTwip(page.marginTop),
                right: mmToTwip(page.marginRight),
                bottom: mmToTwip(page.marginBottom),
                left: mmToTwip(page.marginLeft),
              },
            },
          },
          ...(this.opts.header !== false && title
            ? {
                headers: {
                  default: new Header({
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [new TextRun({ text: title, size: 16, color: '7F7F7F' })],
                      }),
                    ],
                  }),
                },
              }
            : {}),
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      size: 18,
                      color: '7F7F7F',
                      children: [
                        tr('第 '),
                        PageNumber.CURRENT,
                        tr(' 页 / 共 '),
                        PageNumber.TOTAL_PAGES,
                        tr(' 页'),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          },
          children: children.length ? children : [new Paragraph('')],
        },
      ],
    });
  }
}

function runStyle(marks: PmJSON['marks']): RunStyle {
  const s: RunStyle = {};
  for (const m of marks ?? []) {
    switch (m.type) {
      case 'bold':
        s.bold = true;
        break;
      case 'italic':
        s.italics = true;
        break;
      case 'underline':
        s.underline = true;
        break;
      case 'strike':
        s.strike = true;
        break;
      case 'superscript':
        s.superScript = true;
        break;
      case 'subscript':
        s.subScript = true;
        break;
      case 'code':
        s.code = true;
        break;
      case 'link':
        s.link = String(m.attrs?.href ?? '');
        break;
      case 'highlight':
        s.shading = hex(m.attrs?.color) ?? 'FFF3A3';
        break;
      case 'textStyle': {
        const color = hex(m.attrs?.color);
        if (color) s.color = color;
        const { ascii, eastAsia } = splitFontStack(m.attrs?.fontFamily as string | undefined);
        if (ascii || eastAsia) {
          s.font = { ...(ascii ? { ascii } : {}), ...(eastAsia ? { eastAsia } : {}) };
          // 只设了中文字体时，西文也用它（与浏览器显示一致）
          if (!ascii && eastAsia) s.font.ascii = eastAsia;
        }
        const pt = toPt(m.attrs?.fontSize as string | undefined);
        if (pt) s.sizePt = pt;
        break;
      }
      default:
        break;
    }
  }
  return s;
}

function textRun(text: string, s: RunStyle): TextRun {
  const parts = text.split('\t');
  const opts: IRunOptions = {
    ...(parts.length > 1
      ? { children: parts.flatMap((p, i) => (i === 0 ? [p] : ['\t', p])) }
      : { text }),
    ...(s.bold ? { bold: true } : {}),
    ...(s.italics ? { italics: true } : {}),
    ...(s.underline ? { underline: {} } : {}),
    ...(s.strike ? { strike: true } : {}),
    ...(s.superScript ? { superScript: true } : {}),
    ...(s.subScript ? { subScript: true } : {}),
    ...(s.color ? { color: s.color } : {}),
    ...(s.sizePt ? { size: Math.round(s.sizePt * 2) } : {}),
    ...(s.shading ? { shading: { type: ShadingType.CLEAR, fill: s.shading, color: 'auto' } } : {}),
    ...(s.link ? { style: 'Hyperlink' } : {}),
  };
  const font = s.code
    ? { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: s.font?.eastAsia ?? '微软雅黑' } // i18n-ignore 字体名
    : s.font
      ? { ascii: s.font.ascii, hAnsi: s.font.ascii, eastAsia: s.font.eastAsia }
      : undefined;
  return new TextRun({
    ...opts,
    ...(font ? { font } : {}),
    ...(s.code && !s.shading
      ? { shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } }
      : {}),
  });
}

function mathRun(latex: string): ParagraphChild {
  try {
    return new DocxMath({ children: latexToMath(latex) });
  } catch {
    // docx 认不出的 LaTeX：按原文写成 Word 公式里的普通文字
    return new DocxMath({ children: [new MathRun(latex)] });
  }
}

function absoluteUrl(href: string): string {
  if (!href || href.startsWith('#') || href.startsWith('mention:')) return '';
  if (href.startsWith('doc:')) return '';
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/** 导出 .docx（Blob） */
export async function exportDocx(doc: PmJSON, options: DocxExportOptions): Promise<Blob> {
  const ex = new Exporter(options);
  await ex.preload(doc);
  const children = await ex.blocks(doc.content);
  return Packer.toBlob(ex.build(children));
}

// ---------------------------------------------------------------- 图片

function imageType(bytes: Uint8Array): ImageData['type'] | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  return null;
}

/** 从文件头读图片尺寸（PNG / JPEG / GIF / BMP），读不出返回 null */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = imageType(bytes);
  try {
    if (type === 'png') return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === 'gif') return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (type === 'bmp')
      return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
    if (type === 'jpg') {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = bytes[i + 1]!;
        const len = dv.getUint16(i + 2);
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** 默认的图片读取：fetch（同源带 Cookie），只接受 PNG / JPEG / GIF / BMP */
export async function fetchImage(src: string): Promise<ImageData | null> {
  const res = await fetch(withBase(src), { credentials: 'include' });
  if (!res.ok) return null;
  const data = new Uint8Array(await res.arrayBuffer());
  const type = imageType(data);
  if (!type) return null;
  const size = imageSize(data) ?? { width: 400, height: 300 };
  return { data, type, ...size };
}
