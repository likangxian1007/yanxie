import FormulaParser, { type CellRefArg, type RangeRefArg } from 'fast-formula-parser';
import { extraFunctions } from './functions';
import {
  isError,
  isFormula,
  parseLiteral,
  tidy,
  type CellError,
  type CellValue,
  type Literal,
  type Scalar,
} from './values';

/**
 * 公式引擎：fast-formula-parser（MIT）做解析与求值，functions.ts 补齐函数库。
 *
 * - 惰性求值：只算被读到的单元格（可视区、导出、排序…），10k 行的表打开时不用全算。
 * - 依赖在求值时动态记录（onCell / onRange 回调），单元格变化时沿反向依赖把受影响的公式标脏；
 *   IF 没走到的分支不算依赖（条件变化时整条公式本来就会重算）。
 * - 跨表引用：Sheet2!A1、'销售 明细'!B2:C9；工作表名不区分大小写。
 * - 循环引用 → #CYCLE!；未知函数 → #NAME?；语法错误 → #ERROR!。
 * - fast-formula-parser 的实例不可重入，所以按递归深度各用一个实例；很深的引用链用“延后”
 *   机制（先算最深处、再回来）避免栈溢出。
 */

export interface EngineSource {
  /** 工作表名 → id（不区分大小写），找不到返回 undefined */
  sheetIdByName(name: string): string | undefined;
  sheetName(id: string): string;
  size(id: string): { rows: number; cols: number };
  raw(id: string, row: number, col: number): string | undefined;
  /** xlsx 导入时 Excel 算好的值：我们不支持的函数退回这个值 */
  cached?(id: string, row: number, col: number): Scalar | CellError | undefined;
}

const MAX_DEPTH = 24;
const MAX_DIRTY = 20_000;

const { FormulaError } = FormulaParser;
type FErr = InstanceType<typeof FormulaError>;

class Deferred {
  constructor(readonly key: string) {}
}

interface Dep {
  sid: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

const fkey = (sid: string, r: number, c: number) => `${sid}!${r}:${c}`;
function parseFkey(key: string): [string, number, number] {
  const bang = key.lastIndexOf('!');
  const colon = key.indexOf(':', bang);
  return [key.slice(0, bang), Number(key.slice(bang + 1, colon)), Number(key.slice(colon + 1))];
}

const literalCache = new Map<string, Literal>();
export function literalOf(raw: string): Literal {
  const hit = literalCache.get(raw);
  if (hit) return hit;
  const lit = parseLiteral(raw);
  if (literalCache.size > 50_000) literalCache.clear();
  literalCache.set(raw, lit);
  return lit;
}

function findDeferred(e: unknown): Deferred | null {
  let cur: unknown = e;
  for (let i = 0; i < 200 && cur; i += 1) {
    if (cur instanceof Deferred) return cur;
    cur = (cur as { details?: unknown }).details;
  }
  return null;
}

/** 解析器把内部错误层层包成 #ERROR!：沿 details 找最里面的具体错误码（未实现的函数 → #NAME?） */
function errorCode(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 50 && cur; i += 1) {
    if (cur instanceof FormulaError) {
      const code = (cur as FErr).error;
      if (code !== '#ERROR!') return code;
      if (/not implemented/iu.test((cur as FErr).message ?? '')) return '#NAME?';
    }
    cur = (cur as { details?: unknown }).details;
  }
  return '#ERROR!';
}

export class FormulaEngine {
  private values = new Map<string, CellValue>();
  private deps = new Map<string, Dep[]>();
  /** 被单格引用：格 → 公式集合 */
  private rCell = new Map<string, Set<string>>();
  /** 被区域引用：表 → 列 → [区域, 公式] */
  private rRange = new Map<string, Map<number, Array<{ dep: Dep; f: string }>>>();
  private evaluating = new Set<string>();
  private parsers: FormulaParser[] = [];
  private current: Array<string> = [];
  private captured: Array<Dep[]> = [];
  /** 每次值变化 +1（React 用来判断要不要重绘） */
  version = 0;

  constructor(private src: EngineSource) {}

  /** 全部作废（插删行列、改表名、重新载入） */
  reset(): void {
    this.values.clear();
    this.deps.clear();
    this.rCell.clear();
    this.rRange.clear();
    this.version += 1;
  }

  /** 这些格的内容变了：它们自己和所有（传递）依赖它们的公式重算 */
  cellsChanged(cells: Iterable<[string, number, number]>): void {
    const queue: string[] = [];
    const seen = new Set<string>();
    for (const [sid, r, c] of cells) {
      const k = fkey(sid, r, c);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
    for (let i = 0; i < queue.length; i += 1) {
      if (seen.size > MAX_DIRTY) {
        this.reset();
        return;
      }
      const k = queue[i]!;
      this.forget(k);
      const [sid, r, c] = parseFkey(k);
      const add = (f: string) => {
        if (!seen.has(f)) {
          seen.add(f);
          queue.push(f);
        }
      };
      this.rCell.get(k)?.forEach(add);
      const byCol = this.rRange.get(sid)?.get(c);
      if (byCol) {
        for (const { dep, f } of byCol) if (r >= dep.r0 && r <= dep.r1) add(f);
      }
    }
    this.version += 1;
  }

  private forget(f: string) {
    this.values.delete(f);
    const deps = this.deps.get(f);
    if (!deps) return;
    this.deps.delete(f);
    for (const d of deps) {
      if (d.r0 === d.r1 && d.c0 === d.c1) {
        const k = fkey(d.sid, d.r0, d.c0);
        const set = this.rCell.get(k);
        set?.delete(f);
        if (set && set.size === 0) this.rCell.delete(k);
      } else {
        const bySheet = this.rRange.get(d.sid);
        if (!bySheet) continue;
        for (let c = d.c0; c <= d.c1; c += 1) {
          const list = bySheet.get(c);
          if (!list) continue;
          const idx = list.findIndex((x) => x.f === f && x.dep === d);
          if (idx >= 0) list.splice(idx, 1);
        }
      }
    }
  }

  private remember(f: string, deps: Dep[]) {
    this.deps.set(f, deps);
    for (const d of deps) {
      if (d.r0 === d.r1 && d.c0 === d.c1) {
        const k = fkey(d.sid, d.r0, d.c0);
        let set = this.rCell.get(k);
        if (!set) {
          set = new Set();
          this.rCell.set(k, set);
        }
        set.add(f);
      } else {
        let bySheet = this.rRange.get(d.sid);
        if (!bySheet) {
          bySheet = new Map();
          this.rRange.set(d.sid, bySheet);
        }
        for (let c = d.c0; c <= d.c1; c += 1) {
          let list = bySheet.get(c);
          if (!list) {
            list = [];
            bySheet.set(c, list);
          }
          list.push({ dep: d, f });
        }
      }
    }
  }

  /** 单元格的值（公式会被求值并缓存） */
  get(sid: string, row: number, col: number): CellValue {
    const stack: string[] = [fkey(sid, row, col)];
    for (let guard = 0; guard < 200_000; guard += 1) {
      const top = stack[stack.length - 1]!;
      const [s, r, c] = parseFkey(top);
      try {
        const v = this.valueAt(s, r, c, 0);
        stack.pop();
        if (stack.length === 0) return v;
      } catch (e) {
        const d = findDeferred(e);
        if (!d) throw e;
        if (stack.includes(d.key)) {
          // 延后的格又回到了栈里：说明是很长的循环引用
          this.values.set(d.key, { error: '#CYCLE!' });
        } else stack.push(d.key);
      }
    }
    return { error: '#CYCLE!' };
  }

  /** 公式的显示格式建议（日期输入等）不归引擎管：这里只给值 */
  private valueAt(sid: string, row: number, col: number, depth: number): CellValue {
    const raw = this.src.raw(sid, row, col);
    if (raw === undefined || raw === '') return null;
    if (!isFormula(raw)) return literalOf(raw).value;
    const key = fkey(sid, row, col);
    const hit = this.values.get(key);
    if (hit !== undefined) return hit;
    if (this.evaluating.has(key)) return { error: '#CYCLE!' };
    if (depth >= MAX_DEPTH) throw new Deferred(key);
    this.evaluating.add(key);
    let v: CellValue;
    try {
      v = this.evaluate(sid, row, col, raw.slice(1), depth, key);
    } finally {
      this.evaluating.delete(key);
    }
    if (isError(v) && v.error === '#NAME?') {
      const cached = this.src.cached?.(sid, row, col);
      if (cached !== undefined) v = cached;
    }
    this.values.set(key, v);
    return v;
  }

  private parserAt(depth: number): FormulaParser {
    let p = this.parsers[depth];
    if (!p) {
      p = new FormulaParser({
        functions: extraFunctions(),
        onCell: (ref) => this.onCell(depth, ref),
        onRange: (ref) => this.onRange(depth, ref),
      });
      this.parsers[depth] = p;
    }
    return p;
  }

  private resolveSheet(name: string | undefined, fallback: string): string | undefined {
    if (!name) return fallback;
    return this.src.sheetIdByName(name);
  }

  private toParserValue(v: CellValue): unknown {
    if (isError(v)) return new FormulaError(v.error);
    return v;
  }

  private onCell(depth: number, ref: CellRefArg): unknown {
    const self = this.current[depth]!;
    const sid = this.resolveSheet(ref.sheet, parseFkey(self)[0]);
    if (!sid) return FormulaError.REF;
    const r = ref.row - 1;
    const c = ref.col - 1;
    this.captured[depth]!.push({ sid, r0: r, c0: c, r1: r, c1: c });
    return this.toParserValue(this.valueAt(sid, r, c, depth + 1));
  }

  private onRange(depth: number, ref: RangeRefArg): unknown[][] {
    const self = this.current[depth]!;
    const sid = this.resolveSheet(ref.sheet, parseFkey(self)[0]);
    if (!sid) throw FormulaError.REF;
    const size = this.src.size(sid);
    const r0 = Math.max(0, ref.from.row - 1);
    const c0 = Math.max(0, ref.from.col - 1);
    const r1 = Math.min(size.rows - 1, ref.to.row - 1);
    const c1 = Math.min(size.cols - 1, ref.to.col - 1);
    this.captured[depth]!.push({ sid, r0, c0, r1: Math.max(r0, r1), c1: Math.max(c0, c1) });
    const out: unknown[][] = [];
    for (let r = r0; r <= r1; r += 1) {
      const line: unknown[] = [];
      for (let c = c0; c <= c1; c += 1)
        line.push(this.toParserValue(this.valueAt(sid, r, c, depth + 1)));
      out.push(line);
    }
    if (out.length === 0) out.push([null]);
    return out;
  }

  private evaluate(
    sid: string,
    row: number,
    col: number,
    body: string,
    depth: number,
    key: string,
  ): CellValue {
    const parser = this.parserAt(depth);
    const prevCurrent = this.current[depth];
    const prevCaptured = this.captured[depth];
    this.current[depth] = key;
    const deps: Dep[] = [];
    this.captured[depth] = deps;
    let result: unknown;
    try {
      result = parser.parse(body, { sheet: this.src.sheetName(sid), row: row + 1, col: col + 1 });
    } catch (e) {
      const d = findDeferred(e);
      if (d) throw d;
      result = { error: errorCode(e) };
    } finally {
      this.current[depth] = prevCurrent!;
      this.captured[depth] = prevCaptured!;
    }
    this.remember(key, deps);
    return normalize(result);
  }
}

function normalize(v: unknown): CellValue {
  if (v === null || v === undefined) return 0;
  if (v instanceof FormulaError) return { error: (v as FErr).error };
  if (isError(v)) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? tidy(v) : { error: '#NUM!' };
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return normalize((v[0] as unknown[] | undefined)?.[0]);
  return { error: '#VALUE!' };
}

/** 单条公式在一个只读数据源上求值（测试、预览用） */
export function evaluateOnce(
  cells: Record<string, Record<string, string>>,
  sheet: string,
  formula: string,
): CellValue {
  const names = Object.keys(cells);
  const grid = (name: string) => cells[name] ?? {};
  const src: EngineSource = {
    sheetIdByName: (n) => names.find((x) => x.toLowerCase() === n.toLowerCase()),
    sheetName: (id) => id,
    size: () => ({ rows: 1000, cols: 100 }),
    raw: (id, r, c) => grid(id)[`${r}:${c}`],
  };
  const probe = { ...grid(sheet), '999:99': formula.startsWith('=') ? formula : `=${formula}` };
  const all: Record<string, Record<string, string>> = { ...cells, [sheet]: probe };
  return new FormulaEngine({ ...src, raw: (id, r, c) => all[id]?.[`${r}:${c}`] }).get(
    sheet,
    999,
    99,
  );
}
