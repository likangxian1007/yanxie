import { describe, expect, it } from 'vitest';
import {
  beginDocumentLine,
  checkLatexReplacement,
  fixRangeFor,
  isStructuralIssue,
  stripTexComment,
} from './fixGuard';

/** 终验缺陷 #9 的真实情形（office-35-latex-ai-fix.png）：\documentclass 下一行误输入了一句正文 */
const DOC = String.raw`\documentclass{ctexart}
导师补充 ADV-TEX \undefinedcmd{x} 参见 \cite{nokey2099}。
\usepackage{amsmath,graphicx}
\title{图对比学习综述（验收）}
\author{张三}
\begin{document}
\maketitle
\section{引言}
图对比学习\cite{you2020graphcl}近年发展迅速，参见图~\ref{fig:acc}。
\input{sections/method}
\begin{figure}[h]
\centering
\includegraphics[width=0.6\textwidth]{figs/acc.png}
\caption{训练准确率 LATEX-FIG}\label{fig:acc}
\end{figure}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}`;

const LINES = DOC.split('\n');

/** 第 a–b 行（含）在文档里的字符区间 */
function span(doc: string, a: number, b: number): [number, number] {
  const lines = doc.split('\n');
  const from = lines.slice(0, a - 1).reduce((n, l) => n + l.length + 1, 0);
  const to = from + lines.slice(a - 1, b).join('\n').length;
  return [from, to];
}

describe('fixRangeFor', () => {
  it('Missing \\begin{document}（第 2 行）：从第 1 行取到 \\begin{document} 之后', () => {
    expect(beginDocumentLine(DOC)).toBe(6);
    expect(isStructuralIssue('Missing \\begin{document}')).toBe(true);
    expect(fixRangeFor(DOC, 2, 'Missing \\begin{document}')).toEqual({
      from: 1,
      to: 9,
      structural: true,
    });
  });

  it('导言区里的普通错误也带上整段导言区', () => {
    const r = fixRangeFor(DOC, 2, '未定义的命令 \\undefinedcmd（拼写错误，或者忘了加载宏包）');
    expect(r.from).toBe(1);
    expect(r.structural).toBe(true);
  });

  it('正文里的错误：问题行前后各 15 行', () => {
    const body = [
      ...LINES.slice(0, 6),
      ...Array.from({ length: 60 }, (_, i) => `第 ${i} 段。`),
      '\\end{document}',
    ].join('\n');
    expect(fixRangeFor(body, 40, '未定义的命令 \\foo')).toEqual({
      from: 25,
      to: 55,
      structural: false,
    });
  });

  it('注释掉的 \\begin{document} 不算', () => {
    expect(beginDocumentLine('\\documentclass{article}\n% \\begin{document}\nx')).toBeNull();
    expect(stripTexComment('50\\% 的样本 % 注释')).toBe('50\\% 的样本 ');
  });
});

describe('checkLatexReplacement', () => {
  it('报告里的真实输出：删掉 \\documentclass、误放的行反而留着 → 拒绝', () => {
    // AI 给「替换第 1–17 行」的内容：从误放的那行开始，第 1 行的 \documentclass 没了
    const aiOutput = LINES.slice(1, 17).join('\n');
    const [from, to] = span(DOC, 1, 17);
    const r = checkLatexReplacement(DOC, from, to, aiOutput);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('会删掉 \\documentclass');
    expect(r.title).toBe('AI 给的修改会删掉 \\documentclass，没有应用');
  });

  it('DeepSeek 修复前的真实输出：删掉 \\documentclass，还多抄了范围外的 \\end{document}', () => {
    // collab-verify/r2-fix/latex-ai-fix/trials.json「修复前」：替换第 1–17 行，输出是第 2–18 行
    const aiOutput = LINES.slice(1, 18).join('\n');
    const [from, to] = span(DOC, 1, 17);
    const r = checkLatexReplacement(DOC, from, to, aiOutput);
    expect(r.title).toBe('AI 给的修改会删掉 \\documentclass，没有应用');
    expect(r.problems).toContain('会多出一个 \\end{document}');
  });

  it('DeepSeek 修复后的真实输出（第 1–9 行）→ 通过', () => {
    const aiOutput = [
      ...[0, 2, 3, 4, 5, 6].map((i) => LINES[i]),
      LINES[1],
      LINES[7],
      LINES[8],
    ].join('\n');
    const [from, to] = span(DOC, 1, 9);
    expect(checkLatexReplacement(DOC, from, to, aiOutput).ok).toBe(true);
  });

  it('正确的修复：把误放的那行挪到 \\begin{document} 之后 → 通过', () => {
    const fixed = [
      LINES[0],
      ...LINES.slice(2, 7),
      '导师补充 ADV-TEX 参见 \\cite{nokey2099}。',
      ...LINES.slice(7, 9),
    ].join('\n');
    const [from, to] = span(DOC, 1, 9);
    const r = checkLatexReplacement(DOC, from, to, fixed);
    expect(r).toEqual({ ok: true, problems: [], title: '' });
  });

  it('删掉了范围里的 \\usepackage → 拒绝', () => {
    const out = [LINES[0], ...LINES.slice(3, 9)].join('\n');
    const [from, to] = span(DOC, 1, 9);
    const r = checkLatexReplacement(DOC, from, to, out);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('会删掉 \\usepackage{amsmath,graphicx}');
  });

  it('宏包合并写法不算删除', () => {
    const doc =
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{graphicx}\n\\begin{document}\nx\n\\end{document}';
    const [from, to] = span(doc, 1, 4);
    const out = '\\documentclass{article}\n\\usepackage{amsmath,graphicx}\n\\begin{document}';
    expect(checkLatexReplacement(doc, from, to, out).ok).toBe(true);
  });

  it('删掉 \\begin{document} / \\end{document}、\\input、\\bibliography → 拒绝', () => {
    const [from, to] = span(DOC, 5, 18);
    const out = ['\\author{张三}', '\\maketitle', '\\section{引言}', '正文', '\\centering'].join(
      '\n',
    );
    const r = checkLatexReplacement(DOC, from, to, out);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        '会删掉 \\begin{document}',
        '会删掉 \\end{document}',
        expect.stringContaining('\\input{sections/method}'),
      ]),
    );
    expect(r.problems.join(' ')).toContain('\\bibliography{refs}');
  });

  it('把 \\usepackage 挪到 \\begin{document} 之后 → 拒绝', () => {
    const [from, to] = span(DOC, 1, 9);
    const out = [LINES[0], ...LINES.slice(3, 6), LINES[2], ...LINES.slice(6, 9)].join('\n');
    const r = checkLatexReplacement(DOC, from, to, out);
    expect(r.problems).toContain('会把 \\usepackage 放到 \\begin{document} 之后');
  });

  it('在 \\documentclass 前面塞正文 → 拒绝', () => {
    const [from, to] = span(DOC, 1, 2);
    const out = `${LINES[1]}\n${LINES[0]}`;
    const r = checkLatexReplacement(DOC, from, to, out);
    expect(r.problems).toContain('会在 \\documentclass 前面放内容');
  });

  it('空结果、大幅截短 → 拒绝', () => {
    const [from, to] = span(DOC, 7, 17);
    expect(checkLatexReplacement(DOC, from, to, '  ').title).toBe(
      'AI 给的修改是空的，会把这段内容整个删掉，没有应用',
    );
    const r = checkLatexReplacement(
      DOC,
      from,
      to,
      '\\maketitle\n\\bibliography{refs}\n\\input{sections/method}\n\\bibliographystyle{plain}',
    );
    expect(r.problems.some((p) => p.startsWith('会删掉这段里的大部分内容'))).toBe(true);
    // 用户自己要求精简时不算
    const body = Array.from({ length: 10 }, (_, i) => `第 ${i} 句。`).join('\n');
    expect(checkLatexReplacement(body, 0, body.length, '一句话总结。').ok).toBe(false);
    expect(
      checkLatexReplacement(body, 0, body.length, '一句话总结。', { allowShrink: true }).ok,
    ).toBe(true);
  });

  it('原文本来就没有 \\documentclass（子文件）：只要不丢东西就通过', () => {
    const sub = '\\section{方法}\n我们用 \\badcmd 方法。\n\\label{sec:m}';
    const [from, to] = span(sub, 1, 3);
    const r = checkLatexReplacement(
      sub,
      from,
      to,
      '\\section{方法}\n我们用 GraphCL 方法。\n\\label{sec:m}',
    );
    expect(r.ok).toBe(true);
  });
});
