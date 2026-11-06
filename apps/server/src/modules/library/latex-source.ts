import { gunzipSync } from 'node:zlib';
import type { PaperFormula } from '@srh/shared';

/**
 * arXiv LaTeX 源码（https://arxiv.org/e-print/<id>，tar.gz 或单个 .tex 的 gz）：
 * 解包 → 找主文件 → 展开 \input/\include → 抽出行间公式、小节标题、自定义宏，
 * 再按公式编号与文字相似度对上 GROBID 识别的公式，把公式换成真正的 LaTeX（KaTeX 渲染）。
 */

export interface SourceEquation {
  /** KaTeX 可渲染的 LaTeX（align 已换成 aligned，去掉 \label、\nonumber） */
  latex: string;
  env: string;
  /** 编号（按 LaTeX 规则数出来的 “(3)”），无编号环境为 null */
  number: string | null;
  /** 对比用的字母数字签名 */
  sig: string;
  /** 多行环境的逐行 LaTeX 与签名 */
  lines?: { latex: string; sig: string }[];
}

export interface LatexSource {
  mainFile: string;
  equations: SourceEquation[];
  /** 行内公式（较长的那些，用来对上 GROBID 拆出来的行内公式） */
  inline: SourceEquation[];
  sections: { level: number; title: string }[];
  macros: Record<string, string>;
}

// ---------------------------------------------------------------- 解包

const MAX_TEXT_FILES = 200;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 解出所有 .tex / .bbl / .sty 文本文件；不是源码（比如 arXiv 只给了 PDF）返回 null */
export function unpackArxivSource(buf: Buffer): Map<string, string> | null {
  let data = buf;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = gunzipSync(data, { maxOutputLength: MAX_TOTAL_BYTES * 3 });
    } catch {
      return null;
    }
  }
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return null;
  const files = new Map<string, string>();
  if (data.length > 262 && data.subarray(257, 262).toString('latin1') === 'ustar') {
    let off = 0;
    let longName: string | null = null;
    while (off + 512 <= data.length && files.size < MAX_TEXT_FILES) {
      const header = data.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const rawName = cstr(header.subarray(0, 100));
      const prefix = cstr(header.subarray(345, 500));
      const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8) || 0;
      const type = String.fromCharCode(header[156] || 48);
      const bodyStart = off + 512;
      const body = data.subarray(bodyStart, bodyStart + size);
      off = bodyStart + Math.ceil(size / 512) * 512;
      if (type === 'L') {
        longName = cstr(body);
        continue;
      }
      const name = (longName ?? (prefix ? `${prefix}/${rawName}` : rawName)).replace(/^\.\//u, '');
      longName = null;
      if (type !== '0' && type !== '\0') continue;
      if (!/\.(tex|bbl|sty|ltx)$/iu.test(name)) continue;
      files.set(name, body.toString('utf8'));
    }
    return files.size ? files : null;
  }
  // 单个 .tex 文件
  const text = data.toString('utf8');
  if (/\\(documentclass|begin\{document\}|section)/u.test(text)) {
    files.set('main.tex', text);
    return files;
  }
  return null;
}

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString('utf8');
}

// ---------------------------------------------------------------- 预处理

/** 去掉 % 注释（\% 保留）与 \iffalse…\fi、comment 环境 */
export function stripComments(src: string): string {
  const lines = src.split(/\r?\n/u).map((line) => {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '\\') {
        i += 1;
        continue;
      }
      if (line[i] === '%') return line.slice(0, i);
    }
    return line;
  });
  return lines
    .join('\n')
    .replace(/\\iffalse\b[\s\S]*?\\fi\b/gu, '')
    .replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/gu, '');
}

function findMain(files: Map<string, string>): string | null {
  const tex = [...files.keys()].filter((n) => /\.(tex|ltx)$/iu.test(n));
  const withDoc = tex.filter((n) => /\\begin\{document\}/u.test(stripComments(files.get(n)!)));
  if (withDoc.length) {
    return withDoc.sort((a, b) => files.get(b)!.length - files.get(a)!.length)[0]!;
  }
  return tex[0] ?? null;
}

function lookup(files: Map<string, string>, from: string, ref: string): string | null {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const name = ref.trim().replace(/^\.\//u, '');
  for (const cand of [name, `${name}.tex`, `${dir}${name}`, `${dir}${name}.tex`]) {
    if (files.has(cand)) return cand;
  }
  return null;
}

/** 展开 \input{x} / \include{x} / \subfile{x}（最多 8 层，防循环） */
export function inlineInputs(files: Map<string, string>, main: string): string {
  const seen = new Set<string>();
  const expand = (name: string, depth: number): string => {
    if (depth > 8 || seen.has(name)) return '';
    seen.add(name);
    const src = stripComments(files.get(name) ?? '');
    return src.replace(
      /\\(?:input|include|subfile)\s*\{([^}]+)\}|\\input\s+([^\s{}\\]+)/gu,
      (m, a: string | undefined, b: string | undefined) => {
        const target = lookup(files, name, (a ?? b ?? '').trim());
        return target ? `\n${expand(target, depth + 1)}\n` : '';
      },
    );
  };
  return expand(main, 0);
}

/** 从 i（指向 '{'）开始读一个配对的花括号组，返回内容与结束位置 */
function readGroup(s: string, i: number): { body: string; end: number } | null {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const c = s[j];
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/u.test(s[i]!)) i += 1;
  return i;
}

/** \newcommand / \renewcommand / \def / \DeclareMathOperator → KaTeX macros */
export function extractMacros(src: string): Record<string, string> {
  const macros: Record<string, string> = {};
  const re =
    /\\(?:(?:re)?newcommand\*?|providecommand\*?|DeclareRobustCommand\*?)\s*(\{\\[A-Za-z@]+\}|\\[A-Za-z@]+)\s*(?:\[(\d)\])?\s*(?:\[[^\]]*\])?\s*/gu;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1]!.replace(/^\{|\}$/gu, '');
    const g = readGroup(src, skipWs(src, re.lastIndex));
    if (!g) continue;
    if (g.body.length <= 400 && !/\\(?:begin|end|par|section|vspace|hspace)\b/u.test(g.body)) {
      macros[name] = g.body.trim();
    }
    re.lastIndex = g.end;
  }
  const def = /\\def\s*(\\[A-Za-z@]+)\s*(#\d)*\s*/gu;
  for (let m = def.exec(src); m; m = def.exec(src)) {
    const g = readGroup(src, skipWs(src, def.lastIndex));
    if (g && g.body.length <= 400) macros[m[1]!] = g.body.trim();
    if (g) def.lastIndex = g.end;
  }
  const op = /\\DeclareMathOperator(\*?)\s*\{?(\\[A-Za-z]+)\}?\s*/gu;
  for (let m = op.exec(src); m; m = op.exec(src)) {
    const g = readGroup(src, skipWs(src, op.lastIndex));
    if (g) {
      macros[m[2]!] = m[1]
        ? `\\operatorname*{${g.body.trim()}}`
        : `\\operatorname{${g.body.trim()}}`;
      op.lastIndex = g.end;
    }
  }
  return macros;
}

// ---------------------------------------------------------------- 公式

const DISPLAY_ENVS = [
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'flalign',
  'flalign*',
  'alignat',
  'alignat*',
  'displaymath',
  'math',
];
const NUMBERED = new Set([
  'equation',
  'align',
  'gather',
  'multline',
  'eqnarray',
  'flalign',
  'alignat',
]);

const FUNCTION_WORDS = new Set([
  'sin',
  'cos',
  'tan',
  'log',
  'ln',
  'exp',
  'max',
  'min',
  'arg',
  'sup',
  'inf',
  'lim',
  'det',
  'tanh',
  'sigmoid',
]);

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

/** 展开用户宏（只做无参数的简单替换，最多 3 轮），只用于计算签名 */
function expandForSig(tex: string, macros: Record<string, string>): string {
  let s = tex;
  for (let round = 0; round < 3; round += 1) {
    const next = s.replace(/\\([A-Za-z@]+)/gu, (m) => {
      const body = macros[m];
      return body !== undefined && !body.includes('#') ? ` ${body} ` : m;
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 公式的“字母数字签名”：LaTeX 命令去掉（函数名、希腊字母保留成文字），只留字母和数字 */
export function latexSignature(tex: string, macros: Record<string, string> = {}): string {
  return expandForSig(tex, macros)
    .replace(/\\(?:text|mathrm|operatorname|mathit|mathbf|textrm)\s*\{([^}]*)\}/gu, ' $1 ')
    .replace(/\\([A-Za-z]+)/gu, (_m, w: string) =>
      FUNCTION_WORDS.has(w) ? ` ${w} ` : (GREEK[w] ?? ' '),
    )
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** GROBID 抽出的公式文字的签名 */
export function textSignature(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 环境内容 → KaTeX 能渲染的 LaTeX */
function toKatex(env: string, body: string): string {
  let s = body
    .replace(/\\label\s*\{[^}]*\}/gu, '')
    .replace(/\\(?:nonumber|notag)\b/gu, '')
    .replace(/\\tag\*?\s*\{[^}]*\}/gu, '')
    .trim()
    .replace(/\\\\\s*$/u, '')
    .trim();
  const base = env.replace(/\*$/u, '');
  if (base === 'align' || base === 'flalign' || base === 'eqnarray') {
    if (base === 'eqnarray') s = s.replace(/&\s*([=<>]|\\le|\\ge|\\approx)\s*&/gu, '&$1 ');
    s = `\\begin{aligned}${s}\\end{aligned}`;
  } else if (base === 'alignat') {
    s = s.replace(/^\{\d+\}/u, '');
    s = `\\begin{aligned}${s}\\end{aligned}`;
  } else if (base === 'gather') {
    s = `\\begin{gathered}${s}\\end{gathered}`;
  } else if (base === 'multline') {
    s = `\\begin{gathered}${s}\\end{gathered}`;
  }
  return s;
}

function numberedLines(env: string, body: string): number {
  const base = env.replace(/\*$/u, '');
  if (env.endsWith('*') || !NUMBERED.has(base)) return 0;
  if (base === 'equation' || base === 'multline')
    return /\\(?:nonumber|notag)\b/u.test(body) ? 0 : 1;
  const lines = body.split(/\\\\/u).filter((l) => l.trim());
  return lines.filter((l) => !/\\(?:nonumber|notag)\b/u.test(l)).length;
}

export function extractEquations(
  src: string,
  macros: Record<string, string> = {},
): { equations: SourceEquation[]; inline: SourceEquation[] } {
  const body = src.includes('\\begin{document}')
    ? src.slice(src.indexOf('\\begin{document}'))
    : src;
  const equations: SourceEquation[] = [];
  let counter = 0;
  const envAlt = DISPLAY_ENVS.map((e) => e.replace('*', '\\*')).join('|');
  const re = new RegExp(
    String.raw`\\begin\{(${envAlt})\}([\s\S]*?)\\end\{\1\}|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$`,
    'gu',
  );
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const env = m[1] ?? 'displaymath';
    const inner = m[2] ?? m[3] ?? m[4] ?? '';
    if (!inner.trim()) continue;
    const n = numberedLines(env, inner);
    let number: string | null = null;
    if (n > 0) {
      number = n === 1 ? `(${counter + 1})` : `(${counter + 1})–(${counter + n})`;
      counter += n;
    }
    const latex = toKatex(env, inner);
    const clean = inner.replace(/\\label\s*\{[^}]*\}/gu, '');
    // 多行环境：GROBID 常把每一行识别成单独的公式，逐行也算一份签名
    const rawLines = clean.split(/\\\\/u).filter((l) => l.trim());
    const lines =
      rawLines.length > 1
        ? rawLines.map((l) => {
            const ln = l
              .replace(/\\(?:nonumber|notag)\b/gu, '')
              .replace(/&/gu, '')
              .trim();
            return { latex: ln, sig: latexSignature(ln, macros) };
          })
        : undefined;
    equations.push({
      latex,
      env,
      number,
      sig: latexSignature(clean, macros),
      ...(lines ? { lines } : {}),
    });
  }
  // 行内公式：长度 ≥ 6 的签名才有对比价值
  const inline: SourceEquation[] = [];
  const noDisplay = body.replace(re, ' ');
  for (const m of noDisplay.matchAll(
    /(?<!\\)\$([^$]{2,300}?)(?<!\\)\$|\\\(([\s\S]{2,300}?)\\\)/gu,
  )) {
    const latex = (m[1] ?? m[2] ?? '').trim();
    const sig = latexSignature(latex, macros);
    if (sig.length >= 3) inline.push({ latex, env: 'inline', number: null, sig });
    if (inline.length > 2000) break;
  }
  return { equations, inline };
}

export function extractSections(src: string): { level: number; title: string }[] {
  const out: { level: number; title: string }[] = [];
  const LEVEL: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3 };
  const re = /\\(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*/gu;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const g = readGroup(src, re.lastIndex);
    if (!g) continue;
    const title = g.body
      .replace(/\\label\{[^}]*\}/gu, '')
      .replace(/\\[A-Za-z]+\s*/gu, '')
      .replace(/[{}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (title) out.push({ level: LEVEL[m[1]!]!, title });
  }
  return out;
}

export function parseLatexSource(buf: Buffer): LatexSource | null {
  const files = unpackArxivSource(buf);
  if (!files) return null;
  const main = findMain(files);
  if (!main) return null;
  const full = inlineInputs(files, main);
  // 宏也可能定义在 .sty 里
  let macroSrc = full;
  for (const [name, content] of files) {
    if (/\.sty$/iu.test(name)) macroSrc += `\n${stripComments(content)}`;
  }
  const macros = extractMacros(macroSrc);
  const { equations, inline } = extractEquations(full, macros);
  return { mainFile: main, equations, inline, sections: extractSections(full), macros };
}

// ---------------------------------------------------------------- 匹配

/** 字符二元组 Dice 系数 */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hit += 1;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

/**
 * 给 GROBID 公式填上 latex：
 * 1. 编号相同（“(3)”）且文字相似度 ≥ 0.35 → 直接对上；
 * 2. 否则在未用过的行间公式里找相似度最高的（≥ 0.6）；
 * 3. 很短的（GROBID 把行内公式拆成了单独的 formula）在行内公式里找（≥ 0.75）。
 * 返回对上的个数。没对上的保持 latex=null，前端显示 PDF 原图区域。
 */
export function matchFormulas(formulas: PaperFormula[], src: LatexSource): number {
  const used = new Set<number>();
  const usedInline = new Set<number>();
  let matched = 0;
  for (const f of formulas) {
    const sig = textSignature(f.text);
    if (sig.length < 2) continue;
    let best = -1;
    let bestScore = 0;
    if (f.label) {
      const bare = f.label.replace(/[\s()]/gu, '');
      const num = `(${bare})`;
      src.equations.forEach((e, i) => {
        if (used.has(i) || !e.number) return;
        if (e.number === num || e.number.startsWith(`${num.replace(/\)$/u, '')})`)) {
          const s = dice(sig, e.sig);
          if (s >= 0.35 && s > bestScore) {
            best = i;
            bestScore = s;
          }
        }
      });
    }
    if (best < 0) {
      src.equations.forEach((e, i) => {
        if (used.has(i)) return;
        const s = dice(sig, e.sig);
        if (s >= 0.6 && s > bestScore) {
          best = i;
          bestScore = s;
        }
      });
    }
    if (best >= 0) {
      used.add(best);
      f.latex = src.equations[best]!.latex;
      matched += 1;
      continue;
    }
    // 多行环境的某一行（同一个环境的不同行可以分别对上不同的 GROBID 公式）
    let lineHit: string | null = null;
    let lineScore = 0;
    for (const e of src.equations) {
      for (const l of e.lines ?? []) {
        const s = dice(sig, l.sig);
        if (s >= 0.6 && s > lineScore) {
          lineHit = l.latex;
          lineScore = s;
        }
      }
    }
    if (lineHit) {
      f.latex = lineHit;
      matched += 1;
      continue;
    }
    if (sig.length <= 40) {
      let bi = -1;
      let bs = 0;
      src.inline.forEach((e, i) => {
        if (usedInline.has(i)) return;
        const s = dice(sig, e.sig);
        if (s >= 0.75 && s > bs) {
          bi = i;
          bs = s;
        }
      });
      if (bi >= 0) {
        usedInline.add(bi);
        f.latex = src.inline[bi]!.latex;
        matched += 1;
      }
    }
  }
  return matched;
}
