import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import DOMPurify, { type Config } from 'dompurify';
import { DOC_EMBED_SCHEME, DOC_MENTION_SCHEME, parseDocEmbedLabel } from '@srh/shared';

/**
 * AI 返回的 markdown → 可以交给 Tiptap insertContentAt 的 HTML。
 *
 * - marked（GFM）转 HTML，额外识别 `$…$` / `$$…$$` 公式，输出 Tiptap Mathematics 认得的
 *   `<span data-type="inline-math" data-latex>` / `<div data-type="block-math" data-latex>`；
 * - DOMPurify 清洗（去掉脚本、事件属性、javascript: 链接、iframe、图片等 schema 里没有的东西）；
 * - GFM 任务列表改写成 Tiptap TaskList 的结构（`ul[data-type=taskList] > li[data-type=taskItem]`）。
 */

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface MathToken extends Tokens.Generic {
  latex: string;
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start(src: string) {
    const m = /(^|\n)[ \t]{0,3}\$\$/.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src: string) {
    const m = /^[ \t]{0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (!m) return undefined;
    const latex = m[1]!.trim();
    if (!latex) return undefined;
    return { type: 'blockMath', raw: m[0], latex } satisfies MathToken;
  },
  renderer(token) {
    return `<div data-type="block-math" data-latex="${escapeAttr((token as MathToken).latex)}"></div>\n`;
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf('$');
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    // $$x$$（同一行内）或 $x$；$ 后不能是空白，结尾 $ 前不能是空白、后面不能紧跟数字（避免 $5 和 $10）
    const m = /^\$\$([^$\n]+?)\$\$/.exec(src) ?? /^\$(?![\s$])([^$\n]*?[^\s$\\])\$(?!\d)/.exec(src);
    if (!m) return undefined;
    return { type: 'inlineMath', raw: m[0], latex: m[1]!.trim() } satisfies MathToken;
  },
  renderer(token) {
    return `<span data-type="inline-math" data-latex="${escapeAttr((token as MathToken).latex)}"></span>`;
  },
};

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({ extensions: [blockMath, inlineMath] });
// 与服务端 markdown 约定一致：`[@名字](mention:id)` → 提及；`[嵌入表格：标题](doc:id)` → 内嵌文档块
md.use({
  renderer: {
    link(token) {
      const href = token.href ?? '';
      if (href.startsWith(DOC_MENTION_SCHEME)) {
        const id = href.slice(DOC_MENTION_SCHEME.length);
        const label = token.text.replace(/^@/u, '');
        return `<span data-type="mention" data-id="${escapeAttr(id)}" data-label="${escapeAttr(label)}">@${escapeAttr(label)}</span>`;
      }
      if (href.startsWith(DOC_EMBED_SCHEME)) {
        const parsed = parseDocEmbedLabel(token.text);
        const id = href.slice(DOC_EMBED_SCHEME.length);
        if (parsed && id) {
          return `<div data-type="doc-embed" docid="${escapeAttr(id)}" kind="${parsed.kind}" title="${escapeAttr(parsed.title)}"></div>`;
        }
      }
      return false;
    },
  },
});

/** AI 偶尔会把整段包在 ```markdown 围栏里，剥掉。 */
export function stripMarkdownFence(text: string): string {
  const m = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return m ? m[1]! : text;
}

const PURIFY_CONFIG: Config = {
  // 图片可以（schema 里有 image 节点），音视频、iframe 仍然不行
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'video', 'audio'],
  FORBID_ATTR: ['style'],
  ADD_ATTR: ['data-type', 'data-latex', 'data-checked', 'data-id', 'data-label', 'docid', 'kind'],
  ALLOW_DATA_ATTR: false,
};

/** 把 GFM 任务列表（li 里开头一个 checkbox）改写成 TaskList / TaskItem 的 HTML 结构。 */
function convertTaskLists(root: HTMLElement) {
  const lists = Array.from(root.querySelectorAll('ul'));
  for (const ul of lists) {
    const items = Array.from(ul.children).filter((el) => el.tagName === 'LI');
    if (items.length === 0) continue;
    const boxes = items.map((li) => leadingCheckbox(li));
    if (boxes.some((b) => !b)) continue;
    ul.setAttribute('data-type', 'taskList');
    items.forEach((li, i) => {
      const box = boxes[i]!;
      const checked = box.hasAttribute('checked');
      const parent = box.parentElement;
      box.remove();
      // 去掉 checkbox 后面那个空格
      const first = parent?.firstChild;
      if (first && first.nodeType === 3)
        first.textContent = (first.textContent ?? '').replace(/^\s+/, '');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', checked ? 'true' : 'false');
      const wrap = li.ownerDocument.createElement('div');
      while (li.firstChild) wrap.appendChild(li.firstChild);
      li.appendChild(wrap);
    });
  }
  // 剩下的 checkbox（不在任务列表里）没有对应节点，直接去掉
  root.querySelectorAll('input').forEach((el) => el.remove());
}

function leadingCheckbox(li: Element): Element | null {
  let cur: Element | null = li;
  for (let depth = 0; cur && depth < 2; depth += 1) {
    const first: ChildNode | null = firstMeaningful(cur);
    if (!first || first.nodeType !== 1) return null;
    const el = first as Element;
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'checkbox') return el;
    if (el.tagName !== 'P') return null;
    cur = el;
  }
  return null;
}

function firstMeaningful(el: Element): ChildNode | null {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && !(node.textContent ?? '').trim()) continue;
    return node;
  }
  return null;
}

export interface InsertHtml {
  html: string;
  /** true = 内容只有一个段落，html 是去掉 <p> 外壳的行内内容（替换段落内选区时用） */
  inline: boolean;
}

/**
 * markdown → 清洗后的 HTML。`preferInline` 时如果结果只有一个段落，返回它的行内内容，
 * 这样替换段落中间的一段文字不会把段落劈成三段。
 */
export function markdownToHtml(markdown: string, preferInline = false): InsertHtml {
  const source = stripMarkdownFence(markdown).replace(/\r\n?/g, '\n').trim();
  if (!source) return { html: '', inline: preferInline };
  const raw = md.parse(source, { async: false });
  // RETURN_DOM 返回 <body> 元素
  const body = DOMPurify.sanitize(raw, { ...PURIFY_CONFIG, RETURN_DOM: true }) as HTMLElement;
  convertTaskLists(body);
  if (preferInline) {
    const children = Array.from(body.childNodes).filter(
      (n) => !(n.nodeType === 3 && !(n.textContent ?? '').trim()),
    );
    const only = children[0];
    if (children.length === 1 && only && only.nodeType === 1 && (only as Element).tagName === 'P') {
      return { html: (only as Element).innerHTML, inline: true };
    }
  }
  return { html: body.innerHTML.trim(), inline: false };
}
