import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeRegion, PdfRenderError, renderPdfPage } from '../src/agents/vision/pdf-render';

/** 矢量 PDF（matplotlib 导出的折线图，没有内嵌位图）渲染成 PNG */
const pdf = readFileSync(fileURLToPath(new URL('./fixtures/vector-plot.pdf', import.meta.url)));
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe('normalizeRegion', () => {
  it('按左上/右下角解释，夹到 0~1 并排序，整页返回 null', () => {
    expect(normalizeRegion(null)).toBeNull();
    expect(normalizeRegion([0, 0, 1, 1])).toBeNull();
    expect(normalizeRegion([-0.5, -1, 2, 3])).toBeNull();
    expect(normalizeRegion([0.6, 0.5, 0.1, 0.2])).toEqual([0.1, 0.2, 0.6, 0.5]);
  });

  it('区域过小或格式不对时报可读错误', () => {
    expect(() => normalizeRegion([0.2, 0.2, 0.21, 0.6])).toThrow(PdfRenderError);
    expect(() => normalizeRegion([0.1, 0.2, 0.3])).toThrow(PdfRenderError);
    expect(() => normalizeRegion([0.1, Number.NaN, 0.3, 0.4])).toThrow(PdfRenderError);
  });
});

describe('renderPdfPage', () => {
  it('整页渲染出 PNG，且不破坏调用方的 buffer', async () => {
    const input = new Uint8Array(pdf);
    const r = await renderPdfPage(input, 1);
    expect([...r.png.subarray(0, 4)]).toEqual(PNG_MAGIC);
    expect(r.pages).toBe(1);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2400);
    expect(r.region).toBeNull();
    // 再渲染一次：如果 pdf.js detach 了传入的 buffer，这里会失败
    const again = await renderPdfPage(new Uint8Array(pdf), 1);
    expect(again.width).toBe(r.width);
  });

  it('区域渲染按比例裁剪，分辨率比整页同区域更高', async () => {
    const full = await renderPdfPage(new Uint8Array(pdf), 1);
    const part = await renderPdfPage(new Uint8Array(pdf), 1, [0.1, 0.1, 0.4, 0.4]);
    expect(part.region).not.toBeNull();
    // 区域是 0.3×0.3 的方块，宽高比与整页一致
    expect(part.width / part.height).toBeCloseTo(full.width / full.height, 1);
    // 同一块内容在整页里只有 full.width*0.3 像素宽，区域渲染要明显更清晰
    expect(part.width).toBeGreaterThan(full.width * 0.3 * 2);
  });

  it('页码越界给出可读错误', async () => {
    await expect(renderPdfPage(new Uint8Array(pdf), 9)).rejects.toBeInstanceOf(PdfRenderError);
  });
});
