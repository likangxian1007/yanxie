import type { Editor } from '@tiptap/core';
import { withBase } from '@/lib/base-path';
import { downloadBlob, downloadText, safeFileName } from '../../shared/dom';
import type { PmJSON } from './docx-export';
import { paperMm, type PageSetup } from './page';
import { tr } from '@/lib/i18n';

/**
 * 富文本的导出：Word（.docx）、PDF（打印版式 → 浏览器“另存为 PDF”）、HTML。
 * markdown 导出仍走服务端的 markdown 表示（详情页“更多操作”与这里的菜单共用 fetchDocMarkdown）。
 */

export async function downloadWord(editor: Editor, title: string, page: PageSetup): Promise<void> {
  // docx 库较大，用到时才加载
  const { exportDocx, fetchImage } = await import('./docx-export');
  const blob = await exportDocx(editor.getJSON() as PmJSON, {
    title,
    page,
    loadImage: async (src) => {
      try {
        return await fetchImage(src);
      } catch {
        return null;
      }
    },
  });
  downloadBlob(`${safeFileName(title, tr('未命名文档'))}.docx`, blob);
}

/** 导出时不要的东西：协同光标、评论高亮、搜索高亮、分页 widget、拖拽手柄、节点上的按钮 */
const STRIP_SELECTORS = [
  '.rich-caret',
  '.rich-page-gap',
  '.rich-page-fill',
  '.ProseMirror-widget',
  '.ProseMirror-gapcursor',
  '.column-resize-handle',
  `button[aria-label^="${tr('删除')}"]`,
  '.rich-upload',
];
const UNWRAP_CLASSES = [
  'rich-peer-selection',
  'rich-comment',
  'rich-search-match',
  'rich-jump-flash',
];

/** 复制编辑器当前渲染出的正文（含目录、图片、公式等节点视图），去掉编辑态的装饰 */
export function snapshotHtml(editor: Editor): string {
  const clone = editor.view.dom.cloneNode(true) as HTMLElement;
  for (const sel of STRIP_SELECTORS) clone.querySelectorAll(sel).forEach((el) => el.remove());
  for (const cls of UNWRAP_CLASSES) {
    clone.querySelectorAll(`.${cls}`).forEach((el) => {
      if (el.tagName === 'SPAN' && el.attributes.length <= 2)
        el.replaceWith(...Array.from(el.childNodes));
      else el.classList.remove(cls);
    });
  }
  clone
    .querySelectorAll('[contenteditable]')
    .forEach((el) => el.removeAttribute('contenteditable'));
  clone
    .querySelectorAll('.is-empty[data-placeholder]')
    .forEach((el) => el.removeAttribute('data-placeholder'));
  clone.querySelectorAll('img').forEach((img) => {
    // 相对地址在新窗口 / 下载的 HTML 里也能打开
    const src = img.getAttribute('src');
    if (src && !/^(data:|blob:|https?:)/u.test(src))
      img.setAttribute('src', new URL(withBase(src), window.location.origin).toString());
  });
  return `${clone.innerHTML}${footnoteListHtml(editor)}`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** 文末的脚注列表（编辑器里的脚注在正文显示为上标编号） */
export function footnoteListHtml(editor: Editor): string {
  const notes: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'footnote') notes.push(String(node.attrs.content ?? ''));
    return true;
  });
  if (notes.length === 0) return '';
  return tr(
    '<section class="rich-footnote-list" aria-label="脚注"><hr><ol>{value}</ol></section>',
    { value: notes.map((n) => `<li>${escapeHtml(n) || '&nbsp;'}</li>`).join('') },
  );
}

/** 打印版式的 @page：纸张、方向、页边距 */
export function pageCss(page: PageSetup): string {
  const { width, height } = paperMm(page);
  return `@page { size: ${width}mm ${height}mm; margin: ${page.marginTop}mm ${page.marginRight}mm ${page.marginBottom}mm ${page.marginLeft}mm; }`;
}

/**
 * 打开打印版式（新窗口：只有正文，A4 等纸张、页边距、分页符换页，浅色），自动弹出打印对话框，
 * 选“另存为 PDF”即得到 PDF。返回 false 表示弹窗被浏览器拦截。
 */
export function printDocument(
  editor: Editor,
  title: string,
  page: PageSetup,
  autoPrint = true,
): Window | null {
  const win = window.open('', '_blank', 'noopener=no,width=960,height=1100');
  if (!win) return null;
  const doc = win.document;
  doc.title = safeFileName(title, tr('未命名文档'));
  doc.documentElement.lang = 'zh-CN';
  doc.documentElement.setAttribute('data-theme', 'light');
  for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const clone = doc.importNode(node, true) as HTMLElement;
    if (clone instanceof HTMLLinkElement && node instanceof HTMLLinkElement) clone.href = node.href;
    doc.head.appendChild(clone);
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const style = doc.createElement('style');
  const { width } = paperMm(page);
  style.textContent = `${pageCss(page)}
:root { --rich-print-width: ${width - page.marginLeft - page.marginRight}mm; }`;
  doc.head.appendChild(style);
  doc.body.className = 'rich-print-body';
  const article = doc.createElement('article');
  article.className = 'rich-prose rich-print';
  article.innerHTML = snapshotHtml(editor);
  doc.body.appendChild(article);

  if (!autoPrint) return win;
  let printed = false;
  const go = () => {
    if (printed || win.closed) return;
    printed = true;
    win.focus();
    win.print();
  };
  const ready = () => {
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    const images = Array.from(doc.images).filter((img) => !img.complete);
    const imagesReady = Promise.all(
      images.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    );
    void Promise.all([fonts?.ready, imagesReady]).then(() => window.setTimeout(go, 150));
  };
  const links = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]'));
  if (links.length === 0) ready();
  else {
    let pending = links.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) ready();
    };
    for (const l of links) {
      l.addEventListener('load', done, { once: true });
      l.addEventListener('error', done, { once: true });
    }
    window.setTimeout(ready, 1500);
  }
  return win;
}

/** 下载独立的 HTML（内联基础排版样式，离线也能看） */
export function downloadHtml(editor: Editor, title: string, page: PageSetup) {
  const body = snapshotHtml(editor);
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
${pageCss(page)}
body { max-width: 820px; margin: 40px auto; padding: 0 24px; font: 11pt/1.75 Calibri, "Microsoft YaHei", "PingFang SC", sans-serif; color: #18181b; }
h1 { font-size: 18pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #bfbfbf; padding: 4px 8px; vertical-align: top; } th { background: #f2f2f2; }
img { max-width: 100%; } blockquote { border-left: 3px solid #d4d3cd; margin: 0; padding-left: 12px; color: #4f4f59; }
pre { background: #f3f4f6; padding: 8px 12px; } mark { background: #fff3a3; }
div[data-type="page-break"] { break-after: page; height: 0; }
.rich-footnote { counter-increment: rich-fn; } .rich-footnote::after { content: counter(rich-fn); font-size: 0.75em; vertical-align: super; }
.rich-print, body { counter-reset: rich-fn; } .rich-footnote-list { font-size: 9pt; }
nav[data-type="toc"] ol { list-style: none; padding-left: 0; } nav[data-type="toc"] button { all: unset; display: flex; gap: 8px; }
</style></head><body><h1 class="doc-title" style="display:none">${escapeHtml(title)}</h1>${body}</body></html>`;
  downloadText(`${safeFileName(title, tr('未命名文档'))}.html`, html, 'text/html');
}
