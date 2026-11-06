import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as Y from 'yjs';
import { LATEX_LIMITS, LatexAsset } from '@srh/shared';
import { buildLatexZip } from './texExport';
import { importTex, mainFileScore, pickMainFile, texTitle } from './tex';
import { ImportError, type ImportContext } from './types';

const MAIN = String.raw`\documentclass{ctexart}
\usepackage{graphicx}
\title{基于图神经网络的分子性质预测}
\begin{document}
\maketitle
\section{引言}
中文正文，引用\cite{li2024}。
\includegraphics[width=0.5\linewidth]{figures/arch.png}
\input{sections/method}
\bibliography{references}
\end{document}
`;
const BIB = '@article{li2024,\n  title={分子表示学习},\n  author={李四},\n  year={2024}\n}\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function zipFile(name: string, entries: Record<string, Uint8Array>): File {
  return new File([zipSync(entries).slice()], name, { type: 'application/zip' });
}

function fakeCtx() {
  const uploads: { name: string; size: number; type: string }[] = [];
  const ctx: ImportContext = {
    projectId: 'prj_1',
    uploadFile: vi.fn(async (blob: Blob, name: string) => {
      uploads.push({ name, size: blob.size, type: blob.type });
      return {
        id: `fil_${uploads.length}`,
        url: `/api/v1/projects/prj_1/files/fil_${uploads.length}`,
      };
    }),
  };
  return { ctx, uploads };
}

describe('importTex：单个 .tex', () => {
  it('写进 source，返回 \\title', async () => {
    const doc = new Y.Doc();
    const res = await importTex(new File([MAIN], 'paper.tex'), doc);
    expect(doc.getText('source').toString()).toBe(MAIN);
    expect(res.title).toBe('基于图神经网络的分子性质预测');
    expect(res.warnings).toEqual([]);
  });

  it('GBK 编码与 CRLF 也能读', async () => {
    // “中文” 的 GBK 编码
    const gbk = new Uint8Array([
      ...strToU8('\\documentclass{article}\r\n\\begin{document}\r\n'),
      0xd6,
      0xd0,
      0xce,
      0xc4,
      ...strToU8('\r\n\\end{document}\r\n'),
    ]);
    const doc = new Y.Doc();
    await importTex(new File([gbk], 'old.tex'), doc);
    expect(doc.getText('source').toString()).toBe(
      '\\documentclass{article}\n\\begin{document}\n中文\n\\end{document}\n',
    );
  });

  it('没有 \\documentclass 时提示可能是章节文件', async () => {
    const res = await importTex(new File(['\\section{方法}'], 'method.tex'), new Y.Doc());
    expect(res.warnings?.[0]).toContain('章节文件');
  });
});

describe('importTex：工程 .zip', () => {
  it('找主文件（在子目录里也行）、文本进 files、图片上传进 assets、跳过垃圾与不合规文件', async () => {
    const file = zipFile('我的论文.zip', {
      'paper/main.tex': strToU8(MAIN),
      'paper/references.bib': strToU8(BIB),
      'paper/sections/method.tex': strToU8('\\section{方法}\n我们提出……\n'),
      'paper/figures/arch.png': PNG,
      'paper/main.pdf': strToU8('%PDF-1.5 output'),
      'paper/main.aux': strToU8('junk'),
      'paper/.DS_Store': strToU8('junk'),
      '__MACOSX/paper/._main.tex': strToU8('junk'),
      'paper/图片 1.png': PNG,
      'paper/fonts/x.ttf': strToU8('font'),
    });
    const { ctx, uploads } = fakeCtx();
    const doc = new Y.Doc();
    const res = await importTex(file, doc, ctx);

    expect(doc.getText('source').toString()).toBe(MAIN);
    const files = doc.getMap<Y.Text>('files');
    expect([...files.keys()].sort()).toEqual(['references.bib', 'sections/method.tex']);
    expect(files.get('references.bib')!.toString()).toBe(BIB);
    const asset = LatexAsset.parse(doc.getMap('assets').get('figures/arch.png'));
    expect(asset).toEqual({ fileId: 'fil_1', mime: 'image/png', size: PNG.byteLength });
    expect(uploads).toEqual([
      { name: 'figures/arch.png', size: PNG.byteLength, type: 'image/png' },
    ]);
    expect(res.title).toBe('基于图神经网络的分子性质预测');
    const warn = (res.warnings ?? []).join('\n');
    expect(warn).toContain('图片 1.png');
    expect(warn).toContain('fonts/x.ttf');
    expect(warn).not.toContain('main.aux');
  });

  it('主文件不叫 main.tex 时改名为 main.tex 并提示；主文件目录以外的文件跳过', async () => {
    const file = zipFile('p.zip', {
      'src/thesis.tex': strToU8(MAIN),
      'src/chapter1.tex': strToU8('\\chapter{一}'),
      'shared/macros.sty': strToU8('% macros'),
    });
    const doc = new Y.Doc();
    const res = await importTex(file, doc, fakeCtx().ctx);
    expect([...doc.getMap('files').keys()]).toEqual(['chapter1.tex']);
    const warn = (res.warnings ?? []).join('\n');
    expect(warn).toContain('src/thesis.tex 已作为 main.tex');
    expect(warn).toContain('shared/macros.sty');
  });

  it('没有主文件 → 友好错误；坏 zip → 友好错误', async () => {
    const noMain = zipFile('x.zip', { 'a.bib': strToU8(BIB), 'b.tex': strToU8('\\section{x}') });
    await expect(importTex(noMain, new Y.Doc())).rejects.toThrow(/没有找到 LaTeX 主文件/u);
    const broken = new File([strToU8('not a zip at all')], 'broken.zip');
    const err = await importTex(broken, new Y.Doc()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toContain('压缩包打不开');
  });

  it('遵守文件数上限（含 main.tex）', async () => {
    const entries: Record<string, Uint8Array> = { 'main.tex': strToU8(MAIN) };
    for (let i = 0; i < LATEX_LIMITS.files + 5; i += 1) entries[`s${i}.tex`] = strToU8(`% ${i}`);
    const doc = new Y.Doc();
    const res = await importTex(zipFile('many.zip', entries), doc);
    expect(doc.getMap('files').size + 1).toBe(LATEX_LIMITS.files);
    expect((res.warnings ?? []).join()).toContain(`最多 ${LATEX_LIMITS.files} 个文件`);
  });

  it('图片上传失败 → 整体失败（外壳负责清理），Y.Doc 不写半截', async () => {
    const file = zipFile('p.zip', { 'main.tex': strToU8(MAIN), 'figures/arch.png': PNG });
    const ctx: ImportContext = {
      projectId: 'p',
      uploadFile: () => Promise.reject(new Error('网络断了')),
    };
    const doc = new Y.Doc();
    await expect(importTex(file, doc, ctx)).rejects.toThrow('网络断了');
    expect(doc.getText('source').length).toBe(0);
  });

  it('没有 ctx 时图片不导入，并提示', async () => {
    const file = zipFile('p.zip', { 'main.tex': strToU8(MAIN), 'figures/arch.png': PNG });
    const doc = new Y.Doc();
    const res = await importTex(file, doc);
    expect(doc.getMap('assets').size).toBe(0);
    expect((res.warnings ?? []).join()).toContain('没有上传图片');
  });
});

describe('主文件识别与标题', () => {
  it('注释里的 \\documentclass 不算；main.tex 优先；浅目录优先', () => {
    expect(mainFileScore('a.tex', '% \\documentclass{article}\n')).toBe(0);
    expect(
      pickMainFile([
        { path: 'x/deep/paper.tex', content: MAIN },
        { path: 'main.tex', content: MAIN },
        { path: 'other.tex', content: MAIN },
      ]),
    ).toBe('main.tex');
    expect(pickMainFile([{ path: 'a.tex', content: 'hi' }])).toBeNull();
  });

  it('\\title 里的命令与换行被清理', () => {
    expect(texTitle('\\title{A \\textbf{Bold} Title\\\\ 副标题}')).toBe('A Bold Title 副标题');
    expect(texTitle('% \\title{注释}')).toBe('');
  });
});

describe('导出工程 .zip 再导入（往返）', () => {
  it('文件、图片完整保留', async () => {
    const { ctx } = fakeCtx();
    const first = new Y.Doc();
    await importTex(
      zipFile('p.zip', {
        'main.tex': strToU8(MAIN),
        'references.bib': strToU8(BIB),
        'figures/arch.png': PNG,
      }),
      first,
      ctx,
    );
    const { zip, missing, fileCount } = await buildLatexZip(first, async (id) => {
      expect(id).toBe('fil_1');
      return PNG;
    });
    expect(missing).toEqual([]);
    expect(fileCount).toBe(3);
    const second = new Y.Doc();
    const again = fakeCtx();
    await importTex(new File([zip.slice()], '导出.zip'), second, again.ctx);
    expect(second.getText('source').toString()).toBe(MAIN);
    expect(second.getMap<Y.Text>('files').get('references.bib')!.toString()).toBe(BIB);
    expect(again.uploads).toEqual([
      { name: 'figures/arch.png', size: PNG.byteLength, type: 'image/png' },
    ]);
  });

  it('取不到的图片记在 missing 里，其余照常打包', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, MAIN);
    doc.getMap('assets').set('figures/gone.png', { fileId: 'fil_x', mime: 'image/png', size: 3 });
    const res = await buildLatexZip(doc, () => Promise.reject(new Error('404')));
    expect(res.missing).toEqual(['figures/gone.png']);
    expect(res.fileCount).toBe(1);
  });
});
