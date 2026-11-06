import { describe, expect, it } from 'vitest';
import { DOC_TEMPLATES } from '@/features/docs/templates';
import { parseBib } from '../compile/bib';
import { renderLatex } from './renderLatex';
import { parseColSpec, parseLength } from './tabular-spec';
import { splitMathRows, stripMathComments } from './latexParser';

const today = new Date(2026, 9, 26);
const render = (src: string) => renderLatex(src, { today });
const doc = (body: string, preamble = '') =>
  `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

describe('renderLatex · 文档结构', () => {
  it('跳过导言区，渲染标题块', () => {
    const r = render(
      doc(
        '\\maketitle\nHello.',
        '\\usepackage{amsmath}\n\\title{My \\textbf{Paper}}\n\\author{Alice \\and Bob}\n\\date{2026}\n',
      ),
    );
    expect(r.html).not.toContain('usepackage');
    expect(r.html).toContain('<h1 class="ltx-title">My <strong>Paper</strong></h1>');
    expect(r.html).toMatch(/ltx-author">Alice<\/div><div class="ltx-author">Bob/);
    expect(r.html).toContain('<div class="ltx-date">2026</div>');
    expect(r.title).toBe('My Paper');
    expect(r.warnings).toEqual([]);
  });

  it('\\today 按语言格式化，默认日期为今天', () => {
    expect(render(doc('\\today')).html).toContain('October 26, 2026');
    expect(
      render('\\documentclass{ctexart}\\begin{document}\\today\\end{document}').html,
    ).toContain('2026年10月26日');
  });

  it('没有 document 环境也能渲染', () => {
    const r = render('Just some *text* here.');
    expect(r.html).toBe('<p>Just some *text* here.</p>');
  });

  it('空行分段，单个换行是空格，中文之间换行不加空格', () => {
    const r = render('one\ntwo\n\nthree\n\n中文\n接上');
    expect(r.blocks.map((b) => b.html)).toEqual([
      '<p>one two</p>',
      '<p>three</p>',
      '<p>中文接上</p>',
    ]);
    expect(r.blocks.map((b) => b.line)).toEqual([1, 4, 6]);
  });

  it('无参 \\newcommand 展开（正文与公式），带参数的也可以', () => {
    const r = render(
      doc(
        'We use \\method{} and $\\R^n$ and \\pair{a}{b}.',
        '\\newcommand{\\method}{\\textsc{Ours}}\n\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\pair}[2]{(#1, #2)}\n',
      ),
    );
    expect(r.html).toContain('<span class="ltx-sc">Ours</span>');
    expect(r.html).toContain('(a, b)');
    expect(r.html).toContain('katex');
    expect(r.warnings).toEqual([]);
  });
});

describe('renderLatex · 章节与大纲', () => {
  it('自动编号 1、1.1、1.1.1，带 * 不编号，\\paragraph 为行内标题', () => {
    const r = render(
      doc(
        [
          '\\section{Intro}',
          '\\subsection{Background}',
          '\\subsubsection{Detail}',
          '\\section*{Acknowledgments}',
          '\\section{Method}',
          '\\subsection{Setup}',
          '\\paragraph{Note.} Text.',
        ].join('\n'),
      ),
    );
    expect(r.outline).toEqual([
      { heading: '1 Intro', level: 1 },
      { heading: '1.1 Background', level: 2 },
      { heading: '1.1.1 Detail', level: 3 },
      { heading: 'Acknowledgments', level: 1 },
      { heading: '2 Method', level: 1 },
      { heading: '2.1 Setup', level: 2 },
    ]);
    expect(r.sections.map((s) => s.line)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(r.html).toContain('<span class="ltx-secnum">2.1</span>Setup</h3>');
    expect(r.html).toContain('<p><strong class="ltx-runin">Note.</strong>Text.</p>');
  });

  it('\\appendix 后章节用字母编号', () => {
    const r = render(doc('\\section{A}\\appendix\\section{Proofs}\\subsection{Lemma}'));
    expect(r.outline.map((o) => o.heading)).toEqual(['1 A', 'A Proofs', 'A.1 Lemma']);
  });
});

describe('renderLatex · 文本格式', () => {
  it('字体命令、特殊字符与连字', () => {
    const r = render(
      "\\textbf{b} \\textit{i} \\emph{e} \\texttt{t} \\underline{u} \\textsc{s} {\\bf decl} 50\\% a~b x---y 1--2 ``q'' \\LaTeX{} \\TeX",
    );
    const html = r.html;
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<em>e</em>');
    expect(html).toContain('<code class="ltx-tt">t</code>');
    expect(html).toContain('<u>u</u>');
    expect(html).toContain('<span class="ltx-sc">s</span>');
    expect(html).toContain('<strong>decl</strong>');
    expect(html).toContain('50%');
    expect(html).toContain('a&nbsp;b');
    expect(html).toContain('x—y');
    expect(html).toContain('1–2');
    expect(html).toContain('“q”');
    expect(html).toContain('class="ltx-logo"');
  });

  it('注释被去掉，\\\\ 换行', () => {
    const r = render('a % hidden\nb\\\\c');
    expect(r.html).not.toContain('hidden');
    expect(r.html).toContain('a b<br>c');
  });

  it('HTML 特殊字符被转义', () => {
    expect(render('<script>alert(1)</script> & co').html).toContain('&lt;script&gt;');
  });

  it('未知命令以 dim 样式原样显示，不崩溃', () => {
    const r = render(doc('Hello \\frobnicate{x} world \\weird*'));
    expect(r.html).toContain(
      '<span class="ltx-unknown" title="预览暂不支持这个命令">\\frobnicate</span>x',
    );
    expect(r.html).toContain('\\weird*');
    // 正文里的未知命令提示一次（可交给 AI 修复），导言区的不提示
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]?.message).toMatch(/^未定义的命令 \\frobnicate？/u);
    expect(r.warnings[1]?.message).toMatch(/^未定义的命令 \\weird？/u);
    expect(r.warnings.every((w) => w.fixable !== false)).toBe(true);
    const twice = render(doc('\\undefinedcmd{a} and \\undefinedcmd{b}'));
    expect(twice.warnings).toHaveLength(1);
    expect(twice.warnings[0]?.line).toBeGreaterThan(0);
    expect(
      render('\\documentclass{article}\\hypersetup{x}\\begin{document}Hi\\end{document}').warnings,
    ).toEqual([]);
  });

  it('奇怪的输入不会抛错', () => {
    const inputs = [
      '\\',
      '{',
      '}',
      '$',
      '$$',
      '\\begin',
      '\\begin{',
      '\\end{x}',
      '\\item',
      '&',
      '%',
      '\\verb',
      '\\[',
      '\\section',
    ];
    for (const input of inputs) expect(() => render(input)).not.toThrow();
  });

  it('脚注编号并列在文末', () => {
    const r = render(doc('A\\footnote{First.} B\\footnote{Second.}'));
    expect(r.html).toContain('data-ref="fn-1">1</a>');
    expect(r.html).toContain('data-ref="fn-2">2</a>');
    expect(r.html).toMatch(/ltx-footnotes.*First\..*Second\./);
  });
});

describe('renderLatex · 公式', () => {
  it('行内 $..$ 与 \\(..\\)，显示 \\[..\\] 与 $$..$$', () => {
    const r = render('a $x^2$ b \\(y\\) c\n\\[ z \\]\n$$w$$');
    expect((r.html.match(/class="katex"/g) ?? []).length).toBe(4);
    expect((r.html.match(/katex-display/g) ?? []).length).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('equation 自动编号，\\eqref 引用，equation* 不编号', () => {
    const r = render(
      doc(
        [
          '\\begin{equation}a=b\\label{eq:a}\\end{equation}',
          '\\begin{equation*}c\\end{equation*}',
          '\\begin{equation}d\\label{eq:d}\\end{equation}',
          'See \\eqref{eq:d} and \\ref{eq:a}.',
        ].join('\n'),
      ),
    );
    expect(r.html).toContain('data-anchor="eq-1"');
    expect(r.html).toContain('data-anchor="eq-2"');
    expect(r.html).toContain('<a class="ltx-ref" data-ref="eq-2">(2)</a>');
    expect(r.html).toContain('<a class="ltx-ref" data-ref="eq-1">1</a>');
    expect(r.warnings).toEqual([]);
  });

  it('align 每行编号，\\nonumber 跳过，gather 也编号', () => {
    const r = render(
      doc(
        '\\begin{align}\n a &= b \\label{r1}\\\\\n c &= d \\nonumber \\\\\n e &= f \\label{r3}\n\\end{align}\n\\begin{gather} g \\end{gather}\n\\ref{r1},\\ref{r3}',
      ),
    );
    expect(r.html).toContain('data-anchor="eq-1 eq-2"');
    expect(r.html).toContain('data-anchor="eq-3"');
    expect(r.html).toContain('data-ref="eq-1">1</a>');
    expect(r.html).toContain('data-ref="eq-2">2</a>');
    expect(r.warnings).toEqual([]);
  });

  it('KaTeX 报错带正确行号', () => {
    const r = render('line1\n\nline3\n\\begin{equation}\n a + b\n \\frac{1}{\n\\end{equation}');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.line).toBeGreaterThanOrEqual(5);
    expect(r.warnings[0]?.message).toContain('花括号');
    expect(r.html).toContain('ltx-math-error');
  });

  it('未定义的公式命令给出中文说明', () => {
    const r = render('x\n$\\foo$');
    expect(r.warnings).toEqual([{ line: 2, message: '公式里有未定义的命令 \\foo' }]);
  });

  it('公式没闭合报警告', () => {
    const r = render('a\nprice $5 and more\n\nnext');
    expect(r.warnings).toEqual([{ line: 2, message: '数学公式没有闭合（缺少 $）' }]);
    expect(r.html).toContain('<p>next</p>');
  });

  it('拆分对齐行与去注释', () => {
    expect(splitMathRows('a\\\\b\\begin{cases}x\\\\y\\end{cases}\\\\[2pt]c')).toEqual([
      'a',
      'b\\begin{cases}x\\\\y\\end{cases}',
      'c',
    ]);
    expect(stripMathComments('a % c\nb \\% d')).toBe('a \nb \\% d');
  });
});

describe('renderLatex · 列表', () => {
  it('itemize / enumerate（嵌套编号）/ description', () => {
    const r = render(
      doc(
        [
          '\\begin{itemize}\\item One \\item Two\\end{itemize}',
          '\\begin{enumerate}',
          '  \\item First \\label{it:a}',
          '  \\begin{enumerate}\\item Inner\\end{enumerate}',
          '  \\item Second',
          '\\end{enumerate}',
          '\\begin{description}\\item[Term] Def\\end{description}',
          'Item \\ref{it:a}.',
        ].join('\n'),
      ),
    );
    expect(r.html).toContain('<ul class="ltx-list ltx-itemize">');
    expect((r.html.match(/ltx-item-label">•/g) ?? []).length).toBe(2);
    expect(r.html).toContain('ltx-item-label">1.</span>');
    expect(r.html).toContain('ltx-item-label">2.</span>');
    expect(r.html).toContain('ltx-item-label">(a)</span>');
    expect(r.html).toContain('<dt>Term</dt><dd><p>Def</p></dd>');
    expect(r.html).toMatch(/Item <a class="ltx-ref" data-ref="item-\d+">1<\/a>/);
  });
});

describe('renderLatex · 引用与参考文献', () => {
  it('\\cite 按 \\bibitem 顺序编号，未知 key 为 [?] 并报警告', () => {
    const r = render(
      doc(
        [
          'See \\cite{b,a} and \\cite[p.~3]{a} and \\cite{zzz}.',
          '\\begin{thebibliography}{9}',
          '\\bibitem{a} Alpha.',
          '\\bibitem{b} Beta.',
          '\\end{thebibliography}',
        ].join('\n'),
      ),
    );
    expect(r.html).toContain(
      '[<a class="ltx-ref" data-ref="bib-b">2</a>, <a class="ltx-ref" data-ref="bib-a">1</a>]',
    );
    expect(r.html).toContain('data-ref="bib-a">1</a>, p. 3]');
    expect(r.html).toContain('[<span class="ltx-ref-missing">?</span>]');
    expect(r.html).toContain(
      '<span class="ltx-bib-label">[1]</span><div class="ltx-bib-body">Alpha.</div>',
    );
    // 缺参考文献 AI 补不出来：不提供“让 AI 修复”
    expect(r.warnings).toEqual([{ line: 3, message: '找不到参考文献 zzz', fixable: false }]);
    expect(r.outline[r.outline.length - 1]).toEqual({ heading: 'References', level: 1 });
  });

  it('\\ref 引用章节、图、表；未知 \\ref 报警告', () => {
    const r = render(
      doc(
        [
          '\\section{Intro}\\label{sec:intro}',
          '\\subsection{Sub}\\label{sec:sub}',
          '\\begin{figure}\\centering\\includegraphics[width=0.5\\linewidth]{fig/a.png}\\caption{Cat}\\label{fig:cat}\\end{figure}',
          '\\begin{table}\\caption{Res}\\label{tab:res}\\begin{tabular}{c}x\\end{tabular}\\end{table}',
          'Sec \\ref{sec:intro}, \\ref{sec:sub}, Fig \\ref{fig:cat}, Tab \\ref{tab:res}, bad \\ref{nope}.',
        ].join('\n'),
      ),
    );
    expect(r.html).toContain('data-ref="sec-0">1</a>');
    expect(r.html).toContain('data-ref="sec-1">1.1</a>');
    expect(r.html).toContain('data-ref="fig-1">1</a>');
    expect(r.html).toContain('data-ref="tab-1">1</a>');
    expect(r.html).toContain('<span class="ltx-caption-label">Figure 1</span>Cat');
    expect(r.html).toContain('<span class="ltx-caption-label">Table 1</span>Res');
    expect(r.html).toContain('<span class="ltx-graphic" style="width:50%">');
    expect(r.html).toContain('fig/a.png');
    expect(r.warnings).toEqual([
      { line: 7, message: '找不到标签 nope（\\ref 引用了没有定义的 \\label）' },
    ]);
  });

  it('中文文档用“图 n”“表 n”', () => {
    const r = render(
      '\\documentclass{ctexart}\\begin{document}\\begin{figure}\\caption{猫}\\end{figure}\\end{document}',
    );
    expect(r.html).toContain('<span class="ltx-caption-label">图 1</span>猫');
  });

  it('\\label 写在 \\caption 之前给出提示', () => {
    const r = render('\\begin{figure}\n\\label{fig:x}\n\\caption{X}\n\\end{figure}');
    expect(r.warnings[0]?.line).toBe(2);
    expect(r.warnings[0]?.message).toContain('\\caption 之后');
  });

  it('只有 \\bibliography{} 时按引用顺序编号', () => {
    const r = render(doc('\\cite{x}\\cite{y,x}\n\\bibliography{refs}'));
    expect(r.html).toContain('data-ref="bib-x">1</a>]');
    expect(r.html).toContain('data-ref="bib-y">2</a>');
    expect(r.html).toContain('refs');
    expect(r.warnings).toEqual([]);
  });

  it('读取工程里的 .bib：按引用顺序编号并列出作者、标题、年份', () => {
    const bib =
      parseBib(`@article{he2016, author={He, Kaiming and Zhang, Xiangyu}, title={{Deep} Residual Learning}, journal={CVPR}, year=2016}
@misc{chen2020, author={Ting Chen and others}, title={SimCLR}, year={2020}}
@book{unused, title={Never cited}}`).entries;
    const r = renderLatex(
      doc(
        'See \\cite{chen2020} and \\cite{he2016,nokey}.\n\\bibliographystyle{plain}\n\\bibliography{references}',
      ),
      { today, bib: { 'references.bib': bib } },
    );
    expect(r.html).toContain('data-ref="bib-chen2020">1</a>');
    expect(r.html).toContain('data-ref="bib-he2016">2</a>');
    expect(r.html).toContain('Kaiming He and Xiangyu Zhang');
    expect(r.html).toContain('Deep Residual Learning');
    expect(r.html).toContain('Ting Chen et al.');
    expect(r.html).not.toContain('Never cited');
    expect(r.html).not.toContain('预览不读取 .bib');
    expect(r.warnings).toEqual([
      { line: 3, message: '找不到参考文献 nokey（references.bib 里没有这个条目）', fixable: false },
    ]);

    const missing = renderLatex(doc('\\cite{a}\n\\bibliography{other}'), {
      today,
      bib: { 'references.bib': bib },
    });
    expect(missing.warnings.map((w) => w.message)).toContain(
      '工程里没有 other.bib（\\bibliography 引用了它；在文件栏里新建或改名）',
    );
    expect(missing.warnings.every((w) => w.fixable === false)).toBe(true);
  });
});

describe('renderLatex · 表格', () => {
  it('列对齐、竖线、\\hline、\\multicolumn', () => {
    const r = render(
      [
        '\\begin{tabular}{|l|c|r|}',
        '\\hline',
        'A & B & C \\\\',
        '\\hline',
        '\\multicolumn{2}{|c|}{wide} & 3 \\\\',
        '\\hline',
        '\\end{tabular}',
      ].join('\n'),
    );
    const html = r.html;
    expect(html).toContain('<table class="ltx-tabular">');
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect(html).toContain('<td class="ltx-bt ltx-al-l ltx-bl ltx-br ltx-first">A</td>');
    expect(html).toContain('<td class="ltx-bt ltx-al-c ltx-br">B</td>');
    expect(html).toContain('colspan="2">wide</td>');
    expect(html).toMatch(/ltx-bb[^"]*ltx-al-r[^"]*">3<\/td>/);
    expect(r.warnings).toEqual([]);
  });

  it('booktabs 与单元格过多警告', () => {
    const r = render(
      '\\begin{tabular}{ll}\n\\toprule\na & b & c \\\\\n\\bottomrule\n\\end{tabular}',
    );
    expect(r.html).toContain('ltx-btk');
    expect(r.html).toContain('ltx-bbk');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.line).toBe(3);
  });

  it('解析列格式与长度', () => {
    expect(parseColSpec('|l|*{2}{c}|p{3cm}@{}r|')).toEqual({
      aligns: ['l', 'c', 'c', 'l', 'r'],
      borders: [true, true, false, true, false, true],
      count: 5,
    });
    expect(parseLength('0.48\\textwidth')).toBe('48%');
    expect(parseLength('\\linewidth')).toBe('100%');
    expect(parseLength('5cm')).toBe('min(100%, 5cm)');
    expect(parseLength('foo')).toBeNull();
  });
});

describe('renderLatex · 内置模板', () => {
  it.each(['latex-article', 'latex-ctexart', 'blank-latex'])('模板 %s 渲染无警告', (id) => {
    const tpl = DOC_TEMPLATES.find((t) => t.id === id);
    expect(tpl).toBeDefined();
    const r = render(tpl?.markdown ?? '');
    expect(r.warnings).toEqual([]);
    expect(r.html).not.toContain('ltx-ref-missing');
    expect(r.html).not.toContain('ltx-math-error');
  });
});

describe('renderLatex · 其他环境与警告', () => {
  it('abstract、quote、verbatim、lstlisting', () => {
    const r = render(
      doc(
        [
          '\\begin{abstract}Short.\\end{abstract}',
          '\\begin{quote}Q\\end{quote}',
          '\\begin{verbatim}',
          'x <- 1 % not a comment',
          '\\end{verbatim}',
          '\\begin{lstlisting}[language=Python]',
          'print("hi")',
          '\\end{lstlisting}',
        ].join('\n'),
      ),
    );
    expect(r.html).toContain('<div class="ltx-abstract-title">Abstract</div><p>Short.</p>');
    expect(r.html).toContain('<blockquote class="ltx-quote"><p>Q</p></blockquote>');
    expect(r.html).toContain('<code>x &lt;- 1 % not a comment</code>');
    expect(r.html).toContain(
      '<span class="ltx-code-lang">Python</span><code>print(&quot;hi&quot;)</code>',
    );
  });

  it('未闭合环境报出 \\begin 所在行', () => {
    const r = render('a\n\\begin{itemize}\n\\item x\n');
    expect(r.warnings).toContainEqual({
      line: 2,
      message: '环境 itemize 没有闭合（缺少 \\end{itemize}）',
    });
  });

  it('多余的 \\end、正文里的 ^ 与 &', () => {
    const r = render('a\n\\end{center}\nx^2\nR&D');
    expect(r.warnings.map((w) => w.line)).toEqual([2, 3, 4]);
  });

  it('缺少 \\end{document}', () => {
    const r = render('\\documentclass{article}\n\\begin{document}\nHi');
    expect(r.warnings).toEqual([{ line: 2, message: '缺少 \\end{document}' }]);
    expect(r.html).toBe('<p>Hi</p>');
  });

  it('定理与证明', () => {
    const r = render(
      doc(
        '\\begin{theorem}[Main]\\label{thm:m}True.\\end{theorem}\\begin{proof}Easy.\\end{proof}\\ref{thm:m}',
      ),
    );
    expect(r.html).toContain('<span class="ltx-thm-head">Theorem 1 (Main).</span> True.');
    expect(r.html).toContain('<span class="ltx-qed">∎</span>');
    expect(r.html).toMatch(/data-ref="thm-\d+">1<\/a>/);
  });

  it('3000 行文档在合理时间内完成', () => {
    const para = 'Some text with $x_i^2$ and \\textbf{bold} and \\cite{a}.\n';
    const parts: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      parts.push(`\\section{S${i}}\\label{s${i}}`);
      for (let k = 0; k < 8; k += 1) parts.push(para);
      parts.push('\\begin{equation}\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\\end{equation}');
    }
    parts.push('\\begin{thebibliography}{1}\\bibitem{a} A.\\end{thebibliography}');
    const src = doc(parts.join('\n'));
    expect(src.split('\n').length).toBeGreaterThan(3000);
    const t0 = performance.now();
    const r = render(src);
    const t1 = performance.now();
    expect(r.outline).toHaveLength(301);
    const t2 = performance.now();
    render(src);
    const t3 = performance.now();
    // 第二次命中 KaTeX 缓存，应当很快
    expect(t3 - t2).toBeLessThan(Math.max(400, t1 - t0));
  });
});
