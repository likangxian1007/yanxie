import { describe, expect, it } from 'vitest';
import { documentExcerpt } from '../../src/modules/documents/markdown';

describe('documentExcerpt', () => {
  it('sheet: 取前几行单元格，不带表格标记', () => {
    const md = '|   | A | B |\n| --- | --- | --- |\n| 1 | window | top-1 |\n| 2 | 7 | 79.6 |';
    expect(documentExcerpt('sheet', md)).toBe('window · top-1 ／ 7 · 79.6');
  });

  it('latex: 跳过导言区、命令和注释，保留文字', () => {
    const src =
      '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nVision Transformers scale $O(N^2)$. % 注释\n\\end{document}';
    expect(documentExcerpt('latex', src)).toBe('Introduction Vision Transformers scale O(N^2).');
  });

  it('latex: 行内公式保留成可读文字，显示公式、图表、引用不出现乱码', () => {
    const src = [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\begin{document}',
      '\\section{方法}',
      '对比损失 $\\mathcal{L}_{\\text{con}}$ 用温度 $\\tau$，复杂度 \\(O(N \\log N)\\)，',
      '相似度取 $\\frac{a}{b}$ \\cite{you2020}，见图~\\ref{fig:x}。',
      '\\begin{equation}',
      'L = -\\log \\frac{\\exp(\\mathrm{sim}(z_i, z_j)/\\tau)}{\\sum_k \\exp(\\mathrm{sim}(z_i, z_k)/\\tau)}',
      '\\end{equation}',
      '\\begin{figure}[h]\\centering\\includegraphics[width=0.5\\linewidth]{fig.png}\\caption{框架}\\label{fig:x}\\end{figure}',
      '\\begin{itemize}\\item 第一点 \\item \\textbf{第二点}\\end{itemize}',
      '\\end{document}',
    ].join('\n');
    const out = documentExcerpt('latex', src);
    expect(out).toBe(
      '方法 对比损失 L_con 用温度 τ，复杂度 O(N log N)，相似度取 a/b，见图。第一点 第二点',
    );
    expect(out).not.toMatch(/\[h\]|sim\(z_i|\\|[{}]/u);
  });

  it('slides: 去掉版式注释', () => {
    expect(documentExcerpt('slides', '# 进展\n\n<!-- layout: title -->\n\n张三')).toBe('进展 张三');
  });
});
