import lexing, { type LexToken } from 'fast-formula-parser/grammar/lexing';
import { colIndex, colName } from '../lib/a1';

/**
 * 公式里引用的改写（插入 / 删除行列、复制粘贴的相对引用平移、工作表改名 / 删除）。
 * 词法分析用 fast-formula-parser 自带的 chevrotain 词法器，所以字符串字面量、函数名、
 * 带引号的工作表名都按 Excel 语法识别，不会误改。
 */

export interface RefEnd {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
}

export type RefKind = 'cell' | 'range' | 'cols' | 'rows';

export interface FormulaRef {
  kind: RefKind;
  /** 公式里写的工作表名（未写为 null = 公式所在表） */
  sheet: string | null;
  a: RefEnd;
  b: RefEnd;
}

/** 返回 undefined = 不变；null = 引用失效（写成 #REF!）；否则替换为新引用 */
export type RefMapper = (ref: FormulaRef) => FormulaRef | null | undefined;

function lex(body: string): LexToken[] | null {
  try {
    return lexing.lex(body).tokens;
  } catch {
    return null;
  }
}

function parseCellImage(image: string): RefEnd | null {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/u.exec(image);
  if (!m) return null;
  return {
    absCol: m[1] === '$',
    col: colIndex(m[2] ?? ''),
    absRow: m[3] === '$',
    row: Number(m[4]) - 1,
  };
}

function sheetOf(tok: LexToken): string {
  const img = tok.image.slice(0, -1); // 去掉 !
  if (tok.tokenType.name === 'SheetQuoted') return img.slice(1, -1).replace(/''/gu, "'");
  return img;
}

/** 工作表名在公式里的写法：必要时加单引号 */
export function quoteSheet(name: string): string {
  if (
    /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff]*$/u.test(name) &&
    !/^[A-Za-z]{1,3}\d+$/u.test(name)
  ) {
    return name;
  }
  return `'${name.replace(/'/gu, "''")}'`;
}

function endText(e: RefEnd, kind: RefKind): string {
  if (kind === 'cols') return `${e.absCol ? '$' : ''}${colName(e.col)}`;
  if (kind === 'rows') return `${e.absRow ? '$' : ''}${e.row + 1}`;
  return `${e.absCol ? '$' : ''}${colName(e.col)}${e.absRow ? '$' : ''}${e.row + 1}`;
}

export function refText(ref: FormulaRef): string {
  const prefix = ref.sheet !== null ? `${quoteSheet(ref.sheet)}!` : '';
  if (ref.kind === 'cell') return prefix + endText(ref.a, 'cell');
  return `${prefix}${endText(ref.a, ref.kind)}:${endText(ref.b, ref.kind)}`;
}

/** 列出公式里的全部引用（不改写） */
export function listRefs(raw: string): FormulaRef[] {
  const out: FormulaRef[] = [];
  rewriteFormula(raw, (r) => {
    out.push(r);
    return undefined;
  });
  return out;
}

/**
 * 改写公式里的引用。raw 带不带开头的 = 都行；非公式或词法错误时原样返回。
 */
export function rewriteFormula(raw: string, map: RefMapper): string {
  const hasEq = raw.startsWith('=');
  const body = hasEq ? raw.slice(1) : raw;
  const toks = lex(body);
  if (!toks) return raw;
  let out = '';
  let last = 0;
  let changed = false;
  for (let i = 0; i < toks.length; i += 1) {
    const start = toks[i]!;
    let j = i;
    let sheet: string | null = null;
    if (start.tokenType.name === 'Sheet' || start.tokenType.name === 'SheetQuoted') {
      sheet = sheetOf(start);
      j += 1;
    }
    const t1 = toks[j];
    if (!t1) continue;
    const colon = toks[j + 1];
    const t2 = toks[j + 2];
    const adjacent = (x: LexToken | undefined, y: LexToken | undefined) =>
      !!x && !!y && x.endOffset + 1 === y.startOffset;
    let ref: FormulaRef | null = null;
    let endTok: LexToken = t1;
    const name1 = t1.tokenType.name;
    if (name1 === 'Cell') {
      const a = parseCellImage(t1.image);
      if (!a) continue;
      if (
        colon?.tokenType.name === 'Colon' &&
        t2?.tokenType.name === 'Cell' &&
        adjacent(t1, colon)
      ) {
        const b = parseCellImage(t2.image);
        if (!b) continue;
        ref = { kind: 'range', sheet, a, b };
        endTok = t2;
      } else {
        ref = { kind: 'cell', sheet, a, b: a };
      }
    } else if (
      (name1 === 'Column' || name1 === 'Name') &&
      colon?.tokenType.name === 'Colon' &&
      (t2?.tokenType.name === 'Column' || t2?.tokenType.name === 'Name') &&
      /^\$?[A-Za-z]{1,3}$/u.test(t1.image) &&
      /^\$?[A-Za-z]{1,3}$/u.test(t2.image)
    ) {
      const mk = (img: string): RefEnd => ({
        absCol: img.startsWith('$'),
        col: colIndex(img.replace('$', '')),
        absRow: false,
        row: 0,
      });
      ref = { kind: 'cols', sheet, a: mk(t1.image), b: mk(t2.image) };
      endTok = t2;
    } else if (
      name1 === 'Number' &&
      colon?.tokenType.name === 'Colon' &&
      t2?.tokenType.name === 'Number' &&
      /^\d+$/u.test(t1.image) &&
      /^\d+$/u.test(t2.image) &&
      adjacent(t1, colon) &&
      adjacent(colon, t2)
    ) {
      const mk = (img: string): RefEnd => ({
        absCol: false,
        col: 0,
        absRow: false,
        row: Number(img) - 1,
      });
      ref = { kind: 'rows', sheet, a: mk(t1.image), b: mk(t2.image) };
      endTok = t2;
    }
    if (!ref) continue;
    const next = map(ref);
    if (next !== undefined) {
      out += body.slice(last, start.startOffset) + (next === null ? '#REF!' : refText(next));
      last = endTok.endOffset + 1;
      changed = true;
    }
    i = toks.indexOf(endTok);
  }
  if (!changed) return raw;
  out += body.slice(last);
  return hasEq ? `=${out}` : out;
}

function sameSheet(ref: FormulaRef, formulaSheet: string, target: string): boolean {
  const s = ref.sheet ?? formulaSheet;
  return s.toLowerCase() === target.toLowerCase();
}

/**
 * 在 target 表的 at 处插入 count 行/列（count < 0 为从 at 起删除 -count 行/列）后，
 * 公式（位于 formulaSheet）里指向 target 的引用怎么变。
 */
export function shiftFormula(
  raw: string,
  formulaSheet: string,
  target: string,
  axis: 'row' | 'col',
  at: number,
  count: number,
): string {
  if (count === 0) return raw;
  return rewriteFormula(raw, (ref) => {
    if (!sameSheet(ref, formulaSheet, target)) return undefined;
    if (axis === 'row' && ref.kind === 'cols') return undefined;
    if (axis === 'col' && ref.kind === 'rows') return undefined;
    const key = axis === 'row' ? 'row' : 'col';
    let p = ref.a[key];
    let q = ref.b[key];
    if (count > 0) {
      if (p >= at) p += count;
      if (q >= at) q += count;
    } else {
      const del0 = at;
      const del1 = at - count - 1;
      if (ref.kind === 'cell') {
        if (p >= del0 && p <= del1) return null;
        if (p > del1) p += count;
      } else {
        const lo = Math.min(p, q);
        const hi = Math.max(p, q);
        if (lo >= del0 && hi <= del1) return null;
        let nlo = lo;
        let nhi = hi;
        if (nlo > del1) nlo += count;
        else if (nlo >= del0) nlo = del0;
        if (nhi > del1) nhi += count;
        else if (nhi >= del0) nhi = del0 - 1;
        p = nlo;
        q = nhi;
      }
    }
    if (p === ref.a[key] && q === ref.b[key]) return undefined;
    return {
      ...ref,
      a: { ...ref.a, [key]: p },
      b: { ...ref.b, [key]: ref.kind === 'cell' ? p : q },
    };
  });
}

/** 复制粘贴 / 填充：相对引用随目标位置平移（$ 部分不动），越界变 #REF! */
export function offsetFormula(raw: string, dRow: number, dCol: number): string {
  if (!raw.startsWith('=') || (dRow === 0 && dCol === 0)) return raw;
  return rewriteFormula(raw, (ref) => {
    const move = (e: RefEnd): RefEnd | null => {
      const row = e.absRow || ref.kind === 'cols' ? e.row : e.row + dRow;
      const col = e.absCol || ref.kind === 'rows' ? e.col : e.col + dCol;
      if (row < 0 || col < 0) return null;
      return { ...e, row, col };
    };
    const a = move(ref.a);
    const b = move(ref.b);
    if (!a || !b) return null;
    return { ...ref, a, b };
  });
}

/** 工作表改名：引用了旧名字的地方换成新名字 */
export function renameSheetInFormula(raw: string, from: string, to: string): string {
  return rewriteFormula(raw, (ref) =>
    ref.sheet !== null && ref.sheet.toLowerCase() === from.toLowerCase()
      ? { ...ref, sheet: to }
      : undefined,
  );
}

/** 工作表被删除：引用它的地方变成 #REF! */
export function dropSheetInFormula(raw: string, name: string): string {
  return rewriteFormula(raw, (ref) =>
    ref.sheet !== null && ref.sheet.toLowerCase() === name.toLowerCase() ? null : undefined,
  );
}
