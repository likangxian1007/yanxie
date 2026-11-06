/**
 * 合并工具（乐观并发冲突时用）：
 * - deepEqual：字段值比较（字符串、数组、对象）
 * - mergeText：三方合并 base / mine / theirs，作为「手动合并」的初稿。
 *   按行对齐；双方改到同一处时先尝试字符级合并（各改各的区域、或在同一处各自插入），
 *   还冲突就把两段都保留（我的在前、对方的在后），让人自己删改——绝不交错拼字。
 */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

export interface MergeResult {
  text: string;
  /** 两边都保留下来的冲突块数（0 = 干净合并） */
  conflicts: number;
}

/** 按行切开，保留换行符（拼回去和原文一致） */
function lines(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/** LCS 的格子上限；超过就不对齐（整段视为改动） */
const MAX_CELLS = 2_000_000;

/** a 与 b 的最长公共子序列，返回配对下标（递增） */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return [];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return out;
}

const same = (x: readonly string[], y: readonly string[]) =>
  x.length === y.length && x.every((v, i) => v === y[i]);

/** 相对 base 改动的区域：[start, bEnd) 被换成 insert */
function changedRegion(base: string, side: string) {
  let start = 0;
  const max = Math.min(base.length, side.length);
  while (start < max && base[start] === side[start]) start += 1;
  let bEnd = base.length;
  let sEnd = side.length;
  while (bEnd > start && sEnd > start && base[bEnd - 1] === side[sEnd - 1]) {
    bEnd -= 1;
    sEnd -= 1;
  }
  return { start, bEnd, insert: side.slice(start, sEnd) };
}

/** 两处改动之间要隔着空白或标点才分开合并（避免把 0.01 和 0.5 拼成 0.05） */
const SEPARATOR = /[\s，。、；：！？（）【】「」《》,;:!?()[\]{}]/u;

/** 一个冲突块的字符级合并；合不了返回 null */
function mergeChunkChars(base: string, mine: string, theirs: string): string | null {
  const a = changedRegion(base, mine);
  const b = changedRegion(base, theirs);
  // 同一个插入点上的两次纯插入：只在开头或末尾（各自补一句）时合并，我的在前、对方的在后
  if (a.start === a.bEnd && b.start === b.bEnd && a.start === b.start) {
    const body = base.replace(/\n$/u, '');
    if (a.start !== 0 && a.start !== body.length) return null;
    return base.slice(0, a.start) + a.insert + b.insert + base.slice(a.start);
  }
  // 区域不重叠、且中间隔着空白或标点：两处都应用
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  if (first.bEnd < second.start && SEPARATOR.test(base.slice(first.bEnd, second.start))) {
    return (
      base.slice(0, first.start) +
      first.insert +
      base.slice(first.bEnd, second.start) +
      second.insert +
      base.slice(second.bEnd)
    );
  }
  return null;
}

function withNewline(s: string): string {
  return s === '' || s.endsWith('\n') ? s : `${s}\n`;
}

export function mergeText(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { text: mine, conflicts: 0 };
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base) return { text: mine, conflicts: 0 };

  const o = lines(base);
  const a = lines(mine);
  const b = lines(theirs);
  const toA = new Map(lcsPairs(o, a));
  const toB = new Map(lcsPairs(o, b));

  let out = '';
  let conflicts = 0;
  let i = 0;
  let j = 0;
  let k = 0;
  for (;;) {
    // 下一行两边都没动过的 base 行
    let s = i;
    while (s < o.length && !(toA.has(s) && toB.has(s))) s += 1;
    const ja = s < o.length ? (toA.get(s) ?? a.length) : a.length;
    const kb = s < o.length ? (toB.get(s) ?? b.length) : b.length;
    const oc = o.slice(i, s);
    const ac = a.slice(j, ja);
    const bc = b.slice(k, kb);
    if (same(ac, oc)) out += bc.join('');
    else if (same(bc, oc) || same(ac, bc)) out += ac.join('');
    else {
      const chars = mergeChunkChars(oc.join(''), ac.join(''), bc.join(''));
      if (chars !== null) out += chars;
      else {
        conflicts += 1;
        out += withNewline(ac.join('')) + bc.join('');
      }
    }
    if (s >= o.length) break;
    out += o[s];
    i = s + 1;
    j = ja + 1;
    k = kb + 1;
  }
  return { text: out, conflicts };
}
