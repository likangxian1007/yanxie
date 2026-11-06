import { offsetFormula } from '../engine/refs';
import { isFormula, parseLiteral } from '../engine/values';
import type { CellRange } from '../lib/a1';
import type { CellStyle } from './schema';
import type { CellWrite, SheetModel } from './workbook';

/**
 * 填充柄（拖动选区右下角）：与 Excel 一致——
 * - 一格数字：复制；两格以上数字：按等差（最小二乘的步长）延续
 * - 一格日期：逐日 +1；文本末尾带数字（“第1组”“项目 3”）：数字递增
 * - 公式：相对引用随位置平移
 * - 其他文本：循环复制
 * 样式随内容一起复制。
 */

export type FillDir = 'down' | 'up' | 'right' | 'left';

interface Src {
  raw: string;
  style?: CellStyle;
}

function seriesFor(src: Src[], isDate: (i: number) => boolean): (k: number) => string | null {
  // k：目标在序列中的位置（0..src.length-1 是源本身；向后为正、向前为负）
  const n = src.length;
  const nums = src.map((s) => (isFormula(s.raw) ? null : parseLiteral(s.raw).value));
  const allNum = nums.every((v) => typeof v === 'number');
  if (allNum && (n > 1 || isDate(0))) {
    const xs = nums as number[];
    let step = 1;
    if (n > 1) {
      const mx = (n - 1) / 2;
      const my = xs.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      xs.forEach((y, i) => {
        num += (i - mx) * (y - my);
        den += (i - mx) ** 2;
      });
      step = den ? num / den : 0;
      const b = my - step * mx;
      return (k) => String(Math.round((b + step * k) * 1e10) / 1e10);
    }
    return (k) => String(xs[0]! + step * k);
  }
  const tail = src.map((s) => /^(.*?)(\d+)(\D*)$/u.exec(s.raw));
  if (!allNum && tail.every((m) => m && !isFormula(m[0])) && n >= 1) {
    const ms = tail as RegExpExecArray[];
    const prefixes = new Set(ms.map((m) => `${m[1]}|${m[3]}`));
    if (prefixes.size === 1) {
      const vals = ms.map((m) => Number(m[2]));
      const step = n > 1 ? (vals[n - 1]! - vals[0]!) / (n - 1) : 1;
      const width = ms[0]![2]!.length;
      return (k) => {
        const v = Math.round(vals[0]! + step * k);
        if (v < 0) return null;
        const digits = ms[0]![2]!.startsWith('0') ? String(v).padStart(width, '0') : String(v);
        return `${ms[0]![1]}${digits}${ms[0]![3]}`;
      };
    }
  }
  return () => null;
}

/**
 * 计算填充写入。src 是原选区，target 是拖到的完整区域（包含 src）。
 */
export function planFill(s: SheetModel, src: CellRange, target: CellRange): CellWrite[] {
  const writes: CellWrite[] = [];
  const vertical = target.r0 !== src.r0 || target.r1 !== src.r1;
  if (vertical) {
    for (let col = src.c0; col <= src.c1; col += 1) {
      const line: Src[] = [];
      for (let row = src.r0; row <= src.r1; row += 1) {
        line.push({ raw: s.raw(row, col) ?? '', style: s.style(row, col) });
      }
      const dateAt = (i: number) => /[ymd]/iu.test(s.numFmt(src.r0 + i, col) ?? '');
      const series = seriesFor(line, dateAt);
      for (let row = target.r0; row <= target.r1; row += 1) {
        if (row >= src.r0 && row <= src.r1) continue;
        const k = row - src.r0;
        const i = ((k % line.length) + line.length) % line.length;
        const from = line[i]!;
        const srcRow = src.r0 + i;
        let raw = series(k);
        if (raw === null)
          raw = isFormula(from.raw) ? offsetFormula(from.raw, row - srcRow, 0) : from.raw;
        writes.push({ row, col, raw, style: from.style ?? null });
      }
    }
  } else {
    for (let row = src.r0; row <= src.r1; row += 1) {
      const line: Src[] = [];
      for (let col = src.c0; col <= src.c1; col += 1) {
        line.push({ raw: s.raw(row, col) ?? '', style: s.style(row, col) });
      }
      const dateAt = (i: number) => /[ymd]/iu.test(s.numFmt(row, src.c0 + i) ?? '');
      const series = seriesFor(line, dateAt);
      for (let col = target.c0; col <= target.c1; col += 1) {
        if (col >= src.c0 && col <= src.c1) continue;
        const k = col - src.c0;
        const i = ((k % line.length) + line.length) % line.length;
        const from = line[i]!;
        const srcCol = src.c0 + i;
        let raw = series(k);
        if (raw === null)
          raw = isFormula(from.raw) ? offsetFormula(from.raw, 0, col - srcCol) : from.raw;
        writes.push({ row, col, raw, style: from.style ?? null });
      }
    }
  }
  return writes;
}

/** 拖动填充柄时：按拖动方向把选区扩成目标区域（只沿一个方向） */
export function fillTarget(src: CellRange, row: number, col: number): CellRange {
  const dDown = row - src.r1;
  const dUp = src.r0 - row;
  const dRight = col - src.c1;
  const dLeft = src.c0 - col;
  const v = Math.max(dDown, dUp);
  const h = Math.max(dRight, dLeft);
  if (v <= 0 && h <= 0) return src;
  if (v >= h) {
    return dDown > 0 ? { ...src, r1: row } : { ...src, r0: row };
  }
  return dRight > 0 ? { ...src, c1: col } : { ...src, c0: col };
}
