import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import katex from 'katex';
import { parseHTML } from 'linkedom';
import MarkdownIt from 'markdown-it';
import { ApiError, type NbOutput, type NotebookExportFormat } from '@srh/shared';
import { toIpynb, type PlainCell, type PlainNotebook } from './nbformat';

/**
 * Notebook 导出：.ipynb / .py / .md / .html / .pdf / .zip（打包以上全部 + 图片目录）。
 * 全部带运行结果和图；PDF 由无头 Chromium 打印 HTML 得到（服务器装 chromium，见 Dockerfile）。
 */
export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

// eslint-disable-next-line no-control-regex -- 去掉 ANSI 颜色码
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

export function safeFilename(title: string): string {
  const s = title
    // eslint-disable-next-line no-control-regex -- 文件名里的控制字符
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 120);
  return s || 'notebook';
}

const text = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

// ---------------------------------------------------------------- .py

export function toPy(nb: PlainNotebook, title: string): string {
  const out: string[] = [
    `# ---`,
    `# 研协 Notebook 导出：${title}`,
    `# 格式：percent（VS Code / Spyder / Jupytext 可直接按单元格运行）`,
    `# ---`,
    '',
  ];
  for (const c of nb.cells) {
    if (c.type === 'code') {
      out.push('# %%', c.source.replace(/\s+$/, ''), '');
    } else if (c.type === 'markdown') {
      out.push('# %% [markdown]');
      for (const line of c.source.split('\n')) out.push(line ? `# ${line}` : '#');
      out.push('');
    } else {
      out.push('# %% [raw]');
      for (const line of c.source.split('\n')) out.push(`# ${line}`);
      out.push('');
    }
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------- 输出取值

interface ImageRef {
  name: string;
  mime: string;
  data: Buffer;
}

function imageOf(o: NbOutput): { mime: string; b64: string } | null {
  if (o.output_type !== 'display_data' && o.output_type !== 'execute_result') return null;
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const v = o.data[mime];
    if (typeof v === 'string' || Array.isArray(v))
      return { mime, b64: text(v).replace(/\s+/g, '') };
  }
  return null;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function plainTextOf(o: NbOutput): string | null {
  if (o.output_type === 'stream') return o.text;
  if (o.output_type === 'error')
    return stripAnsi(o.traceback.join('\n') || `${o.ename}: ${o.evalue}`);
  const plain = o.data['text/plain'];
  return plain !== undefined ? text(plain) : null;
}

// ---------------------------------------------------------------- .md

/**
 * Markdown：输出放代码块，图片两种写法：
 *   embed  data URI 内嵌（单文件下载）
 *   files  写到 images/ 目录，用相对路径引用（打包下载）
 */
export function toMarkdown(
  nb: PlainNotebook,
  title: string,
  images: 'embed' | ImageRef[] = 'embed',
): string {
  const lang = String(
    (nb.metadata.language_info as { name?: string } | undefined)?.name ?? 'python',
  );
  const parts: string[] = [`# ${title}`, ''];
  let n = 0;
  for (const c of nb.cells) {
    if (c.type === 'markdown') {
      parts.push(c.source.trim(), '');
      continue;
    }
    if (c.type === 'raw') {
      parts.push('```', c.source, '```', '');
      continue;
    }
    parts.push(`\`\`\`${lang}`, c.source.replace(/\s+$/, ''), '```', '');
    for (const o of c.outputs) {
      const img = imageOf(o);
      if (img) {
        n += 1;
        if (images === 'embed') {
          parts.push(`![输出 ${n}](data:${img.mime};base64,${img.b64})`, '');
        } else {
          const name = `images/cell-${c.id}-${n}.${EXT[img.mime] ?? 'png'}`;
          images.push({ name, mime: img.mime, data: Buffer.from(img.b64, 'base64') });
          parts.push(`![输出 ${n}](${name})`, '');
        }
        continue;
      }
      if (o.output_type !== 'stream' && o.output_type !== 'error') {
        const md = o.data['text/markdown'];
        if (md !== undefined) {
          parts.push(text(md), '');
          continue;
        }
      }
      const t = plainTextOf(o);
      if (t) parts.push('```text', t.replace(/\s+$/, ''), '```', '');
    }
  }
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

// ---------------------------------------------------------------- .html

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new MarkdownIt({ html: true, linkify: true });

// ---------------------------------------------------------------- HTML 清洗

/**
 * 导出的 HTML 会被别人下载后直接用浏览器打开：内核输出（text/html、svg）和 markdown 里的原始 HTML
 * 都可能带脚本。解析成 DOM 后清洗再序列化：
 *   - 去掉可执行 / 可嵌入 / 能改页面行为的元素（script、iframe、object、embed、base、meta、form…）
 *   - 去掉 on* 事件属性、srcdoc / formaction，以及 javascript: / vbscript: / data: 链接
 *     （<img src="data:image/…"> 保留，图片输出要用）
 *   - 去掉注释；内容里含 < 的 style / title（在 svg 里浏览器会把它们当标签解析，mXSS）
 *   - 保留 style（pandas 表格的样式），CSS 在现代浏览器里不能执行脚本
 */
const DROP_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'base',
  'link',
  'meta',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'xmp',
  'plaintext',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'handler',
  'listener',
  // SVG 动画可以把 href 改成 javascript:
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
]);
const RAW_TEXT_TAGS = new Set(['style', 'title']);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping']);
// eslint-disable-next-line no-control-regex -- 浏览器解析 URL 时会忽略空白和控制字符
const URL_JUNK = /[\u0000-\u0020\u007f-\u009f]/g;

interface SanNode {
  nodeType: number;
  childNodes: ArrayLike<SanNode>;
  remove(): void;
  localName?: string;
  textContent: string | null;
  attributes?: ArrayLike<{ name: string; value: string }>;
  removeAttribute?(name: string): void;
}

function cleanTree(node: SanNode) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue; // 文本
    if (child.nodeType !== 1) {
      child.remove(); // 注释、CDATA、处理指令
      continue;
    }
    const tag = (child.localName ?? '').toLowerCase();
    if (DROP_TAGS.has(tag) || (RAW_TEXT_TAGS.has(tag) && (child.textContent ?? '').includes('<'))) {
      child.remove();
      continue;
    }
    for (const a of Array.from(child.attributes ?? [])) {
      const name = a.name.toLowerCase();
      const value = a.value.replace(URL_JUNK, '').toLowerCase();
      const scheme = /^(javascript|vbscript|data|livescript):/.exec(value)?.[1];
      const imgData = tag === 'img' && name === 'src' && value.startsWith('data:image/');
      if (
        name.startsWith('on') ||
        DROP_ATTRS.has(name) ||
        value.includes('javascript:') ||
        value.includes('vbscript:') ||
        (scheme && !imgData)
      ) {
        child.removeAttribute?.(a.name);
      }
    }
    cleanTree(child);
  }
}

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  const { document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="srh-sanitize"></div></body></html>',
  );
  const root = document.getElementById('srh-sanitize');
  if (!root) return esc(html);
  root.innerHTML = html;
  cleanTree(root as unknown as SanNode);
  return root.innerHTML;
}

/** $..$ / $$..$$ 先渲染成 MathML（Chromium 原生渲染，不依赖字体文件），再交给 markdown-it */
export function renderMarkdown(src: string): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };
  const math = (tex: string, display: boolean) => {
    try {
      return keep(
        katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false }),
      );
    } catch {
      return keep(esc(tex));
    }
  };
  let s = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t: string) => math(t, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, t: string) => math(t, true));
  s = s.replace(
    /(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g,
    (_, pre: string, t: string) => pre + math(t, false),
  );
  const html = md.render(s);
  // markdown 允许原始 HTML：和内核输出一样清洗
  return sanitizeHtml(html.replace(/\uE000(\d+)\uE001/g, (_, i: string) => stash[Number(i)] ?? ''));
}

const PY_KW =
  /\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case)\b/;
const PY_BUILTIN =
  /\b(print|len|range|enumerate|zip|map|filter|list|dict|set|tuple|int|float|str|bool|open|sum|min|max|abs|sorted|isinstance|type|super|self)\b/;

/** 轻量 Python 高亮（导出用，和编辑器配色一致的几类 token） */
export function highlightPython(code: string): string {
  const re =
    /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfuRBFU]{0,2}"(?:\\.|[^"\\\n])*"|[rbfuRBFU]{0,2}'(?:\\.|[^'\\\n])*')|(\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?j?\b)|(@[\w.]+)|([A-Za-z_]\w*)/g;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, num, deco, word] = m;
    if (comment) out += `<span class="c">${esc(tok)}</span>`;
    else if (str) out += `<span class="s">${esc(tok)}</span>`;
    else if (num) out += `<span class="n">${esc(tok)}</span>`;
    else if (deco) out += `<span class="d">${esc(tok)}</span>`;
    else if (word && PY_KW.test(word) && PY_KW.exec(word)![0] === word)
      out += `<span class="k">${tok}</span>`;
    else if (word && PY_BUILTIN.exec(word)?.[0] === word) out += `<span class="b">${tok}</span>`;
    else out += esc(tok);
    last = m.index! + tok.length;
  }
  return out + esc(code.slice(last));
}

const ANSI_COLORS = [
  '#000',
  '#c4302b',
  '#2e7d32',
  '#b26a00',
  '#1d5fbf',
  '#8e44ad',
  '#00838f',
  '#666',
];

/** traceback 里的 ANSI 颜色转成 span */
export function ansiToHtml(s: string): string {
  let out = '';
  let open = false;
  let last = 0;
  // eslint-disable-next-line no-control-regex -- ANSI 颜色码
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m/g)) {
    out += esc(s.slice(last, m.index));
    last = m.index! + m[0].length;
    if (open) {
      out += '</span>';
      open = false;
    }
    const codes = (m[1] || '0').split(';').map(Number);
    const styles: string[] = [];
    for (const c of codes) {
      if (c === 1) styles.push('font-weight:600');
      if (c >= 30 && c <= 37) styles.push(`color:${ANSI_COLORS[c - 30]}`);
      if (c >= 90 && c <= 97) styles.push(`color:${ANSI_COLORS[c - 90]}`);
      if (c >= 40 && c <= 47) styles.push(`background:${ANSI_COLORS[c - 40]}22`);
    }
    if (styles.length) {
      out += `<span style="${styles.join(';')}">`;
      open = true;
    }
  }
  out += esc(s.slice(last).replace(ANSI, ''));
  return open ? `${out}</span>` : out;
}

function outputHtml(o: NbOutput): string {
  if (o.output_type === 'stream') {
    return `<pre class="out ${o.name === 'stderr' ? 'stderr' : ''}">${ansiToHtml(o.text)}</pre>`;
  }
  if (o.output_type === 'error') {
    return `<pre class="out err">${ansiToHtml(o.traceback.join('\n') || `${o.ename}: ${o.evalue}`)}</pre>`;
  }
  const d = o.data;
  if (d['application/vnd.srh.metrics+json']) {
    const m = d['application/vnd.srh.metrics+json'] as {
      kind?: string;
      values?: Record<string, unknown>;
    };
    const rows = Object.entries(m.values ?? {})
      .map(([k, v]) => `<span class="kv"><b>${esc(k)}</b> ${esc(String(v))}</span>`)
      .join('');
    return `<div class="metrics"><span class="tag">${m.kind === 'params' ? '参数' : '指标'}</span>${rows}</div>`;
  }
  if (d['text/html'] !== undefined)
    return `<div class="html">${sanitizeHtml(text(d['text/html']))}</div>`;
  const img = imageOf(o);
  if (img) return `<img class="img" src="data:${img.mime};base64,${img.b64}" alt="output">`;
  if (d['image/svg+xml'] !== undefined)
    return `<div class="svg">${sanitizeHtml(text(d['image/svg+xml']))}</div>`;
  if (d['text/latex'] !== undefined)
    return `<div class="md">${renderMarkdown(text(d['text/latex']))}</div>`;
  if (d['text/markdown'] !== undefined)
    return `<div class="md">${renderMarkdown(text(d['text/markdown']))}</div>`;
  if (d['application/json'] !== undefined) {
    return `<pre class="out">${esc(JSON.stringify(d['application/json'], null, 2))}</pre>`;
  }
  if (d['text/plain'] !== undefined)
    return `<pre class="out">${ansiToHtml(text(d['text/plain']))}</pre>`;
  return '';
}

function cellHtml(c: PlainCell): string {
  if (c.type === 'markdown')
    return `<section class="cell md">${renderMarkdown(c.source)}</section>`;
  if (c.type === 'raw') return `<section class="cell raw"><pre>${esc(c.source)}</pre></section>`;
  const n = c.executionCount ?? ' ';
  const outs = c.outputs.map(outputHtml).join('');
  const outPrompt =
    c.outputs.some((o) => o.output_type === 'execute_result') && c.executionCount !== null
      ? `Out[${c.executionCount}]:`
      : '';
  return `<section class="cell code">
  <div class="row"><div class="prompt in">In [${n}]:</div><pre class="src">${highlightPython(c.source)}</pre></div>
  ${outs ? `<div class="row"><div class="prompt outp">${outPrompt}</div><div class="outs">${outs}</div></div>` : ''}
</section>`;
}

const CSS = `
:root{--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--code:#f6f8fa;--accent:#3b5bdb}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 32px 80px}
header{border-bottom:1px solid var(--line);margin-bottom:24px;padding-bottom:12px}
header h1{font-size:22px;margin:0 0 4px}
header .meta{color:var(--muted);font-size:12px}
.cell{margin:10px 0;break-inside:avoid-page}
.row{display:flex;gap:8px;align-items:flex-start}
.prompt{flex:0 0 72px;text-align:right;font:12px/1.9 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);padding-top:6px}
.prompt.in{color:#3b5bdb}.prompt.outp{color:#c2410c}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK SC",monospace}
pre.src{flex:1;min-width:0;background:var(--code);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
.outs{flex:1;min-width:0;padding:4px 0}
pre.out{padding:4px 2px}
pre.stderr{background:#fff5f5}
pre.err{background:#fff5f5;border-left:3px solid #e03131;padding:6px 10px}
.img{max-width:100%;height:auto;display:block}
.html table{border-collapse:collapse;font-size:12.5px;margin:4px 0}
.html th,.html td{border:1px solid var(--line);padding:3px 8px;text-align:right}
.html th{background:#f9fafb}
.html tr:nth-child(even) td{background:#fafafa}
.cell.md{padding:0 0 0 80px}
.cell.md h1,.cell.md h2,.cell.md h3{line-height:1.3;margin:18px 0 8px}
.cell.md pre{background:var(--code);padding:8px 10px;border-radius:6px}
.cell.md code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:.92em}
.cell.md img{max-width:100%}
.cell.md table{border-collapse:collapse}.cell.md th,.cell.md td{border:1px solid var(--line);padding:3px 8px}
.cell.raw pre{color:var(--muted);padding-left:80px}
.metrics{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12.5px;padding:2px 0}
.metrics .tag{background:#eef2ff;color:var(--accent);border-radius:4px;padding:0 6px}
.metrics .kv{border:1px solid var(--line);border-radius:4px;padding:0 6px}
.k{color:#7c3aed;font-weight:500}.s{color:#0a7d32}.c{color:#8b949e;font-style:italic}.n{color:#b45309}.b{color:#1d5fbf}.d{color:#b45309}
@media print{main{padding:0;max-width:none}.cell{break-inside:auto}pre.src{break-inside:avoid}}
`;

export function toHtml(
  nb: PlainNotebook,
  title: string,
  meta: { author?: string; exportedAt?: Date } = {},
): string {
  const when = (meta.exportedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ');
  // 第一个单元格本身就是同名一级标题时，页眉不再重复标题
  const first = nb.cells[0];
  const dupTitle = first?.type === 'markdown' && first.source.trimStart().startsWith(`# ${title}`);
  const h1 = dupTitle ? '' : `<h1>${esc(title)}</h1>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<header>${h1}<div class="meta">研协 Notebook · 导出于 ${when}${meta.author ? ` · ${esc(meta.author)}` : ''}</div></header>
${nb.cells.map(cellHtml).join('\n')}
</main></body></html>
`;
}

// ---------------------------------------------------------------- .pdf

export function findChromium(configured = ''): string | null {
  const candidates = [
    configured,
    process.env.CHROMIUM_PATH ?? '',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  // 本地开发：Playwright 下载的 Chromium
  const pwRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
          'ms-playwright',
        )
      : path.join(homedir(), '.cache', 'ms-playwright'));
  try {
    for (const dir of readdirSync(pwRoot)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()) {
      candidates.push(
        path.join(pwRoot, dir, 'chrome-win64', 'chrome.exe'),
        path.join(pwRoot, dir, 'chrome-win', 'chrome.exe'),
        path.join(pwRoot, dir, 'chrome-linux', 'chrome'),
        path.join(pwRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  } catch {
    /* 没有 ms-playwright */
  }
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

export async function htmlToPdf(html: string, chromiumPath: string | null): Promise<Buffer> {
  if (!chromiumPath) {
    throw new ApiError(
      'not_implemented',
      '服务器没有安装 Chromium，暂时不能导出 PDF；可以先导出 HTML 再用浏览器打印',
    );
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    // 导出内容来自内核输出（可能含脚本）：打印时关掉 JS，也不让页面联网
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:9px;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- .zip

/** 最小 ZIP 写入（deflate，UTF-8 文件名） */
export function zip(entries: { name: string; data: Buffer }[], now = new Date()): Buffer {
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- 入口

export async function exportNotebook(
  nb: PlainNotebook,
  title: string,
  format: NotebookExportFormat,
  opts: { chromiumPath?: string | null; author?: string } = {},
): Promise<ExportFile> {
  const base = safeFilename(title);
  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  switch (format) {
    case 'ipynb':
      return {
        filename: `${base}.ipynb`,
        contentType: 'application/x-ipynb+json',
        body: utf8(`${JSON.stringify(toIpynb(nb), null, 1)}\n`),
      };
    case 'py':
      return {
        filename: `${base}.py`,
        contentType: 'text/x-python; charset=utf-8',
        body: utf8(toPy(nb, title)),
      };
    case 'md':
      return {
        filename: `${base}.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: utf8(toMarkdown(nb, title)),
      };
    case 'html':
      return {
        filename: `${base}.html`,
        contentType: 'text/html; charset=utf-8',
        body: utf8(toHtml(nb, title, opts)),
      };
    case 'pdf':
      return {
        filename: `${base}.pdf`,
        contentType: 'application/pdf',
        body: await htmlToPdf(toHtml(nb, title, opts), opts.chromiumPath ?? null),
      };
    case 'zip': {
      const images: ImageRef[] = [];
      const mdText = toMarkdown(nb, title, images);
      const html = toHtml(nb, title, opts);
      const entries = [
        { name: `${base}/${base}.ipynb`, data: utf8(`${JSON.stringify(toIpynb(nb), null, 1)}\n`) },
        { name: `${base}/${base}.py`, data: utf8(toPy(nb, title)) },
        { name: `${base}/${base}.md`, data: utf8(mdText) },
        { name: `${base}/${base}.html`, data: utf8(html) },
        ...images.map((i) => ({ name: `${base}/${i.name}`, data: i.data })),
      ];
      if (opts.chromiumPath) {
        try {
          entries.push({
            name: `${base}/${base}.pdf`,
            data: await htmlToPdf(html, opts.chromiumPath),
          });
        } catch {
          /* PDF 失败不影响打包其余格式 */
        }
      }
      return { filename: `${base}.zip`, contentType: 'application/zip', body: zip(entries) };
    }
    default:
      throw new ApiError('validation_failed', `不支持的导出格式：${String(format)}`);
  }
}
