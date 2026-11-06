import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { importDocx } from './docx';
import { importPptx } from './pptx';
import { IMPORT_FORMATS, importAccept, routeImport } from './registry';
import { importTex } from './tex';
import { ImportError } from './types';
import { importXlsx } from './xlsx';
import { importHtml, importMarkdown, importPlainText } from './markup';

const f = (name: string, size = 10) => ({ name, size });

describe('routeImport', () => {
  it.each([
    ['周报.docx', 'doc'],
    ['数据.xlsx', 'sheet'],
    ['旧表.xls', 'sheet'],
    ['导出.CSV', 'sheet'],
    ['组会.pptx', 'slides'],
    ['paper.tex', 'latex'],
    ['overleaf.zip', 'latex'],
    ['笔记.md', 'doc'],
    ['readme.markdown', 'doc'],
    ['摘录.txt', 'doc'],
    ['网页.html', 'doc'],
    ['page.htm', 'doc'],
  ])('%s → %s', (name, kind) => {
    const r = routeImport(f(name));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe(kind);
  });

  it('扩展名映射到约定的导入器', async () => {
    const load = (ext: string) => IMPORT_FORMATS.find((x) => x.exts.includes(ext))!.load();
    expect(await load('docx')).toBe(importDocx);
    expect(await load('xlsx')).toBe(importXlsx);
    expect(await load('csv')).toBe(importXlsx);
    expect(await load('pptx')).toBe(importPptx);
    expect(await load('tex')).toBe(importTex);
    expect(await load('zip')).toBe(importTex);
    expect(await load('md')).toBe(importMarkdown);
    expect(await load('txt')).toBe(importPlainText);
    expect(await load('html')).toBe(importHtml);
  });

  it('不支持的类型、旧版 Office、空文件、太大：给出中文原因', () => {
    const exe = routeImport(f('setup.exe'));
    expect(exe).toMatchObject({ ok: false });
    if (!exe.ok) expect(exe.error).toContain('不支持 .exe');
    const doc = routeImport(f('老文件.doc'));
    if (!doc.ok) expect(doc.error).toContain('另存为 .docx');
    const noext = routeImport(f('Makefile'));
    if (!noext.ok) expect(noext.error).toContain('认不出');
    const empty = routeImport(f('a.md', 0));
    if (!empty.ok) expect(empty.error).toContain('空的');
    const big = routeImport(f('a.tex', 5 * 1024 * 1024));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/太大.*最大 4\.0 MB/u);
  });

  it('只接受某一类时拒绝别的类型', () => {
    expect(routeImport(f('a.zip'), 'latex').ok).toBe(true);
    const r = routeImport(f('a.docx'), 'latex');
    expect(r.ok).toBe(false);
  });

  it('accept 列表', () => {
    expect(importAccept('latex')).toBe('.tex,.zip');
    expect(importAccept()).toContain('.docx');
    expect(importAccept()).toContain('.html');
  });
});

// 真实导入器（docx / xlsx / pptx）遇到损坏 / 不是 Office 的文件：抛 ImportError，给中文原因，
// 不把解析库的英文报错直接甩给用户，也不往 Y.Doc 里写半截内容。
// 解析库按需加载，首次加载在 CI 满载时可能要几秒，所以单独放宽超时。
describe('损坏的文件', () => {
  it.each([
    ['a.docx', importDocx, /Word/u],
    ['a.xlsx', importXlsx, /Excel/u],
    ['a.pptx', importPptx, /PPT/u],
  ] as const)(
    '%s 抛出友好的中文错误',
    async (name, fn, label) => {
      const ydoc = new Y.Doc();
      const garbage = new Uint8Array(256).map((_, i) => (i * 37 + 11) % 251);
      const err = await fn(new File([garbage], name), ydoc).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      const msg = (err as Error).message;
      expect(msg).toMatch(label);
      expect(msg).toMatch(/[\u4e00-\u9fff]/u);
      expect(msg).not.toMatch(/zip|EOCD|undefined|Cannot|TypeError/iu);
      // 空文档的状态更新只有两个字节（没有任何结构）
      expect(Y.encodeStateAsUpdate(ydoc).length).toBeLessThanOrEqual(2);
    },
    30_000,
  );

  it('旧版 .xls 提示另存为 .xlsx', async () => {
    const err = await importXlsx(new File(['x'], '旧表.xls'), new Y.Doc()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toContain('.xlsx');
  });
});
