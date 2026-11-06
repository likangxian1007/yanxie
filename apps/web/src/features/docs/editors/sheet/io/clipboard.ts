import { cssOfStyle, DEFAULT_FONT_PT } from '../render/style';
import type { CellRange } from '../lib/a1';
import { parseTsv, toTsv } from '../lib/csv';
import type { BorderSide, CellStyle } from '../model/schema';
import { displayOf, type SheetModel } from '../model/workbook';
import { textRaw } from './xlsx';

/**
 * 剪贴板：复制时同时写 text/plain（TSV，显示值）和 text/html（带内联样式与合并的表格），
 * Excel、飞书、WPS、Google 表格粘贴都能保留样式。粘贴时优先解析 HTML 表格（含 Excel 的
 * <style> 类样式与 mso-number-format），否则按 TSV。
 */

export interface ClipCell {
  raw: string;
  style?: CellStyle;
}

export interface ClipGrid {
  cells: ClipCell[][];
  /** 相对左上角的合并区域 */
  merges: CellRange[];
}

const esc = (s: string) =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

export function copyPayload(s: SheetModel, r: CellRange): { text: string; html: string } {
  const text: string[][] = [];
  const rows: string[] = [];
  const covered = new Set<string>();
  for (let row = r.r0; row <= r.r1; row += 1) {
    if (s.rowHidden(row)) continue;
    const line: string[] = [];
    const tds: string[] = [];
    for (let col = r.c0; col <= r.c1; col += 1) {
      if (s.colHidden(col)) continue;
      const d = displayOf(s, row, col);
      line.push(d.text);
      if (covered.has(`${row}:${col}`)) continue;
      const m = s.mergeAt(row, col);
      let span = '';
      if (m && m.r0 === row && m.c0 === col) {
        const rs = Math.min(m.r1, r.r1) - row + 1;
        const cs = Math.min(m.c1, r.c1) - col + 1;
        for (let i = row; i < row + rs; i += 1)
          for (let j = col; j < col + cs; j += 1) covered.add(`${i}:${j}`);
        if (rs > 1) span += ` rowspan="${rs}"`;
        if (cs > 1) span += ` colspan="${cs}"`;
      }
      const st = s.style(row, col);
      const css = cssOfStyle(st, s.value(row, col), d.color);
      const decl = Object.entries(css)
        .filter(([k]) => k !== 'whiteSpace' || st?.wrap)
        .map(([k, v]) => `${k.replace(/[A-Z]/gu, (x) => `-${x.toLowerCase()}`)}:${v}`);
      decl.push(`font-size:${st?.fs ?? DEFAULT_FONT_PT}pt`);
      decl.push(`width:${s.colWidth(col)}px`);
      if (st?.nf) decl.push(`mso-number-format:"${st.nf.replace(/"/gu, '\\"')}"`);
      tds.push(`<td${span} style="${esc(decl.join(';'))}">${esc(d.text)}</td>`);
    }
    text.push(line);
    rows.push(`<tr style="height:${s.rowHeight(row)}px">${tds.join('')}</tr>`);
  }
  const html = `<html><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse"><tbody>${rows.join('')}</tbody></table></body></html>`;
  return { text: toTsv(text), html };
}

// ------------------------------------------------------------------ 解析 HTML

function cssColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'windowtext' || s === 'black') return '#000000';
  if (s === 'white') return '#ffffff';
  if (s === 'red') return '#ff0000';
  if (s === 'transparent' || s === 'none' || s === 'inherit') return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(s);
  if (hex) {
    const h = hex[1]!;
    return h.length === 3 ? `#${[...h].map((x) => x + x).join('')}` : `#${h}`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/u.exec(s);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return undefined;
    return `#${[rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  }
  return undefined;
}

function borderOf(v: string | undefined): BorderSide | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (!s || s === 'none' || s.startsWith('0') || s.includes('none')) return undefined;
  const width = /([\d.]+)(pt|px)/u.exec(s);
  const px = width ? Number(width[1]) * (width[2] === 'pt' ? 4 / 3 : 1) : 1;
  const style: BorderSide['s'] = s.includes('double')
    ? 'double'
    : s.includes('dashed')
      ? 'dashed'
      : s.includes('dotted')
        ? 'dotted'
        : px >= 2.5
          ? 'thick'
          : px >= 1.5
            ? 'medium'
            : 'thin';
  const color = s.split(/\s+/u).map(cssColor).find(Boolean) ?? '#000000';
  return { s: style, c: color };
}

function parseDecls(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

function styleFromDecls(d: Record<string, string>): CellStyle | undefined {
  const st: CellStyle = {};
  const fw = d['font-weight'];
  if (fw && (fw === 'bold' || Number(fw) >= 600)) st.b = true;
  if (d['font-style'] === 'italic') st.i = true;
  const deco = `${d['text-decoration'] ?? ''} ${d['text-underline-style'] ?? ''} ${d['text-decoration-line'] ?? ''}`;
  if (/underline|single/u.test(deco)) st.u = true;
  if (/line-through/u.test(deco)) st.s = true;
  const fs = /([\d.]+)(pt|px)/u.exec(d['font-size'] ?? '');
  if (fs) {
    const pt = fs[2] === 'pt' ? Number(fs[1]) : Number(fs[1]) * 0.75;
    if (Math.abs(pt - DEFAULT_FONT_PT) > 0.3) st.fs = Math.round(pt * 2) / 2;
  }
  const fc = cssColor(d.color);
  if (fc && fc !== '#000000') st.fc = fc;
  const bg = cssColor(d['background-color'] ?? d.background?.split(/\s+/u)[0]);
  if (bg && bg !== '#ffffff') st.bg = bg;
  const ta = d['text-align'];
  if (ta === 'left' || ta === 'center' || ta === 'right') st.ha = ta;
  const va = d['vertical-align'];
  if (va === 'top' || va === 'bottom') st.va = va;
  else if (va === 'middle') st.va = 'middle';
  if (d['white-space'] === 'normal' || d['white-space'] === 'pre-wrap') st.wrap = true;
  const all = d.border;
  const bt = borderOf(d['border-top'] ?? all);
  const br = borderOf(d['border-right'] ?? all);
  const bb = borderOf(d['border-bottom'] ?? all);
  const bl = borderOf(d['border-left'] ?? all);
  if (bt) st.bt = bt;
  if (br) st.br = br;
  if (bb) st.bb = bb;
  if (bl) st.bl = bl;
  const nf = d['mso-number-format'];
  if (nf) {
    const code = nf
      .replace(/^["']|["']$/gu, '')
      // CSS 转义：\0022 → "，\. → .
      .replace(/\\([0-9a-f]{1,6})\s?/giu, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\(.)/gu, '$1');
    if (code && code !== 'General' && code !== '\\@' && code !== '@') st.nf = code;
  }
  return Object.keys(st).length ? st : undefined;
}

/** 解析剪贴板 HTML 里的第一个表格；没有表格返回 null */
export function parseHtmlTable(html: string): ClipGrid | null {
  if (typeof DOMParser === 'undefined' || !/<table/iu.test(html)) return null;
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const table = dom.querySelector('table');
  if (!table) return null;
  const classRules = new Map<string, Record<string, string>>();
  const tagRules: Record<string, Record<string, string>> = {};
  dom.querySelectorAll('style').forEach((el) => {
    const css = (el.textContent ?? '').replace(/\/\*[\s\S]*?\*\/|<!--|-->/gu, '');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
      const decls = parseDecls(m[2]!);
      for (const sel of m[1]!.split(',')) {
        const s = sel.trim();
        const cls = /^(?:td|th)?\.([\w-]+)$/u.exec(s);
        if (cls) classRules.set(cls[1]!, { ...(classRules.get(cls[1]!) ?? {}), ...decls });
        else if (/^(td|th|tr|table)$/u.test(s)) tagRules[s] = { ...(tagRules[s] ?? {}), ...decls };
      }
    }
  });
  const cells: ClipCell[][] = [];
  const merges: CellRange[] = [];
  const taken = new Set<string>();
  const trs = Array.from(table.querySelectorAll('tr'));
  trs.forEach((tr, r) => {
    let c = 0;
    cells[r] ??= [];
    const rowDecls = { ...(tagRules.tr ?? {}), ...parseDecls(tr.getAttribute('style') ?? '') };
    for (const td of Array.from(tr.children)) {
      if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
      while (taken.has(`${r}:${c}`)) c += 1;
      const decls: Record<string, string> = { ...(tagRules.td ?? {}) };
      for (const k of ['font-weight', 'font-style', 'color', 'background-color', 'font-size']) {
        if (rowDecls[k]) decls[k] = rowDecls[k]!;
      }
      for (const cls of Array.from(td.classList)) Object.assign(decls, classRules.get(cls) ?? {});
      Object.assign(decls, parseDecls(td.getAttribute('style') ?? ''));
      if (td.tagName === 'TH' && !decls['font-weight']) decls['font-weight'] = 'bold';
      // 内层 <b> / <i> / <font color>（Google 表格、旧版 Office）
      if (td.querySelector('b,strong')) decls['font-weight'] = 'bold';
      if (td.querySelector('i,em')) decls['font-style'] = 'italic';
      const font = td.querySelector('font[color]');
      if (font && !decls.color) decls.color = font.getAttribute('color') ?? '';
      const text = (td as HTMLElement).innerText ?? td.textContent ?? '';
      const value = text
        .replace(/\u00a0/gu, ' ')
        .replace(/\r\n?/gu, '\n')
        .replace(/\n$/u, '');
      const rs = Math.max(1, Number(td.getAttribute('rowspan')) || 1);
      const cs = Math.max(1, Number(td.getAttribute('colspan')) || 1);
      const style = styleFromDecls(decls);
      const isTextFmt = decls['mso-number-format']?.includes('@');
      cells[r]![c] = { raw: isTextFmt ? textRaw(value) : value.trim() === '' ? '' : value, style };
      if (rs > 1 || cs > 1) merges.push({ r0: r, c0: c, r1: r + rs - 1, c1: c + cs - 1 });
      for (let i = 0; i < rs; i += 1) {
        for (let j = 0; j < cs; j += 1) {
          taken.add(`${r + i}:${c + j}`);
          if (i || j) {
            cells[r + i] ??= [];
            cells[r + i]![c + j] = { raw: '', style };
          }
        }
      }
      c += cs;
    }
  });
  const width = cells.reduce((m, l) => Math.max(m, l.length), 0);
  for (let r = 0; r < cells.length; r += 1) {
    cells[r] ??= [];
    for (let c = 0; c < width; c += 1) cells[r]![c] ??= { raw: '' };
  }
  if (cells.length === 0 || width === 0) return null;
  return { cells, merges };
}

export function parsePlain(text: string): ClipGrid {
  return { cells: parseTsv(text).map((line) => line.map((raw) => ({ raw }))), merges: [] };
}
