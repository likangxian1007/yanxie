import { describe, expect, it } from 'vitest';
import {
  aiSystemPrompt,
  aiUserPrompt,
  latexFixUserPrompt,
  stripLatexFilesComment,
} from '../../src/modules/documents/ai';

/** 终验缺陷 #9 的真实情形：\documentclass 下一行误输入了一句正文 */
const MAIN = String.raw`\documentclass{ctexart}
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

const lines = MAIN.split('\n');
const FILES_COMMENT = [
  '% ---- 工程文件（研协附注，不属于 main.tex 源码；编辑只作用于 main.tex）----',
  '% main.tex（主文件，下面就是它的源码）',
  '% refs.bib（参考文献：you2020graphcl）',
  '% ----',
  '',
].join('\n');

describe('latex_fix 提示词', () => {
  it('系统提示词不再要求去掉 \\documentclass，而是要求原样保留导言区', () => {
    const sys = aiSystemPrompt('latex', 'latex_fix');
    expect(sys).not.toContain('不要包含 \\documentclass');
    expect(sys).toContain('原样保留');
    expect(sys).toContain('\\documentclass');
    expect(sys).toContain('\\usepackage');
    expect(sys).toContain('范围外');
    // 其他 latex 动作：不新增，但选中里原有的要保留
    const polish = aiSystemPrompt('latex', 'academic');
    expect(polish).toContain('原有的这些结构命令要原样保留');
  });

  it('Missing \\begin{document}：片段带行号，附上导言区到 \\begin{document} 的完整结构和约束', () => {
    const selection = lines.slice(0, 9).join('\n'); // 前端结构性错误取第 1–9 行
    const user = latexFixUserPrompt({
      title: 'office-latex工程',
      selection,
      prompt: 'LaTeX 编译在第 2 行（片段起始行：1）报告问题：Missing \\begin{document}。请修复它。',
      document: FILES_COMMENT + MAIN,
    });
    // 行号：片段与导言区都按文件行号编号（文件清单注释不算行）
    expect(user).toContain('<snippet range="第 1–9 行">');
    expect(user).toContain('1| \\documentclass{ctexart}');
    expect(user).toContain('2| 导师补充 ADV-TEX \\undefinedcmd{x} 参见 \\cite{nokey2099}。');
    expect(user).toContain('6| \\begin{document}');
    expect(user).toContain('<preamble>');
    expect(user).toContain('\\begin{document} 在第 6 行');
    expect(user).toContain('\\end{document} 在第 18 行');
    const preamble = user.slice(user.indexOf('<preamble>'), user.indexOf('</preamble>'));
    expect(preamble).toContain('3| \\usepackage{amsmath,graphicx}');
    expect(preamble).not.toContain('\\maketitle');
    // 约束
    expect(user).toContain('不得删除或改写第 1–9 行以外的内容');
    expect(user).toContain('原样保留片段里的 \\documentclass、\\usepackage');
    expect(user).toContain('绝不能删掉 \\documentclass');
    expect(user).toContain('报告的问题：LaTeX 编译在第 2 行报告问题');
    expect(user).not.toContain('片段起始行');
  });

  it('普通问题：按内容定位片段的行号，不加结构要求', () => {
    const selection = lines.slice(7, 12).join('\n');
    const user = latexFixUserPrompt({
      title: 't',
      selection,
      prompt: '预览检查在第 9 行报告问题：未定义的命令。',
      document: MAIN,
    });
    expect(user).toContain('<snippet range="第 8–12 行">');
    expect(user).toContain(' 8| \\section{引言}');
    expect(user).toContain('12| \\centering');
    expect(user).not.toContain('结构要求');
    // 导言区仍作为只读参考给出
    expect(user).toContain('1| \\documentclass{ctexart}');
  });

  it('片段来自其他文件：用前端给的起始行，导言区注明来自 main.tex', () => {
    const user = latexFixUserPrompt({
      title: 't',
      selection: '\\section{方法}\n\\badcmd',
      prompt: '在 sections/method.tex 的第 4 行（片段起始行：3）报告问题：未定义的命令 \\badcmd。',
      document: MAIN,
    });
    expect(user).toContain('<snippet range="第 3–4 行">');
    expect(user).toContain('3| \\section{方法}');
    expect(user).toContain('片段来自工程里的另一个文件');
  });

  it('没有 \\begin{document} 时明确告诉模型', () => {
    const doc = '\\documentclass{article}\nHello';
    const user = latexFixUserPrompt({ title: 't', selection: doc, prompt: '', document: doc });
    expect(user).toContain('全文没有找到 \\begin{document}');
    expect(user).toContain('结构要求');
  });

  it('stripLatexFilesComment 只去掉开头的文件清单注释', () => {
    expect(stripLatexFilesComment(FILES_COMMENT + MAIN)).toBe(MAIN);
    expect(stripLatexFilesComment(MAIN)).toBe(MAIN);
  });

  it('其他动作仍用原来的 aiUserPrompt', () => {
    const u = aiUserPrompt({
      title: 't',
      kind: 'latex',
      action: 'academic',
      selection: 'abc',
      prompt: '',
      context: MAIN,
    });
    expect(u).toContain('<selection>\nabc\n</selection>');
  });
});
