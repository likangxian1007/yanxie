import { tr } from '@/lib/i18n';
/**
 * 「让 AI 修复」的范围选择与应用前校验（纯函数，便于测试）。
 *
 * 背景（终验缺陷 #9）：\documentclass 下一行误放了一句正文，编译报「第 2 行 Missing \begin{document}」；
 * AI 拿到第 1–17 行后把 \documentclass 删掉了，一键替换后错误更多。这里做两件事：
 * 1. 结构性错误（导言区里的问题、Missing \begin{document} 等）把导言区到 \begin{document} 整段交给 AI；
 * 2. 替换前检查：替换后丢了 \documentclass / \begin{document} / \end{document}、
 *    范围里原有的 \usepackage、\input、\bibliography 等被删，或者片段被大幅截短，就拒绝一键替换。
 */

/** 去掉一行里的 % 注释（\% 不算注释） */
export function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '%') return line.slice(0, i);
  }
  return line;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/gu, '\n').split('\n');
}

/** 去掉注释后的源码（行数不变） */
export function codeOf(text: string): string {
  return splitLines(text).map(stripTexComment).join('\n');
}

/** 第一个没有被注释掉的 \begin{document} 所在行（从 1 开始）；没有返回 null */
export function beginDocumentLine(text: string): number | null {
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    if (/\\begin\s*\{document\}/u.test(stripTexComment(lines[i] as string))) return i + 1;
  }
  return null;
}

/** 文档结构类错误：要让 AI 看到 \documentclass 到 \begin{document} 的完整导言区 */
const STRUCTURAL_RE =
  /Missing \\begin\{document\}|before \\documentclass|\\documentclass|Can be used only in preamble|only in preamble|font size command \\normalsize|导言区/u;

export function isStructuralIssue(message: string): boolean {
  return STRUCTURAL_RE.test(message);
}

export interface FixRange {
  /** 起始行（从 1 开始，含） */
  from: number;
  /** 结束行（含） */
  to: number;
  /** 是否按结构性错误取了整段导言区 */
  structural: boolean;
}

/** 导言区超过这么多行时不再整段取，退回问题前后若干行 */
const MAX_PREAMBLE_LINES = 250;

/**
 * 给 AI 修复取哪几行：
 * - 普通问题：问题行前后各 context 行；
 * - 结构性问题，或问题行在导言区里：从第 1 行一直取到 \begin{document} 之后几行，
 *   让 AI 看到完整的导言区结构（\documentclass、\usepackage…），也有地方把误放的正文挪到 \begin{document} 之后。
 */
export function fixRangeFor(
  text: string,
  issueLine: number,
  message: string,
  context = 15,
): FixRange {
  const total = Math.max(1, splitLines(text).length);
  const line = Math.max(1, Math.min(total, Math.round(issueLine)));
  const local: FixRange = {
    from: Math.max(1, line - context),
    to: Math.min(total, line + context),
    structural: false,
  };
  const begin = beginDocumentLine(text);
  const inPreamble = begin !== null && line <= begin;
  if (!isStructuralIssue(message) && !inPreamble) return local;
  if (begin === null) {
    // 整篇都没有 \begin{document}：从头取到问题行后面一些
    const to = Math.min(total, Math.max(line + context, Math.min(total, 2 * context)));
    if (to > MAX_PREAMBLE_LINES) return local;
    return { from: 1, to, structural: true };
  }
  const to = Math.min(total, Math.max(begin, line) + 3);
  if (to > MAX_PREAMBLE_LINES) return local;
  return { from: 1, to, structural: true };
}

// ---------------------------------------------------------------- 应用前校验

export interface ReplaceCheck {
  ok: boolean;
  /** 每条是「会删掉 \documentclass」这样的短句 */
  problems: string[];
  /** 拒绝时给用户的一句话，如「AI 给的修改会删掉 \documentclass，没有应用」 */
  title: string;
}

function count(code: string, re: RegExp): number {
  return code.match(new RegExp(re.source, 'gu'))?.length ?? 0;
}

function firstIndex(code: string, re: RegExp): number {
  const m = new RegExp(re.source, 'u').exec(code);
  return m ? m.index : -1;
}

const DOCCLASS = /\\documentclass(?![A-Za-z@])/u;
const BEGIN_DOC = /\\begin\s*\{document\}/u;
const END_DOC = /\\end\s*\{document\}/u;
const USEPACKAGE = /\\(?:usepackage|RequirePackage)(?![A-Za-z@])\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gu;
const FILE_CMDS =
  /\\(input|include|bibliography|bibliographystyle|addbibresource)(?![A-Za-z@])\s*\{([^}]*)\}/gu;

function packagesOf(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(USEPACKAGE)) {
    for (const name of (m[1] ?? '').split(',')) {
      const n = name.trim();
      if (n) out.add(n);
    }
  }
  return out;
}

function fileRefsOf(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(FILE_CMDS)) {
    const args = m[1] === 'bibliography' ? (m[2] ?? '').split(',') : [m[2] ?? ''];
    for (const a of args) {
      const v = a.trim();
      if (v) out.add(`\\${m[1]}{${v}}`);
    }
  }
  return out;
}

const nonEmptyLines = (text: string) => splitLines(text).filter((l) => l.trim() !== '').length;

/**
 * 检查把 doc[from, to) 换成 insert 之后文档结构是否还完整。
 * 只报「替换造成的」损坏：原文本来就缺的东西不算 AI 的错。
 */
export function checkLatexReplacement(
  doc: string,
  from: number,
  to: number,
  insert: string,
  /** allowShrink：用户自己要求改写（如「精简这段」）时，不把篇幅大幅变短当成问题 */
  opts: { allowShrink?: boolean } = {},
): ReplaceCheck {
  const original = doc.slice(from, to);
  const after = doc.slice(0, from) + insert + doc.slice(to);
  const before = codeOf(doc);
  const next = codeOf(after);
  const problems: string[] = [];

  if (!insert.trim() && original.trim()) problems.push(tr('是空的，会把这段内容整个删掉'));

  const lost = (re: RegExp, name: string) => {
    if (count(before, re) > 0 && count(next, re) === 0)
      problems.push(tr('会删掉 {name}', { name }));
  };
  lost(DOCCLASS, '\\documentclass');
  lost(BEGIN_DOC, '\\begin{document}');
  lost(END_DOC, '\\end{document}');
  // 模型把范围外的行也写进了输出（例如多抄了一个 \end{document}）
  const dup = (re: RegExp, name: string) => {
    if (count(next, re) > Math.max(1, count(before, re)))
      problems.push(tr('会多出一个 {name}', { name }));
  };
  dup(DOCCLASS, '\\documentclass');
  dup(BEGIN_DOC, '\\begin{document}');
  dup(END_DOC, '\\end{document}');

  // 顺序：\documentclass → \begin{document} → \end{document}
  const order = (code: string) => ({
    cls: firstIndex(code, DOCCLASS),
    begin: firstIndex(code, BEGIN_DOC),
    end: firstIndex(code, END_DOC),
  });
  const o0 = order(before);
  const o1 = order(next);
  const ordered = (o: typeof o0) =>
    (o.cls < 0 || o.begin < 0 || o.cls < o.begin) && (o.begin < 0 || o.end < 0 || o.begin < o.end);
  if (ordered(o0) && !ordered(o1))
    problems.push(tr('会打乱 \\documentclass、\\begin{document} 的先后顺序'));

  // \documentclass 前面多出了正文
  if (o0.cls >= 0 && o1.cls >= 0) {
    const head0 = before.slice(0, o0.cls).trim();
    const head1 = next.slice(0, o1.cls).trim();
    if (!head0 && head1) problems.push(tr('会在 \\documentclass 前面放内容'));
  }

  // 范围里原有的宏包、文件引用不能丢
  const origCode = codeOf(original);
  const pk0 = packagesOf(origCode);
  const pkAll = packagesOf(next);
  const lostPk = [...pk0].filter((p) => !pkAll.has(p));
  if (lostPk.length)
    problems.push(tr('会删掉 \\usepackage{{lostPk}}', { lostPk: lostPk.join(',') }));
  const refs0 = fileRefsOf(origCode);
  const refsAll = fileRefsOf(next);
  const lostRefs = [...refs0].filter((r) => !refsAll.has(r));
  if (lostRefs.length)
    problems.push(tr('会删掉 {lostRefs}', { lostRefs: lostRefs.join(tr('、')) }));

  // \usepackage 跑到了 \begin{document} 之后
  const usepkgAfterBegin = (code: string, o: typeof o0) =>
    o.begin >= 0 && /\\usepackage(?![A-Za-z@])/u.test(code.slice(o.begin));
  if (!usepkgAfterBegin(before, o0) && usepkgAfterBegin(next, o1)) {
    problems.push(tr('会把 \\usepackage 放到 \\begin{document} 之后'));
  }

  // 大幅截短：较长的片段只剩不到四成
  const n0 = nonEmptyLines(original);
  const n1 = nonEmptyLines(insert);
  if (!opts.allowShrink && insert.trim() && n0 >= 8 && n1 < n0 * 0.4) {
    problems.push(tr('会删掉这段里的大部分内容（{n0} 行只剩 {n1} 行）', { n0, n1 }));
  }

  const ok = problems.length === 0;
  return {
    ok,
    problems,
    title: ok ? '' : tr('AI 给的修改{value}，没有应用', { value: problems[0] }),
  };
}
