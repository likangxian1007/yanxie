import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { formatCitation, parseCitationMarkers, splitByCitations } from '@srh/shared';
import {
  baseCitekey,
  bibEscape,
  bibKeysIn,
  toBibtex,
  uniqueCitekey,
} from '../../src/modules/library/bibtex';
import {
  extractEquations,
  extractMacros,
  matchFormulas,
  parseLatexSource,
  unpackArxivSource,
} from '../../src/modules/library/latex-source';
import {
  parseArxivEntry,
  parseCrossref,
  parseOpenAlex,
  splitName,
} from '../../src/modules/library/metadata';
import { pdfToText, textStructure } from '../../src/modules/library/pdftext';
import { tokenize } from '../../src/modules/library/search';
import { parseCoords, parseTei } from '../../src/modules/library/tei';
import { makeTar, tinyPdf } from './util';

const FIXTURE = readFileSync(join(__dirname, '../fixtures/library/attention.tei.xml'), 'utf8');

describe('GROBID TEI → 结构（真实 GROBID 0.9.1 输出片段：Attention Is All You Need）', () => {
  const { header, structure } = parseTei(FIXTURE);

  it('头部：标题、作者、arXiv 编号、摘要', () => {
    expect(header.title).toBe('Attention Is All You Need');
    expect(header.authors[0]).toEqual({
      name: 'Ashish Vaswani',
      given: 'Ashish',
      family: 'Vaswani',
    });
    expect(header.arxivId).toBe('1706.03762');
    expect(header.abstract).toMatch(/^The dominant sequence transduction models/u);
  });

  it('页面尺寸、章节层级与路径', () => {
    expect(structure.pages).toHaveLength(15);
    expect(structure.pages[0]).toEqual({ width: 612, height: 792 });
    const titles = structure.sections.map((s) => `${s.n} ${s.title}`);
    expect(titles).toContain('1 Introduction');
    expect(titles).toContain('3.2.1 Scaled Dot-Product Attention');
    const sdpa = structure.sections.find((s) => s.n === '3.2.1')!;
    expect(sdpa.level).toBe(3);
    expect(sdpa.page).toBe(4);
    const chunk = structure.chunks.find(
      (c) => c.sectionIndex === structure.sections.indexOf(sdpa),
    )!;
    expect(chunk.sectionPath).toBe(
      '3 Model Architecture › 3.2 Attention › 3.2.1 Scaled Dot-Product Attention',
    );
  });

  it('段落带页码、页内段号与坐标；引用编号保留在文字里', () => {
    const intro = structure.chunks.find((c) => c.text.startsWith('Recurrent neural networks'))!;
    expect(intro.page).toBe(2);
    expect(intro.para).toBe(1);
    expect(intro.kind).toBe('paragraph');
    expect(intro.boxes.length).toBeGreaterThan(3);
    expect(intro.boxes[0]).toEqual({ page: 2, x: 108, y: 100.16, w: 212.89, h: 8.64 });
    expect(intro.text).toContain('long short-term memory [13]');
    // seq 连续、同一页段号递增
    structure.chunks.forEach((c, i) => expect(c.seq).toBe(i));
    const p2 = structure.chunks.filter((c) => c.page === 2).map((c) => c.para);
    expect(p2).toEqual(p2.map((_, i) => i + 1));
  });

  it('公式：编号、文字、坐标，并作为 formula 段落进索引', () => {
    const eq1 = structure.formulas.find((f) => f.label === '(1)')!;
    expect(eq1.text).toMatch(/^Attention\(Q, K, V\) = softmax/u);
    expect(eq1.page).toBe(4);
    expect(eq1.boxes[0]).toMatchObject({ page: 4, x: 219.97 });
    expect(structure.chunks[eq1.chunkSeq!]!.kind).toBe('formula');
  });

  it('图与表：标签、图注、裁图区域、表格单元格', () => {
    const fig1 = structure.figures.find((f) => f.label === 'Figure 1')!;
    expect(fig1.kind).toBe('figure');
    expect(fig1.caption).toBe('The Transformer -model architecture.');
    expect(fig1.graphic).toEqual({ page: 3, x: 196.56, y: 72, w: 218.88, h: 322.42 });
    const tab2 = structure.figures.find((f) => f.label === 'Table 2')!;
    expect(tab2.kind).toBe('table');
    expect(tab2.rows![0]![0]).toBe('Model');
    expect(tab2.rows!.length).toBeGreaterThan(5);
    expect(structure.chunks[tab2.chunkSeq!]!.text).toContain('Model |');
  });

  it('脚注与致谢也进索引', () => {
    expect(
      structure.chunks.some((c) => c.kind === 'note' && /dot products get large/u.test(c.text)),
    ).toBe(true);
    expect(structure.sections.some((s) => s.title === 'Acknowledgements')).toBe(true);
  });

  it('参考文献：作者、年份、arXiv（idno 或 CoRR abs/ 原文里抽）', () => {
    expect(structure.references).toHaveLength(3);
    const [b0, b1] = structure.references;
    expect(b0!.authors).toEqual(['Jimmy Lei Ba', 'Jamie Ryan Kiros', 'Geoffrey E Hinton']);
    expect(b0!.arxivId).toBe('1607.06450');
    expect(b0!.year).toBe(2016);
    expect(b1!.title).toBe('Neural machine translation by jointly learning to align and translate');
    expect(b1!.arxivId).toBe('1409.0473');
    expect(b1!.raw).toMatch(/^Dzmitry Bahdanau/u);
  });

  it('coords 解析容错', () => {
    expect(parseCoords('1,2,3,4,5;bad;2,0,0,0,1;3,1,1,1,1')).toEqual([
      { page: 1, x: 2, y: 3, w: 4, h: 5 },
      { page: 3, x: 1, y: 1, w: 1, h: 1 },
    ]);
    expect(parseCoords(null)).toEqual([]);
  });

  it('不是 TEI 时报错', () => {
    expect(() => parseTei('<html/>')).toThrow(/TEI/u);
  });
});

// ---------------------------------------------------------------- arXiv 源码

const MAIN_TEX = String.raw`\documentclass{article}
\newcommand{\dmodel}{d_{\text{model}}}
\DeclareMathOperator*{\argmax}{arg\,max}
\begin{document}
\section{Model Architecture}
\input{model}
% \begin{equation} commented out \end{equation}
\end{document}`;

const MODEL_TEX = String.raw`\subsection{Attention}
We compute
\begin{equation}
   \mathrm{Attention}(Q, K, V) = \mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V \label{eq:att}
\end{equation}
and the heads
\begin{align*}
    \mathrm{MultiHead}(Q, K, V) &= \mathrm{Concat}(\mathrm{head_1}, ..., \mathrm{head_h})W^O\\
    \text{where}~\mathrm{head_i} &= \mathrm{Attention}(QW^Q_i, KW^K_i, VW^V_i)\\
\end{align*}
then
\begin{equation}
   \mathrm{FFN}(x)=\max(0, xW_1 + b_1) W_2 + b_2
\end{equation}
with $d_k=d_v=\dmodel/h=64$.`;

describe('arXiv LaTeX 源码：解包、公式抽取、与 GROBID 公式对齐', () => {
  it('tar.gz：找主文件、展开 \\input、跳过注释、按 LaTeX 规则编号', () => {
    const tgz = gzipSync(makeTar({ 'ms.tex': MAIN_TEX, 'model.tex': MODEL_TEX, 'fig.png': 'x' }));
    const files = unpackArxivSource(tgz)!;
    expect([...files.keys()].sort()).toEqual(['model.tex', 'ms.tex']);
    const src = parseLatexSource(tgz)!;
    expect(src.mainFile).toBe('ms.tex');
    expect(src.equations.map((e) => [e.env, e.number])).toEqual([
      ['equation', '(1)'],
      ['align*', null],
      ['equation', '(2)'],
    ]);
    expect(src.equations[0]!.latex).not.toContain('\\label');
    expect(src.equations[1]!.latex).toMatch(/^\\begin\{aligned\}/u);
    expect(src.sections).toEqual([
      { level: 1, title: 'Model Architecture' },
      { level: 2, title: 'Attention' },
    ]);
    expect(src.macros['\\dmodel']).toBe('d_{\\text{model}}');
    expect(src.macros['\\argmax']).toBe('\\operatorname*{arg\\,max}');
  });

  it('单个 .tex 的 gz 也能读；PDF 或乱码返回 null', () => {
    expect(
      parseLatexSource(gzipSync(Buffer.from(MAIN_TEX.replace('\\input{model}', MODEL_TEX))))
        ?.equations,
    ).toHaveLength(3);
    expect(parseLatexSource(Buffer.from('%PDF-1.4 ...'))).toBeNull();
    expect(parseLatexSource(Buffer.from('not latex at all'))).toBeNull();
  });

  it('对齐真实 GROBID 公式：编号 + 签名、多行环境逐行、行内公式', () => {
    const { structure } = parseTei(FIXTURE);
    const src = parseLatexSource(
      gzipSync(makeTar({ 'ms.tex': MAIN_TEX, 'model.tex': MODEL_TEX })),
    )!;
    const n = matchFormulas(structure.formulas, src);
    expect(n).toBeGreaterThanOrEqual(1);
    const eq1 = structure.formulas.find((f) => f.label === '(1)')!;
    expect(eq1.latex).toContain('\\frac{QK^T}{\\sqrt{d_k}}');
    // 签名差太多的不乱配
    for (const f of structure.formulas) {
      if (f.latex && f !== eq1) expect(f.latex).not.toContain('FFN');
    }
  });

  it('eqnarray 编号逐行、\\nonumber 不计数', () => {
    const { equations } = extractEquations(
      String.raw`\begin{document}\begin{eqnarray} a &=& b \\ c &=& d \nonumber \\ e &=& f \end{eqnarray}\begin{equation}x\end{equation}`,
    );
    expect(equations.map((e) => e.number)).toEqual(['(1)–(2)', '(3)']);
  });

  it('宏：\\def 与带参数的 \\newcommand', () => {
    const m = extractMacros(String.raw`\def\R{\mathbb{R}} \newcommand{\norm}[1]{\lVert #1 \rVert}`);
    expect(m).toEqual({ '\\R': '\\mathbb{R}', '\\norm': '\\lVert #1 \\rVert' });
  });
});

// ---------------------------------------------------------------- 降级：逐页纯文本

describe('GROBID 不可达时的纯文本降级（pdf.js）', () => {
  it('逐页取文字、拼段落、带坐标；“1 Introduction”识别成小节', async () => {
    const pdf = tinyPdf([
      [
        { x: 72, y: 720, text: '1 Introduction', size: 12 },
        { x: 72, y: 690, text: 'Graph contrastive learning maximizes agreement', size: 10 },
        { x: 72, y: 678, text: 'between augmented views of the same graph.', size: 10 },
        { x: 72, y: 640, text: 'A second paragraph about negative sampling.', size: 10 },
      ],
      [{ x: 72, y: 720, text: 'Page two text about temperature scaling.', size: 10 }],
    ]);
    const r = await pdfToText(pdf);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]).toEqual({ width: 612, height: 792 });
    const s = textStructure(r);
    expect(s.sections.map((x) => x.title)).toEqual(['Introduction']);
    const first = s.chunks[0]!;
    expect(first.text).toBe(
      'Graph contrastive learning maximizes agreement between augmented views of the same graph.',
    );
    expect(first.sectionPath).toBe('1 Introduction');
    expect(first).toMatchObject({ page: 1, para: 1 });
    expect(first.boxes[0]!.x).toBeCloseTo(72, 0);
    // y 从页顶往下量：基线 690、字号 10 → 顶部约 92
    expect(first.boxes[0]!.y).toBeGreaterThan(85);
    expect(first.boxes[0]!.y).toBeLessThan(100);
    expect(s.chunks.map((c) => [c.page, c.para])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
  });
});

// ---------------------------------------------------------------- 元数据

describe('元数据解析', () => {
  it('arXiv Atom', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All
       You Need</title><summary>The dominant &amp; models</summary>
      <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
      <arxiv:primary_category term="cs.CL"/></entry></feed>`;
    const m = parseArxivEntry(xml)!;
    expect(m).toMatchObject({
      title: 'Attention Is All You Need',
      year: 2017,
      arxivId: '1706.03762',
      abstract: 'The dominant & models',
      pdfUrl: 'https://arxiv.org/pdf/1706.03762',
    });
    expect(m.authors[0]).toEqual({ name: 'Ashish Vaswani', given: 'Ashish', family: 'Vaswani' });
    expect(m.bib.primaryClass).toBe('cs.CL');
    expect(
      parseArxivEntry('<feed><entry><id>http://arxiv.org/api/errors#x</id></entry></feed>'),
    ).toBeNull();
  });

  it('Crossref 与 OpenAlex', () => {
    const m = parseCrossref({
      message: {
        title: ['ImageNet classification with deep convolutional neural networks'],
        author: [{ given: 'Alex', family: 'Krizhevsky' }],
        issued: { 'date-parts': [[2017, 5, 24]] },
        'container-title': ['Communications of the ACM'],
        type: 'journal-article',
        volume: '60',
        issue: '6',
        page: '84-90',
        DOI: '10.1145/3065386',
        abstract: '<jats:p>We trained a large</jats:p>',
      },
    })!;
    expect(m).toMatchObject({
      year: 2017,
      doi: '10.1145/3065386',
      venue: 'Communications of the ACM',
    });
    expect(m.bib).toMatchObject({ entryType: 'article', pages: '84--90', volume: '60' });
    expect(m.abstract).toBe('We trained a large');
    expect(
      parseOpenAlex({
        best_oa_location: { pdf_url: 'https://x.org/a.pdf' },
        locations: [{ landing_page_url: 'https://arxiv.org/abs/2101.00001v2' }],
      }),
    ).toEqual({ pdfUrl: 'https://x.org/a.pdf', arxivId: '2101.00001' });
    expect(splitName('Ludwig van der Maaten')).toEqual({
      name: 'Ludwig van der Maaten',
      given: 'Ludwig',
      family: 'van der Maaten',
    });
  });
});

// ---------------------------------------------------------------- BibTeX 与引用键

describe('引用键与 BibTeX', () => {
  it('稳定的引用键：姓 + 年 + 标题首个实词，去重音', () => {
    expect(
      baseCitekey({
        authors: [{ name: 'Ashish Vaswani', given: 'Ashish', family: 'Vaswani' }],
        year: 2017,
        title: 'Attention Is All You Need',
      }),
    ).toBe('vaswani2017attention');
    expect(
      baseCitekey({
        authors: [{ name: 'Łukasz Kaiser', given: 'Łukasz', family: 'Kaiser' }],
        year: 2017,
        title: 'One Model To Learn Them All',
      }),
    ).toBe('kaiser2017one');
    expect(
      baseCitekey({
        authors: [{ name: 'Jürgen Schmidhuber', given: 'Jürgen', family: 'Schmidhuber' }],
        year: null,
        title: 'A: the Deep Learning in Neural Networks',
      }),
    ).toBe('schmidhuberdeep');
    expect(baseCitekey({ authors: [], year: 2020, title: '' })).toBe('anon2020');
  });

  it('去重：b、c… 依次', () => {
    const taken = new Set(['vaswani2017attention', 'vaswani2017attentionb']);
    expect(uniqueCitekey('vaswani2017attention', taken)).toBe('vaswani2017attentionc');
    expect(uniqueCitekey('he2016deep', taken)).toBe('he2016deep');
  });

  it('BibTeX：arXiv 条目、转义、花括号配对', () => {
    const bib = toBibtex({
      citekey: 'vaswani2017attention',
      title: 'Attention Is All You Need',
      authors: [
        { name: 'Ashish Vaswani', given: 'Ashish', family: 'Vaswani' },
        { name: 'Noam Shazeer', given: 'Noam', family: 'Shazeer' },
      ],
      year: 2017,
      venue: null,
      doi: null,
      arxivId: '1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      meta: { entryType: 'misc', primaryClass: 'cs.CL' },
    });
    expect(bib).toContain('@misc{vaswani2017attention,');
    expect(bib).toContain('author        = {Vaswani, Ashish and Shazeer, Noam}');
    expect(bib).toContain('title         = {{Attention Is All You Need}}');
    expect(bib).toContain('eprint        = {1706.03762}');
    expect(bib).toContain('archivePrefix = {arXiv}');
    expect(bibKeysIn(bib)).toEqual(new Set(['vaswani2017attention']));
    expect(bibEscape('R&D 50% {bad')).toBe('R\\&D 50\\% bad');
    const art = toBibtex({
      citekey: 'k',
      title: 'T',
      authors: [],
      year: 2017,
      venue: 'Communications of the ACM',
      doi: '10.1145/3065386',
      arxivId: null,
      url: null,
      meta: { entryType: 'article', pages: '84--90' },
    });
    expect(art).toContain('journal = {Communications of the ACM}');
    expect(art).toContain('doi     = {10.1145/3065386}');
  });
});

// ---------------------------------------------------------------- 引用标记与分词

describe('引用标记与分词', () => {
  it('解析 [p.5 ¶3] / [key, p.5 ¶3] / （p.5）', () => {
    const text = '缩放因子是 1/√d_k [p.4 ¶2]，多头见 [vaswani2017attention, p.5 ¶1]；另见（p.9）。';
    const ms = parseCitationMarkers(text);
    expect(ms.map((m) => [m.citekey, m.page, m.para])).toEqual([
      [null, 4, 2],
      ['vaswani2017attention', 5, 1],
      [null, 9, null],
    ]);
    const parts = splitByCitations(text);
    expect(parts.filter((p) => p.kind === 'cite')).toHaveLength(3);
    expect(parts.map((p) => (p.kind === 'text' ? p.text : p.marker.raw)).join('')).toBe(text);
    expect(formatCitation(5, 3, 'k')).toBe('[k, p.5 ¶3]');
    // 普通方括号不误判
    expect(parseCitationMarkers('见 [13] 和 [Q, K]')).toEqual([]);
  });

  it('分词：小写、去停用词、词干、连字符、中文二元组', () => {
    expect(tokenize('The Attention mechanisms are used')).toEqual(['attention', 'mechanism']);
    expect(tokenize('self-attention')).toEqual(['self', 'attention', 'self-attention']);
    expect(tokenize('位置编码')).toEqual(['位置', '置编', '编码']);
  });
});
