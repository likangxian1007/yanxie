import DOMPurify from 'dompurify';
import katex from 'katex';
import { marked } from 'marked';
import 'katex/dist/katex.min.css';

/**
 * Notebook 的文字渲染：Markdown 单元格（GFM + $…$ / $$…$$ 公式，和 Jupyter 一样）、
 * ANSI 颜色（stream / traceback）、HTML 输出（DataFrame 等，经 DOMPurify 去掉脚本）。
 *
 * 公式排版靠 KaTeX 的内联 style（height / vertical-align / top），而 Markdown 里用户手写的
 * HTML 不允许带 style。所以分两步：先用占位符净化 Markdown（禁 style），
 * 再只在文本节点位置换回 KaTeX 的结果（KaTeX 输出单独净化，只多放行 style）。
 */

/** KaTeX 自己的输出：trust 关着（不认 \href / \htmlStyle 之类），再过一遍 DOMPurify 兜底 */
function renderMath(tex: string, display: boolean): string {
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
    });
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'a', 'img'],
      ADD_TAGS: ['semantics', 'annotation'],
      ADD_ATTR: ['encoding', 'aria-hidden'],
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 先把公式换成占位符（避免 Markdown 把 _ * 当成强调），渲染完再换回来 */
export function renderMarkdown(src: string): string {
  const code: string[] = [];
  let s = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    code.push(m); // 代码里不解析公式
    return `\uE002${code.length - 1}\uE003`;
  });
  const math: { html: string; source: string }[] = [];
  const keep = (source: string, tex: string, display: boolean) => {
    math.push({ html: renderMath(tex, display), source });
    return `\uE000${math.length - 1}\uE001`;
  };
  s = s
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, t: string) => keep(m, t.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, t: string) => keep(m, t.trim(), true))
    .replace(
      /(^|[^\\$])\$([^$\n]+?)\$/g,
      (_, pre: string, t: string) => pre + keep(`$${t}$`, t, false),
    )
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, t: string) => keep(m, t, false));
  s = s.replace(/\uE002(\d+)\uE003/g, (_, i: string) => code[Number(i)] ?? '');
  const html = marked.parse(s, { async: false, gfm: true, breaks: false });
  return restoreMath(sanitize(html), math);
}

const MATH_MARK = /\uE000(\d+)\uE001/g;

/**
 * 把净化后 HTML 里的公式占位符换回 KaTeX 结果。只在文本节点位置插入；
 * 占位符落在属性里（比如链接地址）时换回公式原文，不插 HTML。
 */
function restoreMath(clean: string, math: { html: string; source: string }[]): string {
  if (!math.length || !clean.includes('\uE000')) return clean;
  // 惰性文档：解析时不加载图片、不跑任何东西
  const inert = document.implementation.createHTMLDocument('');
  const host = inert.createElement('div');
  host.innerHTML = clean;
  const walker = inert.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.nodeValue?.includes('\uE000')) texts.push(n as Text);
      continue;
    }
    const el = n as Element;
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('\uE000')) {
        el.setAttribute(
          attr.name,
          attr.value.replace(MATH_MARK, (_, i: string) => math[Number(i)]?.source ?? ''),
        );
      }
    }
  }
  for (const t of texts) {
    const value = t.nodeValue ?? '';
    const frag = inert.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(MATH_MARK)) {
      const at = m.index ?? 0;
      if (at > last) frag.append(value.slice(last, at));
      const tpl = inert.createElement('template');
      tpl.innerHTML = math[Number(m[1])]?.html ?? '';
      frag.append(tpl.content);
      last = at + m[0].length;
    }
    if (last < value.length) frag.append(value.slice(last));
    t.replaceWith(frag);
  }
  return host.innerHTML;
}

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style'],
  });
}

/** HTML 输出（pandas 表格等）：允许 style 属性（表格对齐），去掉脚本 */
export function sanitizeOutputHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'form', 'input', 'button'] });
}

// ---------------------------------------------------------------- ANSI

const ANSI_COLORS = [
  'var(--nb-ansi-black)',
  'var(--nb-ansi-red)',
  'var(--nb-ansi-green)',
  'var(--nb-ansi-yellow)',
  'var(--nb-ansi-blue)',
  'var(--nb-ansi-magenta)',
  'var(--nb-ansi-cyan)',
  'var(--nb-ansi-white)',
];

/** \x1b[…m 转成带颜色的 span；其他控制序列丢掉 */
export function ansiToHtml(text: string): string {
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let underline = false;
  let out = '';
  // eslint-disable-next-line no-control-regex -- ANSI 转义序列
  const parts = text.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const codes = (parts[i] || '0').split(';').map(Number);
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k] ?? 0;
        if (c === 0) [fg, bg, bold, underline] = [null, null, false, false];
        else if (c === 1) bold = true;
        else if (c === 4) underline = true;
        else if (c === 22) bold = false;
        else if (c === 24) underline = false;
        else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30] ?? null;
        else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90] ?? null;
        else if (c === 39) fg = null;
        else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40] ?? null;
        else if (c === 49) bg = null;
        else if ((c === 38 || c === 48) && codes[k + 1] === 5) {
          const n = codes[k + 2] ?? 0;
          const col =
            n < 8 ? (ANSI_COLORS[n] ?? null) : n < 16 ? (ANSI_COLORS[n - 8] ?? null) : null;
          if (c === 38) fg = col;
          else bg = col;
          k += 2;
        } else if ((c === 38 || c === 48) && codes[k + 1] === 2) {
          const col = `rgb(${codes[k + 2] ?? 0},${codes[k + 3] ?? 0},${codes[k + 4] ?? 0})`;
          if (c === 38) fg = col;
          else bg = col;
          k += 4;
        }
      }
      continue;
    }
    // eslint-disable-next-line no-control-regex -- 去掉其他 ANSI 控制序列
    const chunk = escapeHtml((parts[i] ?? '').replace(/\x1b\[[\d;?]*[A-Za-z]/g, ''));
    if (!chunk) continue;
    const style = [
      fg && `color:${fg}`,
      bg && `background:${bg}`,
      bold && 'font-weight:600',
      underline && 'text-decoration:underline',
    ]
      .filter(Boolean)
      .join(';');
    out += style ? `<span style="${style}">${chunk}</span>` : chunk;
  }
  return out;
}

/** 终端式 \r 处理：一行里 \r 之后的内容覆盖之前的（tqdm 进度条） */
export function fixConsole(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const segs = line.split('\r');
      let cur = '';
      for (const s of segs) cur = s + cur.slice(s.length);
      return cur;
    })
    .join('\n');
}

export function joinText(v: unknown): string {
  return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '';
}
