import { describe, expect, it } from 'vitest';
import { issueCounts, parseTexLog, translateError, unwrapLog, withFailureIssue } from './texLog';

/** tectonic（XeTeX）真实日志的节选 */
const TECTONIC_LOG = String.raw`**
(main.tex
LaTeX2e <2021-11-15> patch level 1
L3 programming layer <2022-02-24> (article.cls
Document Class: article 2021/10/04 v1.4n Standard LaTeX document class
(size10.clo
File: size10.clo 2021/10/04 v1.4n Standard LaTeX file (size option)
)
\c@part=\count181
) (amsmath.sty
Package: amsmath 2021/10/15 v2.17l AMS math features
(amstext.sty
Package: amstext 2021/08/26 v2.01 AMS text
 (amsgen.sty
File: amsgen.sty 1999/11/30 v2.0 generic functions
)) (amsbsy.sty
Package: amsbsy 1999/11/29 v1.2d Bold Symbols
))
LaTeX Font Info:    Trying to load font information for TS1+cmr on input line 3
.
(ts1cmr.fd
File: ts1cmr.fd 2019/12/16 v2.5j Standard LaTeX font definitions
)


LaTeX Warning: Citation ${'`'}nokey' on page 1 undefined on input line 4.


LaTeX Warning: Reference ${'`'}nolabel' on page 1 undefined on input line 4.

! Undefined control sequence.
l.5 \undefinedcmd
                 {a}
The control sequence at the end of the top line
of your error message was never \def'ed. If you have
misspelled it (e.g., ${'`'}\hobx'), type ${'`'}I' and the correct
spelling (e.g., ${'`'}I\hbox'). Otherwise just continue,
and I'll forget about whatever was undefined.

! Missing $ inserted.
<inserted text> 
                $
l.7 \begin{itemize}
                   
I've inserted a begin-math/end-math symbol since I think
you left one out. Proceed, with fingers crossed.

(sections/intro.tex
! LaTeX Error: Lonely \item--perhaps a missing list environment.

See the LaTeX manual or LaTeX Companion for explanation.
Type  H <return>  for immediate help.
 ...                                              
                                                  
l.3 \item a
           
)
Overfull \hbox (12.0pt too wide) in paragraph at lines 9--10
[]\TU/lmr/m/n/10 Averyveryverylongword

Package natbib Warning: Citation ${'`'}smith' on page 1 undefined on input line 12
(natbib)                .

[1

] (main.aux)

LaTeX Warning: There were undefined references.

 )
Output written on main.xdv (1 page, 672 bytes).

---- BibTeX（main.blg）----
This is BibTeX, Version 0.99d
Database file #1: references.bib
Warning--I didn't find a database entry for "nokey"
I was expecting a ${'`'},' or a ${'`'}}'---line 7 of file references.bib
 :
 :  title = {Broken}
(Error may have been on previous line)

---- 编译器输出（tectonic）----
error: main.tex:5: Undefined control sequence
warning: errors were issued by the TeX engine, but were ignored
`;

const FILES = ['main.tex', 'references.bib', 'sections/intro.tex'];

describe('parseTexLog', () => {
  const issues = parseTexLog(TECTONIC_LOG, { projectFiles: FILES });

  it('经典 ! 错误：行号、文件、中文说明；只把真错误标成可让 AI 修', () => {
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.map((e) => [e.file, e.line, e.kind])).toEqual([
      ['main.tex', 5, 'undefined_control'],
      ['main.tex', 7, 'other'],
      ['sections/intro.tex', 3, 'other'],
      ['references.bib', 7, 'bibtex'],
    ]);
    expect(errors[0]!.message).toContain('\\undefinedcmd');
    expect(errors[0]!.fixable).toBe(true);
    expect(errors[1]!.message).toContain('缺少 $');
    expect(errors[2]!.message).toContain('\\item');
    expect(errors[0]!.raw).toContain('! Undefined control sequence.');
  });

  it('引用 / 标签警告：缺参考文献不可交给 AI，缺标签可以；汇总提示被略过', () => {
    const warnings = issues.filter((i) => i.severity === 'warning');
    const cite = warnings.filter((w) => w.kind === 'undefined_citation');
    expect(cite.map((w) => w.message)).toEqual([
      expect.stringContaining('nokey'),
      expect.stringContaining('smith'),
      'references.bib 里没有条目 nokey',
    ]);
    expect(cite.every((w) => !w.fixable)).toBe(true);
    expect(cite[1]!.line).toBe(12);
    const ref = warnings.find((w) => w.kind === 'undefined_reference');
    expect(ref).toMatchObject({ line: 4, file: 'main.tex', fixable: true });
    expect(warnings.some((w) => /There were undefined/u.test(w.raw))).toBe(false);
  });

  it('排版提示（Overfull）为 info，带行号', () => {
    const info = issues.filter((i) => i.severity === 'info');
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ kind: 'badbox', line: 9, fixable: false });
  });

  it('TeX 日志里已有错误时，不重复列出编译器输出里的 error: 行', () => {
    expect(issues.filter((i) => i.message.includes('Undefined control'))).toHaveLength(0);
    expect(issueCounts(issues)).toEqual({ errors: 4, warnings: 4 });
  });

  it('-file-line-error 格式与服务端拒绝说明', () => {
    const r = parseTexLog(
      [
        './main.tex:12: Undefined control sequence.',
        'l.12 \\foo',
        '',
        "./main.tex:20: LaTeX Error: File `missing.sty' not found.",
      ].join('\n'),
      { projectFiles: FILES },
    );
    expect(r.map((i) => [i.file, i.line, i.kind, i.fixable])).toEqual([
      ['main.tex', 12, 'undefined_control', true],
      ['main.tex', 20, 'missing_file', false],
    ]);
    const rejected = parseTexLog(
      'main.tex:3: 不能引用工程以外的文件（绝对路径或 ..）：\\input{/etc/passwd}',
    );
    expect(rejected[0]).toMatchObject({ severity: 'error', line: 3, file: 'main.tex' });
  });

  it('没有 TeX 日志时退回编译器输出；研协提示单独列出', () => {
    const r = parseTexLog(
      [
        '',
        '---- 编译器输出（tectonic）----',
        'error: main.tex:5: Undefined control sequence',
        'error: something bad happened inside XeTeX; its output follows:',
        '',
        '研协：编译超过 90 秒被终止。第一次用到某些宏包时需要下载，可以稍后再试一次。',
      ].join('\n'),
    );
    expect(r.map((i) => [i.severity, i.line])).toEqual([
      ['error', 5],
      ['error', null],
    ]);
    expect(r[1]!.message).toContain('90 秒');
  });

  it('BibTeX：找不到 .bib、缺 \\bibdata', () => {
    const r = parseTexLog(
      [
        '(main.tex)',
        '---- BibTeX（main.blg）----',
        "I couldn't open database file refs.bib",
        'I found no \\bibdata command---while reading file main.aux',
      ].join('\n'),
    );
    expect(r.map((i) => [i.kind, i.fixable])).toEqual([
      ['missing_bib', false],
      ['missing_bib', false],
    ]);
    expect(r[0]!.message).toContain('refs.bib');
  });

  it('BibTeX 找不到 refs.bib：只算 1 个错误（main.aux 的位置行不是 .bib 语法错误），连带警告不刷屏', () => {
    // R2 e2e 论文在平台编译的真实日志节选（tectonic 0.17.0，工程里只有 main.tex）
    const blg = [
      '(main.tex',
      "LaTeX Warning: Citation `qiao2024simple' on page 1 undefined on input line 24.",
      '',
      "LaTeX Warning: `h' float specifier changed to `ht'.",
      '',
      "LaTeX Warning: `h' float specifier changed to `ht'.",
      '',
      ')',
      '---- BibTeX（main.blg）----',
      'This is BibTeX, Version 0.99d',
      'The top-level auxiliary file: main.aux',
      'The style file: plain.bst',
      "I couldn't open database file refs.bib",
      '---line 37 of file main.aux',
      ' : \\bibdata{refs',
      ' :              }',
      "I'm skipping whatever remains of this command",
      'I found no database files---while reading file main.aux',
      'Warning--I didn\'t find a database entry for "su2023prototypeformer"',
      'Warning--I didn\'t find a database entry for "qiao2024simple"',
      '(There were 2 error messages)',
    ].join('\n');
    const r = parseTexLog(blg, { projectFiles: ['main.tex'] });
    const errors = r.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'missing_bib', fixable: false });
    expect(errors[0]!.message).toContain('refs.bib');
    expect(r.some((i) => i.kind === 'bibtex')).toBe(false);
    expect(r.some((i) => /没有条目/u.test(i.message))).toBe(false);
    // 浮动体被挪走：中文说明，只列一次
    const floats = r.filter((i) => /放不下/u.test(i.message));
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ severity: 'warning', fixable: false });

    // 服务端补了 “参考文献库缺失” 说明时：以它为准（带行号），BibTeX 那条不重复计数
    const withNote = `${blg}\n\n研协：参考文献库缺失：main.tex 第 112 行 \\bibliography{refs} 要用 refs.bib，但这个 LaTeX 工程里没有这个文件，BibTeX 没有生成参考文献。`;
    const r2 = parseTexLog(withNote, { projectFiles: ['main.tex'] });
    const e2 = r2.filter((i) => i.severity === 'error');
    expect(e2.map((e) => [e.file, e.line, e.kind])).toEqual([['main.tex', 112, 'missing_bib']]);
    expect(e2[0]!.message.startsWith('\\bibliography{refs} 要用 refs.bib')).toBe(true);
    const cite = r2.find((i) => i.kind === 'undefined_citation');
    expect(cite!.message).toContain('refs.bib 不在工程里');
  });

  it('.bib 打开了但缺条目：写出真实的库名', () => {
    const r = parseTexLog(
      [
        '(main.tex)',
        '---- BibTeX（main.blg）----',
        'Database file #1: refs.bib',
        'Warning--I didn\'t find a database entry for "x"',
      ].join('\n'),
    );
    expect(r.map((i) => i.message)).toEqual(['refs.bib 里没有条目 x']);
  });

  it('ctex 中文文档的成功日志没有问题', () => {
    const ok = String.raw`(main.tex
LaTeX2e <2021-11-15> patch level 1
(ctexart.cls
Document Class: ctexart 2021/12/12 v2.5.8 Chinese adapter for class article
(ctexbackend.cfg) (xeCJK.sty
Package: xeCJK 2021/12/12 v3.8.8 Typesetting CJK scripts with XeLaTeX
)) (ctex-fontset-fandol.def
Package fontspec Info: Font family 'FandolSong-Regular(0)' created for font
(fontspec)             'FandolSong-Regular' with options
(fontspec)             [Script={CJK},Extension={.otf}].
)
[1

] (main.aux) )
Output written on main.xdv (1 page, 3528 bytes).`;
    expect(parseTexLog(ok)).toEqual([]);
  });
});

describe('辅助函数', () => {
  it('79 列折行拼回去', () => {
    const long = `LaTeX Warning: Reference \`label' on page 3 undefined on input li`.padStart(
      79,
      'x',
    );
    expect(long.length).toBe(79);
    expect(unwrapLog(`${long}\nne 42.\nnext`)).toEqual([`${long}ne 42.`, 'next']);
  });

  it('translateError 取出未定义的命令名', () => {
    expect(translateError('Undefined control sequence.', '\\alpha + \\foo').message).toContain(
      '\\foo',
    );
    expect(translateError('Something odd', '')).toMatchObject({ kind: 'other', fixable: true });
  });
});

describe('withFailureIssue', () => {
  const log =
    '(main.tex)\n---- 编译器输出（tectonic）----\nnote: Running xdvipdfmx ...\nlibpng error: IDAT: invalid bit length repeat\n';
  it('没有 PDF 又没解析出错误：补一条（图片坏了给出说明）', () => {
    const r = withFailureIssue(parseTexLog(log), 'error', log, false);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ severity: 'error', kind: 'missing_file', fixable: false });
    expect(r[0]!.message).toContain('图片');
    expect(withFailureIssue([], 'timeout', '', false)[0]!.message).toContain('编译失败');
  });
  it('成功、或出错但有 PDF、或已有错误时不补', () => {
    expect(withFailureIssue([], 'success', log, true)).toEqual([]);
    expect(withFailureIssue([], 'error', log, true)).toEqual([]);
    const existing = parseTexLog('! Undefined control sequence.\nl.3 \\foo');
    expect(withFailureIssue(existing, 'error', log, false)).toBe(existing);
  });
});
