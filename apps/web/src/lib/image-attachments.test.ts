import { describe, expect, it } from 'vitest';
import type { OutputRef } from '@srh/shared';
import {
  fileAttachmentUrl,
  fileInlineUrl,
  isPreviewableImage,
  splitImageOutputs,
} from './image-attachments';

const out = (id: string, kind: OutputRef['kind'], title: string): OutputRef => ({
  id,
  kind,
  ref: `file_${id}`,
  title,
});

describe('image attachments', () => {
  it('只把服务端内联返回的位图当作可预览图片', () => {
    for (const name of ['a.png', 'B.JPG', '图.jpeg', 'x.gif', 'y.webp'])
      expect(isPreviewableImage(name)).toBe(true);
    for (const name of ['logo.svg', 'a.pdf', 'png', '.png', 'a.', '', null, undefined])
      expect(isPreviewableImage(name)).toBe(false);
  });

  it('内联地址不带 download，下载地址带 download=1', () => {
    expect(fileInlineUrl('p1', 'f1')).toBe('/api/v1/projects/p1/files/f1');
    expect(fileAttachmentUrl('p1', 'f1')).toBe('/api/v1/projects/p1/files/f1?download=1');
  });

  it('按顺序拆分图片附件与其余产出', () => {
    const outputs = [
      out('1', 'file', '图.png'),
      out('2', 'file', '数据.csv'),
      out('3', 'link', 'cover.png'),
      out('4', 'file', 'b.webp'),
    ];
    const { images, others } = splitImageOutputs(outputs);
    expect(images.map((o) => o.id)).toEqual(['1', '4']);
    expect(others.map((o) => o.id)).toEqual(['2', '3']);
  });
});
