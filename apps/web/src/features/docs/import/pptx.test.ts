import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { buildPptx } from '../editors/slides/exportPptx';
import { getDeckMeta, readAllSlides, readDeckInfo } from '../editors/slides/model';
import { pmPlainText } from '../editors/slides/model/richtext';
import { DEFAULT_THEME } from '../editors/slides/model/themes';
import type {
  ImageElement,
  LineElement,
  ShapeElement,
  SlideElement,
  TableElement,
  TextElement,
} from '../editors/slides/model/types';
import { importPptx } from './pptx';

/** 2×2 红色 PNG */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAUYGBgB3dAMDPnJ3nwAAAABJRU5ErkJggg==';

async function sampleDeck(): Promise<File> {
  const { default: Pptx } = await import('pptxgenjs');
  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_WIDE';
  // 1. 标题页
  const s1 = pptx.addSlide();
  s1.background = { color: 'F1F5F9' };
  s1.addText('视觉 Transformer 复现报告', {
    x: 1,
    y: 2,
    w: 11.33,
    h: 1.2,
    fontSize: 40,
    bold: true,
    color: '1F2937',
    align: 'center',
    fontFace: 'Microsoft YaHei',
  });
  s1.addText('张三 · 2026 年 10 月', {
    x: 1,
    y: 3.4,
    w: 11.33,
    h: 0.6,
    fontSize: 20,
    color: '64748B',
    align: 'center',
  });
  s1.addNotes('先讲复现，再讲消融');
  // 2. 要点 + 形状 + 线条 + 图片
  const s2 = pptx.addSlide();
  s2.addText(
    [
      { text: '复现 ViT-B/16，Top-1 81.2%', options: { bullet: true, breakLine: true } },
      {
        text: '消融：patch size',
        options: { bullet: true, bold: true, color: 'C00000', breakLine: true },
      },
      {
        text: '16 优于 32',
        options: { bullet: true, indentLevel: 1, italic: true, underline: { style: 'sng' } },
      },
    ],
    { x: 0.5, y: 1.5, w: 6, h: 3, fontSize: 20, color: '333333' },
  );
  s2.addShape(pptx.ShapeType.roundRect, {
    x: 7,
    y: 1.5,
    w: 3,
    h: 1.5,
    fill: { color: 'FF8800' },
    line: { color: '000000', width: 2 },
    rotate: 15,
  });
  s2.addShape(pptx.ShapeType.line, {
    x: 7,
    y: 4,
    w: 3,
    h: 0,
    line: { color: '2563EB', width: 3, endArrowType: 'triangle' },
  });
  s2.addImage({ data: PNG.replace(/^data:/u, ''), x: 10.5, y: 4.5, w: 2, h: 2 });
  // 3. 表格
  const s3 = pptx.addSlide();
  s3.addTable(
    [
      [
        { text: '模型', options: { bold: true, fill: { color: 'DBEAFE' } } },
        { text: 'Top-1', options: { bold: true, fill: { color: 'DBEAFE' } } },
      ],
      [{ text: 'ViT-B/16' }, { text: '81.2' }],
      [{ text: 'ViT-B/32' }, { text: '78.9' }],
    ],
    {
      x: 1,
      y: 1.5,
      w: 6,
      colW: [3, 3],
      fontSize: 16,
      border: { type: 'solid', pt: 1, color: '999999' },
    },
  );
  const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new File([buf], '组会.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

const byType = <T extends SlideElement>(els: SlideElement[], type: T['type']) =>
  els.filter((e) => e.type === type) as T[];

describe('importPptx', () => {
  it('imports a real pptx generated with pptxgenjs', async () => {
    const file = await sampleDeck();
    const ydoc = new Y.Doc();
    const uploadFile = vi.fn(async (_blob: Blob, name: string) => ({
      id: 'f1',
      url: `/api/v1/projects/p/files/f1?n=${name}`,
    }));
    const res = await importPptx(file, ydoc, { projectId: 'p', uploadFile });
    expect(res.title).toBe('视觉 Transformer 复现报告');

    const deck = readDeckInfo(getDeckMeta(ydoc));
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
    const slides = readAllSlides(ydoc, deck);
    expect(slides).toHaveLength(3);

    // 标题页：位置（英寸 × 72）、格式、背景、备注
    const s1 = slides[0]!;
    expect(s1.bg).toEqual({ type: 'color', color: '#F1F5F9' });
    expect(s1.notes).toBe('先讲复现，再讲消融');
    const texts1 = byType<TextElement>(s1.elements, 'text');
    const title = texts1.find((t) => pmPlainText(t.doc).includes('视觉'))!;
    expect(title.x).toBeCloseTo(72, 0);
    expect(title.y).toBeCloseTo(144, 0);
    expect(title.w).toBeCloseTo(815.8, 0);
    const p = title.doc.content![0]!;
    expect(p.attrs?.textAlign).toBe('center');
    const run = p.content![0]!;
    expect(run.marks?.some((m) => m.type === 'bold')).toBe(true);
    expect(run.marks?.find((m) => m.type === 'textStyle')?.attrs).toMatchObject({
      color: '#1F2937',
      fontSize: '40pt',
      fontFamily: 'Microsoft YaHei',
    });

    // 要点：项目符号、嵌套、行内格式
    const s2 = slides[1]!;
    const body = byType<TextElement>(s2.elements, 'text')[0]!;
    expect(body.doc.content![0]!.type).toBe('bulletList');
    expect(pmPlainText(body.doc)).toContain('16 优于 32');
    const json = JSON.stringify(body.doc);
    expect(json).toContain('"italic"');
    expect(json).toContain('"underline"');
    expect(json).toContain('#C00000');

    // 形状：预设名、填充、边框、旋转
    const shape = byType<ShapeElement>(s2.elements, 'shape')[0]!;
    expect(shape.shape).toBe('roundRect');
    expect(shape.fill).toEqual({ type: 'color', color: '#FF8800' });
    expect(shape.stroke?.color).toBe('#000000');
    expect(shape.rot).toBe(15);
    // 线条 + 箭头
    const line = byType<LineElement>(s2.elements, 'line')[0]!;
    expect(line.end).toBe('triangle');
    expect(line.stroke.color).toBe('#2563EB');
    // 图片：上传后按 url 引用
    const img = byType<ImageElement>(s2.elements, 'image')[0]!;
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(img.src).toMatch(/^\/api\/v1\/projects\/p\/files\/f1/u);
    expect(img.fileId).toBe('f1');
    expect(img.w).toBeCloseTo(144, 0);

    // 表格
    const table = byType<TableElement>(slides[2]!.elements, 'table')[0]!;
    expect(table.cells.map((r) => r.map((c) => c.text))).toEqual([
      ['模型', 'Top-1'],
      ['ViT-B/16', '81.2'],
      ['ViT-B/32', '78.9'],
    ]);
    expect(table.cells[0]![0]!.fill).toBe('#DBEAFE');
    expect(table.cells[0]![0]!.bold).toBe(true);
    expect(table.cells[1]![0]!.bold).toBe(false);
    expect(table.colW[0]).toBeCloseTo(216, 0);
  }, 30000);

  it('rejects files that are not pptx', async () => {
    const bad = new File([new Uint8Array([1, 2, 3])], 'x.pptx');
    await expect(importPptx(bad, new Y.Doc())).rejects.toThrow(/\.pptx/u);
  });

  it('round-trips: imported deck → export pptx → import again', async () => {
    const ydoc = new Y.Doc();
    await importPptx(await sampleDeck(), ydoc);
    const deck = readDeckInfo(getDeckMeta(ydoc));
    const slides = readAllSlides(ydoc, deck);
    const pptx = await buildPptx(slides, deck, { title: '组会', loadImage: async (s) => s });
    const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
    const again = new Y.Doc();
    await importPptx(new File([buf], 'out.pptx'), again);
    const deck2 = readDeckInfo(getDeckMeta(again));
    expect(deck2.width).toBe(960);
    const s2 = readAllSlides(again, deck2);
    expect(s2).toHaveLength(3);
    expect(s2[0]!.notes).toBe('先讲复现，再讲消融');
    expect(s2[0]!.bg).toEqual({ type: 'color', color: '#F1F5F9' });
    expect(s2[0]!.title).toBe('视觉 Transformer 复现报告');
    const title = byType<TextElement>(s2[0]!.elements, 'text')[0]!;
    expect(title.x).toBeCloseTo(72, 0);
    const shape = byType<ShapeElement>(s2[1]!.elements, 'shape')[0]!;
    expect(shape.shape).toBe('roundRect');
    expect(shape.rot).toBe(15);
    expect(byType<LineElement>(s2[1]!.elements, 'line')[0]!.end).toBe('triangle');
    expect(byType<ImageElement>(s2[1]!.elements, 'image')).toHaveLength(1);
    const body = byType<TextElement>(s2[1]!.elements, 'text')[0]!;
    expect(body.doc.content![0]!.type).toBe('bulletList');
    expect(JSON.stringify(body.doc)).toContain('#C00000');
    const table = byType<TableElement>(s2[2]!.elements, 'table')[0]!;
    expect(table.cells[2]![1]!.text).toBe('78.9');
  }, 30000);

  it('exports theme-styled placeholders with resolved colors', async () => {
    const { insertSlides } = await import('../editors/slides/model');
    const ydoc = new Y.Doc();
    insertSlides(
      ydoc,
      0,
      [{ layout: 'content', content: { title: '标题', body: '- 一\n- 二' }, notes: '备注' }],
      null,
    );
    const deck = { width: 960, height: 540, theme: DEFAULT_THEME };
    const pptx = await buildPptx(readAllSlides(ydoc, deck), deck);
    const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
    const again = new Y.Doc();
    await importPptx(new File([buf], 'x.pptx'), again);
    const s = readAllSlides(again, readDeckInfo(getDeckMeta(again)))[0]!;
    expect(s.notes).toBe('备注');
    const texts = byType<TextElement>(s.elements, 'text');
    expect(texts.map((t) => pmPlainText(t.doc))).toEqual(['标题', '一\n二']);
    expect(JSON.stringify(texts[0]!.doc)).toContain(DEFAULT_THEME.fg.toUpperCase());
  }, 30000);
});
