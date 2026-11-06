import * as formulajs from '@formulajs/formulajs';
import FormulaParser, { type FunctionArg } from 'fast-formula-parser';
import { jsDateToSerial } from './values';

/**
 * 函数库：fast-formula-parser（MIT）自带约 280 个 Excel 函数；它没实现的（MATCH、MEDIAN、STDEV、
 * SUMIFS、COUNTIFS、TEXTJOIN、SWITCH、MAXIFS …）用 @formulajs/formulajs（MIT）补上；
 * 两边都没有的 XLOOKUP 在这里按 Excel 定义实现。
 */

const { FormulaError } = FormulaParser;

const KNOWN_ERRORS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A']);

function toFormulaError(e: Error): InstanceType<typeof FormulaError> {
  const code = KNOWN_ERRORS.has(e.message) ? e.message : '#VALUE!';
  return new FormulaError(code);
}

function argValue(a: FunctionArg | null | undefined): unknown {
  if (!a || a.omitted) return undefined;
  return a.value;
}

function normalizeResult(v: unknown): unknown {
  if (v instanceof FormulaError) return v;
  if (v instanceof Error) return toFormulaError(v);
  if (v instanceof Date) return jsDateToSerial(v);
  if (v === undefined) return new FormulaError('#VALUE!');
  if (Array.isArray(v)) {
    return v.map((row: unknown) =>
      Array.isArray(row) ? row.map(normalizeResult) : normalizeResult(row),
    );
  }
  return v;
}

type AnyFn = (...args: unknown[]) => unknown;

function wrapFormulajs(fn: AnyFn) {
  return (...args: FunctionArg[]) => {
    try {
      return normalizeResult(fn(...args.map(argValue)));
    } catch (e) {
      if (e instanceof FormulaError) throw e;
      if (e instanceof Error) return toFormulaError(e);
      return new FormulaError('#VALUE!');
    }
  };
}

function flat(v: unknown): unknown[] {
  if (Array.isArray(v)) return v.flatMap((x) => flat(x));
  return [v];
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function wildcardRe(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) {
      src += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      i += 1;
    } else if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${src}$`, 'iu');
}

/** XLOOKUP(查找值, 查找区域, 返回区域, [未找到时], [匹配方式 0/-1/1/2], [搜索方式 1/-1]) */
function XLOOKUP(...args: FunctionArg[]): unknown {
  const lookup = argValue(args[0]);
  const lookupArr = argValue(args[1]);
  const returnArr = argValue(args[2]);
  const notFound = args[3] && !args[3].omitted ? args[3].value : undefined;
  const matchMode = Number(argValue(args[4]) ?? 0);
  const searchMode = Number(argValue(args[5]) ?? 1);
  if (!Array.isArray(lookupArr) || !Array.isArray(returnArr)) return new FormulaError('#VALUE!');
  const rows = lookupArr as unknown[][];
  const vertical = rows.length > 1 || (rows[0]?.length ?? 0) === 1;
  const keys = flat(rows);
  const ret = returnArr as unknown[][];
  let idx = -1;
  const order = searchMode === -1 ? keys.map((_, i) => keys.length - 1 - i) : keys.map((_, i) => i);
  if (matchMode === 2 && typeof lookup === 'string') {
    const re = wildcardRe(lookup);
    idx = order.find((i) => re.test(String(keys[i] ?? ''))) ?? -1;
  } else {
    idx = order.find((i) => looseEqual(keys[i], lookup)) ?? -1;
    if (idx < 0 && (matchMode === -1 || matchMode === 1) && typeof lookup === 'number') {
      let best = -1;
      keys.forEach((k, i) => {
        if (typeof k !== 'number') return;
        if (matchMode === -1 && k <= lookup && (best < 0 || k > (keys[best] as number))) best = i;
        if (matchMode === 1 && k >= lookup && (best < 0 || k < (keys[best] as number))) best = i;
      });
      idx = best;
    }
  }
  if (idx < 0) return notFound !== undefined ? notFound : new FormulaError('#N/A');
  if (vertical) {
    const row = ret[idx];
    if (!row) return new FormulaError('#VALUE!');
    return row.length === 1 ? (row[0] ?? null) : [row];
  }
  const col = ret.map((r) => r[idx]);
  return col.length === 1 ? (col[0] ?? null) : col.map((v) => [v]);
}

let registry: Record<string, (...args: FunctionArg[]) => unknown> | null = null;

/** 补充函数表（只算一次）：parser 不支持的名字才用 formulajs 的实现 */
export function extraFunctions(): Record<string, (...args: FunctionArg[]) => unknown> {
  if (registry) return registry;
  const supported = new Set(new FormulaParser().supportedFunctions());
  const out: Record<string, (...args: FunctionArg[]) => unknown> = {};
  const lib = formulajs as unknown as Record<string, unknown>;
  for (const [name, v] of Object.entries(lib)) {
    if (!/^[A-Z][A-Z0-9.]*$/u.test(name)) continue;
    if (typeof v === 'function' && !supported.has(name)) out[name] = wrapFormulajs(v as AnyFn);
    if (v && typeof v === 'object') {
      // 旧名字（STDEV、VAR、MODE、PERCENTILE、QUARTILE、RANK）= 新函数族里的默认那个
      const obj = v as Record<string, unknown>;
      const legacy = ['S', 'SNGL', 'INC', 'EQ'].find((s) => typeof obj[s] === 'function');
      if (legacy && !supported.has(name)) out[name] = wrapFormulajs(obj[legacy] as AnyFn);
      for (const [sub, f] of Object.entries(obj)) {
        const full = `${name}.${sub}`;
        if (typeof f === 'function' && /^[A-Z0-9.]+$/u.test(sub) && !supported.has(full)) {
          out[full] = wrapFormulajs(f as AnyFn);
        }
      }
    }
  }
  out.XLOOKUP = XLOOKUP;
  registry = out;
  return out;
}

/** 公式栏函数提示用：全部可用的函数名 */
export function allFunctionNames(): string[] {
  const names = new Set(new FormulaParser().supportedFunctions());
  for (const k of Object.keys(extraFunctions())) names.add(k);
  return [...names].sort();
}
