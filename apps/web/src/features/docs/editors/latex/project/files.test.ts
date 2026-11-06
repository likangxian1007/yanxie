import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YDOC_FIELD } from '@srh/shared';
import {
  addAsset,
  checkFileName,
  createTextFile,
  deleteFile,
  fileMode,
  listProjectFiles,
  renameFile,
  resolveActive,
  suggestName,
  textContents,
  textOf,
} from './files';

function makeDoc() {
  const doc = new Y.Doc();
  doc.getText(YDOC_FIELD.latex).insert(0, '\\documentclass{article}');
  return doc;
}

describe('LaTeX 工程文件（文件栏的状态）', () => {
  it('main.tex 永远在最前，文本文件按名字排序，图片在最后', () => {
    const doc = makeDoc();
    createTextFile(doc, 'references.bib', '@misc{a, title={A}}');
    createTextFile(doc, 'appendix.tex', 'x');
    addAsset(doc, 'figures/arch.png', { fileId: 'fil_1', mime: 'image/png', size: 10 });
    expect(listProjectFiles(doc).map((f) => [f.name, f.kind])).toEqual([
      ['main.tex', 'main'],
      ['appendix.tex', 'text'],
      ['references.bib', 'text'],
      ['figures/arch.png', 'image'],
    ]);
    expect(textOf(doc, 'main.tex')?.toString()).toContain('documentclass');
    expect(textOf(doc, 'references.bib')?.toString()).toContain('@misc');
    expect(textOf(doc, 'figures/arch.png')).toBeNull();
    expect(Object.keys(textContents(doc))).toEqual(['main.tex', 'references.bib', 'appendix.tex']);
  });

  it('新文件名检查：规范化、扩展名、重名、main.tex 保留', () => {
    const doc = makeDoc();
    createTextFile(doc, 'references.bib');
    expect(checkFileName(doc, ' ./refs.bib ')).toEqual({
      ok: true,
      name: 'refs.bib',
      kind: 'text',
    });
    expect(checkFileName(doc, 'references.bib')).toMatchObject({ ok: false });
    expect(checkFileName(doc, 'main.tex')).toMatchObject({ ok: false });
    expect(checkFileName(doc, '../x.tex')).toMatchObject({ ok: false });
    expect(checkFileName(doc, 'notes.docx')).toMatchObject({ ok: false });
    expect(checkFileName(doc, 'fig.png', 'text')).toMatchObject({ ok: false });
    expect(checkFileName(doc, 'fig.png', 'image')).toMatchObject({ ok: true, kind: 'image' });
    // 改名成自己不算重名
    expect(checkFileName(doc, 'references.bib', 'text', 'references.bib')).toMatchObject({
      ok: true,
    });
  });

  it('改名保留内容，删除后当前文件回到 main.tex', () => {
    const doc = makeDoc();
    createTextFile(doc, 'references.bib', '@misc{a}');
    renameFile(doc, 'references.bib', 'refs.bib');
    expect(textOf(doc, 'refs.bib')?.toString()).toBe('@misc{a}');
    expect(textOf(doc, 'references.bib')).toBeNull();
    let files = listProjectFiles(doc);
    expect(resolveActive(files, 'references.bib')).toBe('main.tex');
    expect(resolveActive(files, 'refs.bib')).toBe('refs.bib');
    deleteFile(doc, 'refs.bib');
    deleteFile(doc, 'main.tex'); // 主文件删不掉
    files = listProjectFiles(doc);
    expect(files.map((f) => f.name)).toEqual(['main.tex']);
    addAsset(doc, 'a.png', { fileId: 'fil_1', mime: 'image/png', size: 1 });
    expect(resolveActive(listProjectFiles(doc), 'a.png')).toBe('main.tex');
  });

  it('两个客户端同时编辑 references.bib 能合并', () => {
    const a = makeDoc();
    createTextFile(a, 'references.bib', 'X');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    textOf(a, 'references.bib')!.insert(0, 'A');
    textOf(b, 'references.bib')!.insert(1, 'B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(textOf(a, 'references.bib')!.toString()).toBe(textOf(b, 'references.bib')!.toString());
    expect(textOf(a, 'references.bib')!.toString()).toContain('A');
    expect(textOf(a, 'references.bib')!.toString()).toContain('B');
  });

  it('默认文件名与编辑器模式', () => {
    const doc = makeDoc();
    expect(suggestName(doc, 'references', 'bib')).toBe('references.bib');
    createTextFile(doc, 'references.bib');
    expect(suggestName(doc, 'references', 'bib')).toBe('references-2.bib');
    expect(fileMode('references.bib')).toBe('bib');
    expect(fileMode('sections/intro.tex')).toBe('latex');
    expect(fileMode('data.csv')).toBe('plain');
  });
});
