import { describe, expect, it } from 'vitest';
import type { PaperChunk } from '@srh/shared';
import { guessImportKind, shortAuthors } from './format';
import { chunkAt, findChunk } from './reader';

const chunk = (
  seq: number,
  page: number,
  para: number,
  box: [number, number, number, number],
): PaperChunk => ({
  id: `p:${seq}`,
  seq,
  kind: 'paragraph',
  sectionIndex: null,
  sectionPath: '',
  page,
  para,
  boxes: [{ page, x: box[0], y: box[1], w: box[2], h: box[3] }],
  text: `chunk ${seq}`,
});

describe('文献库前端工具', () => {
  it('识别导入方式', () => {
    expect(guessImportKind('1706.03762')).toBe('arxiv');
    expect(guessImportKind('arXiv:1706.03762v7')).toBe('arxiv');
    expect(guessImportKind('https://arxiv.org/abs/1706.03762')).toBe('arxiv');
    expect(guessImportKind('10.1145/3065386')).toBe('doi');
    expect(guessImportKind('https://doi.org/10.1145/3065386')).toBe('doi');
    expect(guessImportKind('https://example.org/a.pdf')).toBe('url');
    expect(guessImportKind('attention')).toBeNull();
  });

  it('作者简写', () => {
    const a = (family: string) => ({ name: family, given: null, family });
    expect(shortAuthors([])).toBe('作者未知');
    expect(shortAuthors([a('Vaswani'), a('Shazeer')])).toBe('Vaswani、Shazeer');
    expect(shortAuthors([a('Vaswani'), a('Shazeer'), a('Parmar')])).toBe('Vaswani 等 3 人');
  });

  it('引用 → 段落；点击位置 → 段落', () => {
    const chunks = [
      chunk(0, 1, 1, [72, 100, 400, 50]),
      chunk(1, 2, 1, [72, 80, 400, 40]),
      chunk(2, 2, 2, [72, 140, 400, 40]),
    ];
    expect(findChunk(chunks, 2, 2)?.seq).toBe(2);
    expect(findChunk(chunks, 2, null)?.seq).toBe(1);
    expect(findChunk(chunks, 2, 9)?.seq).toBe(1);
    expect(findChunk(chunks, 7, 1)).toBeUndefined();
    expect(chunkAt(chunks, 2, 100, 150)?.seq).toBe(2);
    expect(chunkAt(chunks, 1, 10, 10)).toBeUndefined();
  });
});
