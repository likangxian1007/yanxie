import { cssOfStyle, DEFAULT_FONT_PT, ptToCssPx } from '../render/style';
import type { Workbook } from '../model/workbook';
import { displayOf } from '../model/workbook';
import { tr } from '@/lib/i18n';

/**
 * 导出 PDF：生成只含表格的打印视图（HTML 表格，带样式、合并、列宽），交给浏览器“打印 → 另存为 PDF”。
 * 用浏览器排版而不是 JS 生成 PDF，中文字体不用额外打包。每张表另起一页，宽表自动横向并缩放到页宽，
 * 行不会被拆到两页。
 */

const esc = (s: string) =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** A4 可打印宽度（px，96dpi，去掉 12mm 页边距）：纵向 / 横向 */
const PORTRAIT_W = 703;
const LANDSCAPE_W = 1032;
/** 文本列为了放下内容最多加宽到这么宽，再长就换行 */
const TEXT_COL_MAX = 360;
/** 左右 padding 4+4、边框、给字体差异留的余量 */
const CELL_PAD = 14;

interface PrintCell {
  c: number;
  span: string;
  style: string;
  text: string;
  spill: boolean;
  spillCols: number[];
  need: number;
  isText: boolean;
  wrap: boolean;
}

/**
 * 估算一行文字的显示宽度（px）。打印视图在生成 HTML 时还没有排版环境，按字符类别估：
 * 中日韩 / 全角 1em，数字 0.62em（Inter / 雅黑的数字都不超过），大写 0.7em，其他 0.56em；宁宽勿窄。
 */
export function textWidthPx(text: string, fontPx: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      code >= 0x20000
    )
      em += 1;
    else if (ch >= '0' && ch <= '9') em += 0.62;
    else if (ch === ' ') em += 0.3;
    else if (/[A-Z@%&MWmw#]/u.test(ch)) em += 0.72;
    else if (/[.,:;'!|iIl]/u.test(ch)) em += 0.32;
    else em += 0.56;
  }
  return em * fontPx * (bold ? 1.08 : 1);
}

export function buildPrintHtml(wb: Workbook, title: string, sheetIds = wb.sheetIds()): string {
  const visible = sheetIds.filter((id) => !wb.sheetInfo(id).hidden);
  const sections: string[] = [];
  let landscape = false;
  for (const id of visible) {
    const s = wb.sheet(id);
    const bounds = s.usedBounds(true);
    const name = esc(wb.sheetInfo(id).name);
    if (!bounds) {
      sections.push(
        tr('<section><h2>{name}</h2><p class="empty">（空表）</p></section>', { name }),
      );
      continue;
    }
    const cols: number[] = [];
    for (let c = 0; c < bounds.cols; c += 1) if (!s.colHidden(c)) cols.push(c);
    // 列宽：至少是表里设的宽度；放不下的内容按估算的文字宽度把列加宽（数字、日期一律加宽，
    // 文本最多加到 TEXT_COL_MAX，再长就在格内换行），保证打印 / PDF 里不裁字
    const colW = new Map(cols.map((c) => [c, s.colWidth(c)]));
    const covered = new Set<string>();
    const cells: PrintCell[][] = [];
    const rowIndex: number[] = [];
    for (let r = 0; r < bounds.rows; r += 1) {
      if (s.rowHidden(r)) continue;
      const tds: PrintCell[] = [];
      for (const c of cols) {
        if (covered.has(`${r}:${c}`)) continue;
        const m = s.mergeAt(r, c);
        let span = '';
        if (m) {
          if (m.r0 !== r || m.c0 !== c) continue;
          let rs = 0;
          for (let i = m.r0; i <= m.r1; i += 1) if (!s.rowHidden(i)) rs += 1;
          const cs = cols.filter((x) => x >= m.c0 && x <= m.c1).length;
          for (let i = m.r0; i <= m.r1; i += 1)
            for (let j = m.c0; j <= m.c1; j += 1) covered.add(`${i}:${j}`);
          if (rs > 1) span += ` rowspan="${rs}"`;
          if (cs > 1) span += ` colspan="${cs}"`;
        }
        const st = s.style(r, c);
        const value = s.value(r, c);
        const d = displayOf(s, r, c);
        const css = cssOfStyle(st, value, d.color);
        const style = Object.entries(css)
          .map(([k, v]) => `${k.replace(/[A-Z]/gu, (x) => `-${x.toLowerCase()}`)}:${v}`)
          .join(';');
        // 与网格一致：不换行的文本在右边相邻格为空时溢出显示，而不是被截断
        const at = cols.indexOf(c);
        const next = cols[at + 1];
        const isText = typeof value === 'string';
        const spill =
          !m &&
          isText &&
          !st?.wrap &&
          (css.textAlign ?? 'left') === 'left' &&
          next !== undefined &&
          !s.raw(r, next) &&
          !s.mergeAt(r, next);
        // 溢出能用到的右侧连续空格子
        const spillCols: number[] = [];
        if (spill)
          for (let i = at + 1; i < cols.length; i += 1) {
            const x = cols[i]!;
            if (s.raw(r, x) || s.mergeAt(r, x)) break;
            spillCols.push(x);
          }
        const fontPx = ptToCssPx(st?.fs ?? DEFAULT_FONT_PT);
        const need = m || st?.wrap || !d.text ? 0 : textWidthPx(d.text, fontPx, !!st?.b) + CELL_PAD;
        tds.push({ c, span, style, text: d.text, spill, spillCols, need, isText, wrap: false });
      }
      cells.push(tds);
      rowIndex.push(r);
    }
    // 加宽：溢出的文本只在「自己 + 右侧空格」都放不下时才加宽自己这一列
    for (const row of cells)
      for (const cell of row) {
        if (!cell.need) continue;
        const room = cell.spillCols.reduce((sum, x) => sum + (colW.get(x) ?? 0), 0);
        const own = colW.get(cell.c) ?? 0;
        if (own + room >= cell.need) continue;
        const target = cell.isText
          ? Math.min(cell.need - room, Math.max(own, TEXT_COL_MAX))
          : cell.need - room;
        if (target > own) colW.set(cell.c, Math.ceil(target));
      }
    // 加宽后仍放不下的长文本：在格内换行，不裁字
    for (const row of cells)
      for (const cell of row) {
        if (!cell.need || !cell.isText) continue;
        const room = cell.spillCols.reduce((sum, x) => sum + (colW.get(x) ?? 0), 0);
        if ((colW.get(cell.c) ?? 0) + room < cell.need) cell.wrap = true;
      }
    const width = cols.reduce((sum, c) => sum + (colW.get(c) ?? 0), 0);
    if (width > PORTRAIT_W) landscape = true;
    const zoom = width > LANDSCAPE_W ? LANDSCAPE_W / width : 1;
    const rows = cells.map((row, i) => {
      const tds = row.map((cell) => {
        const cls = cell.wrap ? ' class="wrap"' : cell.spill ? ' class="spill"' : '';
        return `<td${cell.span}${cls} style="${esc(cell.style)}">${esc(cell.text)}</td>`;
      });
      return `<tr style="height:${s.rowHeight(rowIndex[i]!)}px">${tds.join('')}</tr>`;
    });
    const colgroup = cols.map((c) => `<col style="width:${colW.get(c)}px">`).join('');
    sections.push(
      `<section><h2>${name}</h2><table style="width:${width}px;zoom:${zoom.toFixed(4)}"><colgroup>${colgroup}</colgroup><tbody>${rows.join('')}</tbody></table></section>`,
    );
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Inter Variable", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #1c2024; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h2 { font-size: 12px; font-weight: 600; margin: 0 0 6px; color: #60646c; }
section + section { break-before: page; }
table { border-collapse: collapse; table-layout: fixed; font-size: ${ptToCssPx(DEFAULT_FONT_PT)}px; }
td { border: 1px solid #e0e1e6; padding: 0 4px; overflow: hidden; white-space: nowrap; vertical-align: bottom; }
td.spill { overflow: visible; position: relative; z-index: 1; }
td.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
tr { break-inside: avoid; }
.empty { color: #8b8d98; font-size: 12px; }
</style></head><body>${sections.join('')}</body></html>`;
}

/** 在隐藏的 iframe 里打开打印视图并调用打印（用户在打印对话框里选“另存为 PDF”） */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0';
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    // 有的浏览器不触发 afterprint
    setTimeout(cleanup, 60_000);
  }, 200);
}
