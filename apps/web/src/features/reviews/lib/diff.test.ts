import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, splitLines, toSegments, type DiffLine } from './diff';

const kinds = (lines: DiffLine[]) => lines.map((l) => `${l.kind[0]}:${l.text}`);

describe('splitLines', () => {
  it('统一换行符，末尾换行不算一行', () => {
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('完全相同时全是 same', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.every((l) => l.kind === 'same')).toBe(true);
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 });
  });

  it('识别中间的替换、插入与删除', () => {
    const d = diffLines(
      '# 标题\n第一段\n第二段\n结尾',
      '# 标题\n第一段（改）\n第二段\n新增一行\n结尾',
    );
    expect(kinds(d)).toEqual([
      's:# 标题',
      'd:第一段',
      'a:第一段（改）',
      's:第二段',
      'a:新增一行',
      's:结尾',
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it('行号对齐旧版本与新版本', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne');
    const c = d.find((l) => l.text === 'c');
    expect(c).toMatchObject({ kind: 'same', oldNo: 3, newNo: 3 });
    expect(d.find((l) => l.text === 'b')).toMatchObject({ kind: 'del', oldNo: 2, newNo: null });
    expect(d.find((l) => l.text === 'x')).toMatchObject({ kind: 'add', oldNo: null, newNo: 2 });
    expect(d.find((l) => l.text === 'e')).toMatchObject({ kind: 'add', newNo: 5 });
  });

  it('公共后缀的行号按新增/删除的行数平移', () => {
    const d = diffLines('a\nz', 'a\nb\nc\nz');
    expect(d[d.length - 1]).toMatchObject({ kind: 'same', text: 'z', oldNo: 2, newNo: 4 });
  });

  it('空到有、有到空', () => {
    expect(kinds(diffLines('', 'x\ny'))).toEqual(['a:x', 'a:y']);
    expect(kinds(diffLines('x\ny', ''))).toEqual(['d:x', 'd:y']);
  });

  it('得到的是最长公共子序列', () => {
    const d = diffLines('a\nb\nc\nd\ne\nf', 'a\nc\nb\nd\nf\ne');
    expect(d.filter((l) => l.kind === 'same')).toHaveLength(4);
    // 还原两边
    expect(d.filter((l) => l.kind !== 'add').map((l) => l.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
    expect(d.filter((l) => l.kind !== 'del').map((l) => l.text)).toEqual([
      'a',
      'c',
      'b',
      'd',
      'f',
      'e',
    ]);
  });
});

describe('toSegments', () => {
  it('改动上下各留 3 行，其余未改动折叠', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
    const next = old.replace('l10', 'L10');
    const segs = toSegments(diffLines(old, next));
    expect(segs.map((s) => s.type)).toEqual(['collapsed', 'lines', 'collapsed']);
    expect(segs[0]?.lines).toHaveLength(6); // l1–l6
    expect(segs[1]?.lines.map((l) => l.text)).toEqual([
      'l7',
      'l8',
      'l9',
      'l10',
      'L10',
      'l11',
      'l12',
      'l13',
    ]);
    expect(segs[2]?.lines).toHaveLength(7); // l14–l20
  });

  it('太短的未改动段不折叠', () => {
    const segs = toSegments(diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne'));
    expect(segs).toHaveLength(1);
    expect(segs[0]?.type).toBe('lines');
  });

  it('没有改动时整篇折叠', () => {
    const text = 'a\nb\nc\nd\ne';
    expect(toSegments(diffLines(text, text)).map((s) => s.type)).toEqual(['collapsed']);
  });
});
