import { describe, expect, it } from 'vitest';
import { renderLatex } from './renderLatex';

const doc = (body: string, preamble = '') =>
  `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

describe('未定义的命令', () => {
  it('报出来（带行号），同一个命令只报一次', () => {
    const r = renderLatex(doc('正文 \\undefinedcmd{a}\n再来一次 \\undefinedcmd{b}'));
    const hits = r.warnings.filter((w) => w.message.includes('\\undefinedcmd'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
    expect(hits[0]!.message).toMatch(/^未定义的命令 \\undefinedcmd/u);
  });

  it('\\newcommand 定义过的、常见命令不报', () => {
    const r = renderLatex(
      doc('\\mycmd 和 \\textbf{粗体}、\\emph{强调}', '\\newcommand{\\mycmd}{我的命令}\n'),
    );
    expect(r.warnings.filter((w) => w.message.startsWith('未定义的命令'))).toEqual([]);
  });
});
