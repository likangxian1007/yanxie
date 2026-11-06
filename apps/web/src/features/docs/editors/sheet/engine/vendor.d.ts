/** fast-formula-parser（MIT）没有自带类型声明：这里只声明用到的部分。 */
declare module 'fast-formula-parser' {
  export interface CellRefArg {
    sheet: string;
    row: number;
    col: number;
  }
  export interface RangeRefArg {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export interface Position {
    sheet: string;
    row: number;
    col: number;
  }
  export interface FunctionArg {
    value: unknown;
    isArray: boolean;
    isRangeRef?: boolean;
    isCellRef?: boolean;
    omitted?: boolean;
  }
  export class FormulaError extends Error {
    constructor(error: string, msg?: string, details?: unknown);
    readonly error: string;
    details?: unknown;
    static DIV0: FormulaError;
    static NA: FormulaError;
    static NAME: FormulaError;
    static NULL: FormulaError;
    static NUM: FormulaError;
    static REF: FormulaError;
    static VALUE: FormulaError;
  }
  export interface ParserConfig {
    functions?: Record<string, (...args: FunctionArg[]) => unknown>;
    functionsNeedContext?: Record<string, (ctx: unknown, ...args: FunctionArg[]) => unknown>;
    onVariable?: (name: string, sheet: string) => unknown;
    onCell?: (ref: CellRefArg) => unknown;
    onRange?: (ref: RangeRefArg) => unknown[][];
  }
  export class DepParser {
    constructor(config?: { onVariable?: (name: string, sheet: string) => unknown });
    parse(formula: string, position: Position): Array<CellRefArg | RangeRefArg>;
  }
  export default class FormulaParser {
    constructor(config?: ParserConfig);
    parse(formula: string, position: Position, allowReturnArray?: boolean): unknown;
    supportedFunctions(): string[];
    static FormulaError: typeof FormulaError;
    static DepParser: typeof DepParser;
    static MAX_ROW: number;
    static MAX_COLUMN: number;
  }
}

declare module 'fast-formula-parser/grammar/lexing' {
  export interface LexToken {
    image: string;
    startOffset: number;
    endOffset: number;
    tokenType: { name: string };
  }
  const lexing: { lex(input: string): { tokens: LexToken[] } };
  export default lexing;
}
