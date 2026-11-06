import MarkdownIt from 'markdown-it';
import {
  DOC_ATTACHMENT_PREFIX,
  DOC_EMBED_SCHEME,
  DOC_MENTION_SCHEME,
  docEmbedLabel,
  parseDocEmbedLabel,
  type DocumentKind,
} from '@srh/shared';

/**
 * 富文本文档（kind = doc）的 markdown ⇄ ProseMirror JSON 转换。
 * 节点 / 标记名与前端 Tiptap 一致（见 pm-schema.ts）。
 *
 * 约定：
 * - 行内公式 `$…$` → inlineMath；独立成行的 `$$ … $$` → blockMath
 * - `- [ ] 文字` / `- [x] 文字` → taskList / taskItem
 * - 表格第一行作为表头（tableHeader）
 * - 独占一段的 `![说明](地址 "图注")` → image；段落中间的图片拆成独立的图片块
 * - 独占一段的 `[📎 文件名](地址)` → fileAttachment
 * - 独占一段的 `[嵌入表格：标题](doc:<id>)` → docEmbed
 * - 行内 `[@名字](mention:<userId>)` → mention
 * - Word 式排版（pm-word.ts）：独占一段的 `<!-- pagebreak -->` ⇄ pageBreak、`<!-- toc -->` ⇄ tableOfContents；
 *   `[^n]` + 文末 `[^n]: 内容` ⇄ footnote；`<sup>x</sup>` / `<sub>x</sub>` ⇄ superscript / subscript。
 *   字体、字号、颜色、段落格式在 markdown 里写不出（读出时省略）。
 */
export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** 分页符、目录在 markdown 里的写法（独占一段；HTML 注释，摘要里不出现） */
export const PAGE_BREAK_MD = '<!-- pagebreak -->';
export const TOC_MD = '<!-- toc -->';
type Token = ReturnType<typeof md.parse>[number];

/** `$$` 块公式转成 ```math 代码块，交给 fence 处理。 */
function preprocessMath(src: string): string {
  const lines = src.replace(/\r\n?/gu, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const single = /^\s*\$\$(.+)\$\$\s*$/u.exec(line);
    if (single) {
      out.push('```math', single[1]!.trim(), '```');
      continue;
    }
    if (/^\s*\$\$\s*$/u.test(line)) {
      const end = lines.findIndex((l, j) => j > i && /^\s*\$\$\s*$/u.test(l));
      if (end > i) {
        out.push('```math', ...lines.slice(i + 1, end), '```');
        i = end;
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function textNode(text: string, marks: PmMark[]): PmNode | null {
  if (!text) return null;
  return marks.length
    ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) }
    : { type: 'text', text };
}

/** 解析期间的脚注定义（`[^label]: 内容`） */
type FootnoteDefs = Map<string, string>;

const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s?(.*)$/u;

/** 把脚注定义行从源码里拿出来（不在代码块里的、顶格的 `[^x]: …`） */
function extractFootnoteDefs(src: string): { src: string; defs: FootnoteDefs } {
  const defs: FootnoteDefs = new Map();
  const out: string[] = [];
  let fence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) fence = !fence;
    const m = fence ? null : FOOTNOTE_DEF_RE.exec(line);
    if (m) defs.set(m[1]!, m[2]!.trim());
    else out.push(line);
  }
  return { src: out.join('\n'), defs };
}

/** 文本里切出 `<sup>…</sup>` / `<sub>…</sub>`、`[^n]` 脚注，其余交给 splitMath */
function splitExtras(text: string, marks: PmMark[], defs: FootnoteDefs): PmNode[] {
  const out: PmNode[] = [];
  const re = /<(sup|sub)>([^<]*)<\/\1>|\[\^([^\]\s]+)\]/gu;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[3] !== undefined && !defs.has(m[3])) continue;
    out.push(...splitMath(text.slice(last, m.index), marks));
    if (m[3] !== undefined) {
      out.push({ type: 'footnote', attrs: { id: `fn-${m[3]}`, content: defs.get(m[3]) ?? '' } });
    } else if (m[2]) {
      const n = textNode(m[2], [...marks, { type: m[1] === 'sup' ? 'superscript' : 'subscript' }]);
      if (n) out.push(n);
    }
    last = m.index + m[0].length;
  }
  out.push(...splitMath(text.slice(last), marks));
  return out;
}

/** 文本里切出 $…$ 行内公式 */
function splitMath(text: string, marks: PmMark[]): PmNode[] {
  const out: PmNode[] = [];
  const re = /(?<![\\$])\$([^$\n]+?)\$(?!\$)/gu;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = textNode(text.slice(last, m.index), marks);
    if (before) out.push(before);
    out.push({ type: 'inlineMath', attrs: { latex: m[1]!.trim() } });
    last = m.index + m[0].length;
  }
  const rest = textNode(text.slice(last), marks);
  if (rest) out.push(rest);
  return out;
}

/** 文件模块的下载地址里带的文件 id（/projects/:pid/files/fil_…） */
export function fileIdFromUrl(url: string): string | null {
  return /\/files\/(fil_[0-9A-Za-z]+)/u.exec(url)?.[1] ?? null;
}

function parseInline(tokens: Token[] | null, defs: FootnoteDefs = new Map()): PmNode[] {
  const out: PmNode[] = [];
  const marks: PmMark[] = [];
  /** 正在读 `[@名字](mention:id)` 的链接文字 */
  let mention: { id: string; label: string } | null = null;
  const pop = (type: string) => {
    const i = marks.map((m) => m.type).lastIndexOf(type);
    if (i >= 0) marks.splice(i, 1);
  };
  for (const t of tokens ?? []) {
    if (mention && t.type !== 'link_close') {
      mention.label += t.content;
      continue;
    }
    switch (t.type) {
      case 'text':
        out.push(...splitExtras(t.content, marks, defs));
        break;
      case 'code_inline': {
        const n = textNode(t.content, [...marks, { type: 'code' }]);
        if (n) out.push(n);
        break;
      }
      case 'softbreak':
        out.push({ type: 'text', text: ' ', ...(marks.length ? { marks: [...marks] } : {}) });
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;
      case 'strong_open':
        marks.push({ type: 'bold' });
        break;
      case 'strong_close':
        pop('bold');
        break;
      case 'em_open':
        marks.push({ type: 'italic' });
        break;
      case 'em_close':
        pop('italic');
        break;
      case 's_open':
        marks.push({ type: 'strike' });
        break;
      case 's_close':
        pop('strike');
        break;
      case 'link_open': {
        const href = String(t.attrGet('href') ?? '');
        if (href.startsWith(DOC_MENTION_SCHEME) && href.length > DOC_MENTION_SCHEME.length) {
          mention = { id: href.slice(DOC_MENTION_SCHEME.length), label: '' };
          break;
        }
        marks.push({ type: 'link', attrs: { href } });
        break;
      }
      case 'link_close':
        if (mention) {
          out.push({
            type: 'mention',
            attrs: { id: mention.id, label: mention.label.replace(/^@/u, '').trim() },
          });
          mention = null;
          break;
        }
        pop('link');
        break;
      case 'image': {
        // 先作为行内占位，段落收尾时拆成独立的图片块（见 expandBlock）
        const src = String(t.attrGet('src') ?? '');
        out.push({
          type: 'image',
          attrs: {
            src,
            alt: t.content ?? '',
            caption: String(t.attrGet('title') ?? ''),
            fileId: fileIdFromUrl(src),
          },
        });
        break;
      }
      default:
        if (t.content) out.push(...splitExtras(t.content, marks, defs));
    }
  }
  // 合并相邻同标记文本
  const merged: PmNode[] = [];
  for (const n of out) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === 'text' &&
      n.type === 'text' &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      prev.text = (prev.text ?? '') + (n.text ?? '');
    } else merged.push(n);
  }
  return merged;
}

const NEEDS_BLOCK = new Set(['blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader']);

function finalize(node: PmNode): PmNode {
  const content = node.content ?? [];
  if (NEEDS_BLOCK.has(node.type) && content.length === 0) {
    node.content = [{ type: 'paragraph' }];
  }
  if ((node.type === 'listItem' || node.type === 'taskItem') && content[0]?.type !== 'paragraph') {
    node.content = [{ type: 'paragraph' }, ...content];
  }
  if (node.content && node.content.length === 0) delete node.content;
  if (node.type === 'bulletList') return toTaskListIfNeeded(node);
  return node;
}

const TASK_RE = /^\[( |x|X)\]\s+/u;

function toTaskListIfNeeded(list: PmNode): PmNode {
  const items = list.content ?? [];
  const isTask = (item: PmNode) => {
    const first = item.content?.[0]?.content?.[0];
    return first?.type === 'text' && TASK_RE.test(first.text ?? '');
  };
  if (items.length === 0 || !items.every(isTask)) return list;
  return {
    type: 'taskList',
    content: items.map((item) => {
      const para = item.content![0]!;
      const first = para.content![0]!;
      const checked = /^\[(x|X)\]/u.test(first.text ?? '');
      const rest = (first.text ?? '').replace(TASK_RE, '');
      const paraContent = [
        ...(rest ? [{ ...first, text: rest }] : []),
        ...(para.content ?? []).slice(1),
      ];
      return {
        type: 'taskItem',
        attrs: { checked },
        content: [
          paraContent.length ? { ...para, content: paraContent } : { type: 'paragraph' },
          ...(item.content ?? []).slice(1),
        ],
      };
    }),
  };
}

const isBlank = (nodes: PmNode[]) =>
  nodes.every((n) => n.type === 'text' && !(n.text ?? '').trim());

/** 段落只有一个链接时，看它是不是附件 / 内嵌文档的写法 */
function specialBlock(content: PmNode[]): PmNode | null {
  const items = content.filter((n) => !(n.type === 'text' && !(n.text ?? '').trim()));
  if (items.length !== 1) return null;
  const only = items[0]!;
  const link = only.type === 'text' ? only.marks?.find((m) => m.type === 'link') : undefined;
  if (!link || (only.marks?.length ?? 0) !== 1) return null;
  const href = String(link.attrs?.href ?? '');
  const text = (only.text ?? '').trim();
  if (href.startsWith(DOC_EMBED_SCHEME)) {
    const parsed = parseDocEmbedLabel(text);
    const docId = href.slice(DOC_EMBED_SCHEME.length);
    if (parsed && docId) {
      return { type: 'docEmbed', attrs: { docId, kind: parsed.kind, title: parsed.title } };
    }
    return null;
  }
  if (text.startsWith(DOC_ATTACHMENT_PREFIX.trim())) {
    return {
      type: 'fileAttachment',
      attrs: {
        href,
        fileId: fileIdFromUrl(href),
        name: text.slice(DOC_ATTACHMENT_PREFIX.trim().length).trim(),
      },
    };
  }
  return null;
}

/** 段落收尾：图片拆成独立块、整段链接识别成附件 / 内嵌文档；标题里的图片退回成链接文字 */
function expandBlock(node: PmNode): PmNode[] {
  const content = node.content ?? [];
  if (node.type === 'heading') {
    if (content.some((n) => n.type === 'image')) {
      node.content = content.map((n) =>
        n.type === 'image'
          ? {
              type: 'text',
              text: String(n.attrs?.alt || n.attrs?.src || ''),
              marks: [{ type: 'link', attrs: { href: String(n.attrs?.src ?? '') } }],
            }
          : n,
      );
    }
    return [node];
  }
  if (node.type !== 'paragraph') return [node];
  const marker =
    content.length === 1 && content[0]!.type === 'text' && !content[0]!.marks
      ? (content[0]!.text ?? '').trim().toLowerCase()
      : '';
  if (marker === PAGE_BREAK_MD) return [{ type: 'pageBreak' }];
  if (marker === TOC_MD) return [{ type: 'tableOfContents', attrs: { maxLevel: 3 } }];
  const special = specialBlock(content);
  if (special) return [special];
  if (!content.some((n) => n.type === 'image')) return [node];
  const out: PmNode[] = [];
  let run: PmNode[] = [];
  const flush = () => {
    if (run.length && !isBlank(run)) {
      out.push({ ...node, content: run });
    }
    run = [];
  };
  for (const n of content) {
    if (n.type === 'image') {
      flush();
      out.push(n);
    } else if (n.type === 'hardBreak' && run.length === 0) {
      // 图片后面的换行不单独成段
    } else run.push(n);
  }
  flush();
  return out;
}

/** markdown → ProseMirror doc JSON */
export function markdownToPm(src: string, fallbackFootnotes?: Map<string, string>): PmNode {
  const { src: body, defs } = extractFootnoteDefs(preprocessMath(src));
  // agent 重写某一节时只带了 `[^2]`、定义在全文末尾：用文档里现有的第 2 条脚注
  for (const [label, content] of fallbackFootnotes ?? [])
    if (!defs.has(label)) defs.set(label, content);
  const tokens = md.parse(body, {});
  const root: PmNode = { type: 'doc', content: [] };
  const stack: PmNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const push = (node: PmNode) => {
    node.content = [];
    stack.push(node);
  };
  const close = () => {
    const node = stack.pop()!;
    const parent = top();
    (parent.content ??= []).push(...expandBlock(finalize(node)));
  };
  const append = (node: PmNode) => (top().content ??= []).push(node);

  for (const t of tokens) {
    switch (t.type) {
      case 'heading_open':
        push({ type: 'heading', attrs: { level: Number(t.tag.slice(1)) || 1 } });
        break;
      case 'paragraph_open':
        push({ type: 'paragraph' });
        break;
      case 'bullet_list_open':
        push({ type: 'bulletList' });
        break;
      case 'ordered_list_open':
        push({ type: 'orderedList', attrs: { start: Number(t.attrGet('start') ?? 1) || 1 } });
        break;
      case 'list_item_open':
        push({ type: 'listItem' });
        break;
      case 'blockquote_open':
        push({ type: 'blockquote' });
        break;
      case 'table_open':
        push({ type: 'table' });
        break;
      case 'tr_open':
        push({ type: 'tableRow' });
        break;
      case 'th_open':
      case 'td_open':
        push({ type: t.type === 'th_open' ? 'tableHeader' : 'tableCell' });
        push({ type: 'paragraph' });
        break;
      case 'th_close':
      case 'td_close':
        close();
        close();
        break;
      case 'heading_close':
      case 'paragraph_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'blockquote_close':
      case 'table_close':
      case 'tr_close':
        close();
        break;
      case 'inline':
        (top().content ??= []).push(...parseInline(t.children, defs));
        break;
      case 'fence':
      case 'code_block': {
        const info = t.info.trim().split(/\s+/u)[0] ?? '';
        const code = t.content.replace(/\n$/u, '');
        if (info === 'math') append({ type: 'blockMath', attrs: { latex: code.trim() } });
        else
          append({
            type: 'codeBlock',
            attrs: { language: info || null },
            ...(code ? { content: [{ type: 'text', text: code }] } : {}),
          });
        break;
      }
      case 'hr':
        append({ type: 'horizontalRule' });
        break;
      case 'html_block':
        if (t.content.trim())
          append({ type: 'paragraph', content: [{ type: 'text', text: t.content.trim() }] });
        break;
      default:
        break;
    }
  }
  while (stack.length > 1) close();
  return root;
}

/**
 * 一句行内 markdown → 行内节点（不解析块：`1. 结果`、`# x` 都按文字），replace_text 就地替换用。
 * 首尾空白原样保留；图片在行内放不下，退回成链接文字。
 */
export function markdownInlineToPm(src: string, footnotes?: Map<string, string>): PmNode[] {
  const text = src.replace(/\r\n?/gu, '\n');
  const lead = /^[ \t]*/u.exec(text)![0];
  const trail = /[ \t]*$/u.exec(text.slice(lead.length))![0];
  const body = text.slice(lead.length, text.length - trail.length);
  const nodes = body
    ? parseInline(md.parseInline(body, {})[0]?.children ?? null, footnotes ?? new Map())
    : [];
  const out = nodes.map((n) =>
    n.type === 'image'
      ? {
          type: 'text',
          text: String(n.attrs?.alt || n.attrs?.src || ''),
          marks: [{ type: 'link', attrs: { href: String(n.attrs?.src ?? '') } }],
        }
      : n,
  );
  if (lead) out.unshift({ type: 'text', text: lead });
  if (trail) out.push({ type: 'text', text: trail });
  return out.filter((n) => n.type !== 'text' || n.text);
}

// ---------------------------------------------------------------- PM JSON → markdown

const MARK_ORDER = [
  'link',
  'strike',
  'italic',
  'bold',
  'highlight',
  'underline',
  'superscript',
  'subscript',
  'code',
];

/** pmToMarkdown 期间收集的脚注（按出现顺序编号） */
let footnoteSink: string[] | null = null;

function inlineToMd(nodes: PmNode[] | undefined, inTable = false): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'footnote') {
      const content = String(n.attrs?.content ?? '').replace(/\s*\n\s*/gu, ' ');
      if (footnoteSink) {
        footnoteSink.push(content);
        out += `[^${footnoteSink.length}]`;
      } else if (content) out += `（注：${content}）`;
      continue;
    }
    if (n.type === 'hardBreak') {
      out += inTable ? ' ' : '  \n';
      continue;
    }
    if (n.type === 'inlineMath') {
      out += `$${String(n.attrs?.latex ?? '')}$`;
      continue;
    }
    if (n.type === 'mention') {
      out += `[@${escLabel(String(n.attrs?.label ?? ''))}](${DOC_MENTION_SCHEME}${String(n.attrs?.id ?? '')})`;
      continue;
    }
    if (n.type === 'image') {
      out += imageMd(n);
      continue;
    }
    if (n.type !== 'text') {
      out += inlineToMd(n.content, inTable);
      continue;
    }
    let text = n.text ?? '';
    if (inTable) text = text.replace(/\|/gu, '\\|');
    const marks = [...(n.marks ?? [])].sort(
      (a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type),
    );
    for (const m of marks) {
      if (m.type === 'code') text = `\`${text}\``;
      else if (m.type === 'bold') text = `**${text}**`;
      else if (m.type === 'italic') text = `*${text}*`;
      else if (m.type === 'strike') text = `~~${text}~~`;
      else if (m.type === 'highlight') text = `==${text}==`;
      else if (m.type === 'superscript') text = `<sup>${text}</sup>`;
      else if (m.type === 'subscript') text = `<sub>${text}</sub>`;
      else if (m.type === 'link') text = `[${text}](${String(m.attrs?.href ?? '')})`;
    }
    out += text;
  }
  return out;
}

const escLabel = (s: string) => s.replace(/([[\]\\])/gu, '\\$1').replace(/\n/gu, ' ');
const mdUrl = (url: string) => (/[\s()<>]/u.test(url) ? `<${url.replace(/[<>]/gu, '')}>` : url);

function imageMd(node: PmNode): string {
  const alt = escLabel(String(node.attrs?.alt ?? ''));
  const src = mdUrl(String(node.attrs?.src ?? ''));
  const caption = String(node.attrs?.caption ?? '')
    .replace(/\n/gu, ' ')
    .replace(/(["\\])/gu, '\\$1');
  return `![${alt}](${src}${caption ? ` "${caption}"` : ''})`;
}

/** 图片 / 附件 / 内嵌文档的一行 markdown；其他节点返回 null */
function specialToMd(node: PmNode): string | null {
  switch (node.type) {
    case 'image':
      return imageMd(node);
    case 'fileAttachment':
      return `[${escLabel(`${DOC_ATTACHMENT_PREFIX}${String(node.attrs?.name || '附件')}`)}](${mdUrl(String(node.attrs?.href ?? ''))})`;
    case 'docEmbed': {
      const kind = String(node.attrs?.kind ?? 'doc') as DocumentKind;
      const title = String(node.attrs?.title ?? '') || '未命名文档';
      return `[${escLabel(docEmbedLabel(kind, title))}](${DOC_EMBED_SCHEME}${String(node.attrs?.docId ?? '')})`;
    }
    default:
      return null;
  }
}

function indent(text: string, prefix: string, first: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : line ? prefix : '') + line)
    .join('\n');
}

function blockToMd(node: PmNode): string {
  const special = specialToMd(node);
  if (special !== null) return special;
  switch (node.type) {
    case 'paragraph':
      return inlineToMd(node.content);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inlineToMd(node.content)}`;
    case 'blockquote':
      return blocksToMd(node.content)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => indent(blocksToMd(item.content, true), '  ', '- '))
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, i) => {
          const marker = `${start + i}. `;
          return indent(blocksToMd(item.content, true), ' '.repeat(marker.length), marker);
        })
        .join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map((item) =>
          indent(blocksToMd(item.content, true), '  ', item.attrs?.checked ? '- [x] ' : '- [ ] '),
        )
        .join('\n');
    case 'codeBlock': {
      const code = (node.content ?? []).map((t) => t.text ?? '').join('');
      return `\`\`\`${String(node.attrs?.language ?? '')}\n${code}\n\`\`\``;
    }
    case 'blockMath':
      return `$$\n${String(node.attrs?.latex ?? '')}\n$$`;
    case 'horizontalRule':
      return '---';
    case 'pageBreak':
      return PAGE_BREAK_MD;
    case 'tableOfContents':
      return TOC_MD;
    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((b) => specialToMd(b)?.replace(/\|/gu, '\\|') ?? inlineToMd(b.content, true))
            .join(' ')
            .trim(),
        ),
      );
      if (rows.length === 0) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
      const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
      return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
    }
    default:
      return node.content ? blocksToMd(node.content) : '';
  }
}

function blocksToMd(nodes: PmNode[] | undefined, tight = false): string {
  return (nodes ?? []).map(blockToMd).join(tight ? '\n' : '\n\n');
}

/** ProseMirror doc JSON → markdown */
export function pmToMarkdown(doc: PmNode): string {
  const notes: string[] = [];
  footnoteSink = notes;
  let body: string;
  try {
    body = blocksToMd(doc.content);
  } finally {
    footnoteSink = null;
  }
  const defs = notes.map((c, i) => `[^${i + 1}]: ${c}`).join('\n');
  return (defs ? `${body}\n\n${defs}` : body).replace(/\n{3,}/gu, '\n\n').trim();
}

/**
 * 逐个顶层块转 markdown（和 pmToMarkdown 用同一套脚注编号，不附脚注定义）。
 * 按块定位文字用：块之间用空行连接后，与 pmToMarkdown 的正文基本一致。
 */
export function pmBlocksToMarkdown(doc: PmNode): string[] {
  const notes: string[] = [];
  footnoteSink = notes;
  try {
    return (doc.content ?? []).map((b) =>
      blockToMd(b)
        .replace(/\n{3,}/gu, '\n\n')
        .trim(),
    );
  } finally {
    footnoteSink = null;
  }
}

/** 文档里现有的脚注（按 pmToMarkdown 的编号：出现顺序，1 起） */
export function footnotesOf(doc: PmNode): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: PmNode) => {
    if (n.type === 'footnote') out.set(String(out.size + 1), String(n.attrs?.content ?? ''));
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** 节点的纯文本 */
export function pmText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'inlineMath' || node.type === 'blockMath')
    return String(node.attrs?.latex ?? '');
  if (node.type === 'mention') return `@${String(node.attrs?.label ?? '')}`;
  return (node.content ?? []).map(pmText).join('');
}

/** 各类文档的列表摘要：表格取前几行的单元格，LaTeX 取摘要/正文文字，其他按 markdown 去标记 */
export function documentExcerpt(kind: string, text: string, max = 200): string {
  if (kind === 'sheet') {
    const rows = text
      .split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\|[\s|:-]+\|$/u.test(l.trim()))
      // 跳过列标题行（| | A | B |；多张工作表时每张表都有一行）
      .filter((l) => !/^\|\s*\|(\s*[A-Z]{1,3}\s*\|)+$/u.test(l.trim()))
      .slice(0, 4)
      .map((l) =>
        l
          .split('|')
          .slice(2) // 去掉行号列
          .map((c) => c.trim())
          .filter(Boolean)
          .join(' · '),
      )
      .filter(Boolean);
    const plain = rows.join(' ／ ');
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  if (kind === 'latex') {
    const plain = latexExcerptText(text);
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return markdownExcerpt(text.replace(/<!--[\s\S]*?-->/gu, ' '), max);
}

/** 行内公式里常见符号的可读写法 */
const MATH_SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Omega: 'Ω',
  times: '×',
  cdot: '·',
  pm: '±',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  sim: '~',
  infty: '∞',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  in: '∈',
  sum: '∑',
  prod: '∏',
  int: '∫',
  partial: '∂',
  nabla: '∇',
  cdots: '…',
  ldots: '…',
  dots: '…',
  log: 'log',
  exp: 'exp',
  max: 'max',
  min: 'min',
  sin: 'sin',
  cos: 'cos',
};

/** 去掉 \cmd{…} 外壳只留内容的命令（字体、文本） */
const MATH_WRAPPERS =
  /\\(?:mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|boldsymbol|operatorname|text|textrm|textbf|textit|hat|bar|tilde|vec|overline|underline)\s*\{([^{}]*)\}/gu;

/** 行内公式 → 可读文字：`O(N^2)` 原样保留，`\frac{a}{b}` → a/b，希腊字母换成符号 */
export function mathToPlain(src: string): string {
  let s = src;
  for (let i = 0; i < 4; i += 1) {
    const next = s
      .replace(MATH_WRAPPERS, '$1')
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/gu, '$1/$2')
      .replace(/\\sqrt\s*\{([^{}]*)\}/gu, '√$1');
    if (next === s) break;
    s = next;
  }
  return s
    .replace(/\\left|\\right|\\big|\\Big|\\bigg|\\Bigg/gu, '')
    .replace(/\\[,;:!> ]/gu, ' ')
    .replace(/\\([a-zA-Z]+)/gu, (_m, name: string) => MATH_SYMBOLS[name] ?? name)
    .replace(/\\([{}%$&#_])/gu, '$1')
    .replace(/\^\{([^{}]*)\}/gu, '^$1')
    .replace(/_\{([^{}]*)\}/gu, '_$1')
    .replace(/[{}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 只做排版、不出文字的命令：连同参数一起去掉 */
const DROP_WITH_ARGS =
  /\\(?:label|ref|eqref|autoref|cref|Cref|cite|citep|citet|citeauthor|includegraphics|bibliography|bibliographystyle|input|include|usepackage|documentclass|vspace|hspace|setlength|addtolength|newcommand|renewcommand|providecommand|graphicspath|pagestyle|thispagestyle|centering|maketitle|tableofcontents|newpage|clearpage|noindent|hline|toprule|midrule|bottomrule|cline|cmidrule|small|footnotesize|large|Large|normalsize)\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})*/gu;

/** 不在摘要里出现的环境（整段去掉）：显示公式、图、表的排版内容 */
const DROP_ENVS =
  /\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math|tikzpicture|figure|table|tabular|thebibliography|verbatim|lstlisting)(\*?)\}[\s\S]*?\\end\{\1\2\}/gu;

/** LaTeX 源码 → 摘要文字：跳过导言区、注释、显示公式和图表，行内公式保留成可读文字 */
export function latexExcerptText(text: string): string {
  const body = text.includes('\\begin{document}') ? text.split('\\begin{document}')[1]! : text;
  return (
    body
      .replace(/\\end\{document\}[\s\S]*$/u, ' ')
      .replace(/(^|[^\\])%.*$/gmu, '$1')
      .replace(DROP_ENVS, ' ')
      .replace(/\$\$[\s\S]*?\$\$/gu, ' ')
      .replace(/\\\[[\s\S]*?\\\]/gu, ' ')
      // 行内公式：$…$ 与 \(…\)
      .replace(/\\\(([\s\S]*?)\\\)/gu, (_m, m: string) => ` ${mathToPlain(m)} `)
      .replace(/(^|[^\\])\$([^$]+)\$/gu, (_m, pre: string, m: string) => `${pre}${mathToPlain(m)}`)
      .replace(/\\(begin|end)\s*\{[^}]*\}(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})*/gu, ' ')
      .replace(DROP_WITH_ARGS, ' ')
      .replace(/\\item\b(?:\s*\[([^\]]*)\])?/gu, ' $1 ')
      .replace(
        /\\(?:section|subsection|subsubsection|paragraph|chapter|caption|title|author|date|footnote|emph|textbf|textit|texttt|underline|textsc|textsf|textrm|url|mbox|text)\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/gu,
        ' $1 ',
      )
      .replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/gu, '$1')
      .replace(/\\\\/gu, ' ')
      .replace(/\\([&%$#_{}])/gu, '$1')
      .replace(/\\[a-zA-Z]+\*?/gu, ' ')
      .replace(/[{}&~]/gu, ' ')
      .replace(/\s+([.,;:!?，。；：！？）])/gu, '$1')
      .replace(/([，。；：！？（])\s+/gu, '$1')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

/** markdown → 摘要（去掉标记，压缩空白） */
export function markdownExcerpt(markdown: string, max = 200): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^\[\^[^\]\s]+\]:.*$/gmu, ' ')
    .replace(/\[\^[^\]\s]+\]/gu, '')
    .replace(/<\/?su[bp]>/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, '')
    .replace(/\[( |x|X)\]\s+/gu, '')
    .replace(/[*_~`|=]+/gu, ' ')
    .replace(/^\s*-{3,}\s*$/gmu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
