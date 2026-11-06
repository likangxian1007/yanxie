import { downloadText, safeFileName } from '../shared/dom';
import { tr } from '@/lib/i18n';

/** 下载 .tex 源码 */
export function downloadTex(title: string, source: string): void {
  downloadText(`${safeFileName(title, tr('未命名论文'))}.tex`, source, 'application/x-tex');
}

/**
 * “导出 PDF”：打开一个只有预览内容的新窗口（复制当前页面的样式表），排版完成后调用打印，
 * 由浏览器的“另存为 PDF”生成文件。返回 false 表示弹窗被拦截。
 */
export function printPreview(title: string, sanitizedHtml: string): boolean {
  const win = window.open('', '_blank', 'noopener=no,width=900,height=1100');
  if (!win) return false;
  const doc = win.document;
  doc.title = safeFileName(title, tr('未命名论文'));
  doc.documentElement.lang = 'zh-CN';
  // 打印始终用浅色
  doc.documentElement.removeAttribute('data-theme');
  for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
    const clone = doc.importNode(node, true) as HTMLElement;
    if (clone instanceof HTMLLinkElement && node instanceof HTMLLinkElement) clone.href = node.href;
    doc.head.appendChild(clone);
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  doc.body.className = 'ltx-print-body';
  const article = doc.createElement('article');
  article.className = 'ltx-paper ltx-print';
  article.innerHTML = sanitizedHtml;
  doc.body.appendChild(article);

  let printed = false;
  const go = () => {
    if (printed || win.closed) return;
    printed = true;
    win.focus();
    win.print();
  };
  const ready = () => {
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) void fonts.ready.then(() => window.setTimeout(go, 150));
    else window.setTimeout(go, 300);
  };
  // 样式表需要时间加载：等 load 事件，兜底 1.5s
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
  return true;
}
