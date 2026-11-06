import { describe, expect, it } from 'vitest';
import { columnWarning, projectSelectionBox, selectionBoxes } from './selection';

describe('PDF 选区还原原始坐标', () => {
  it.each([0, 90, 180, 270])('保存位置在旋转 %s 度、裁切和缩放后仍与文字重合', (rotation) => {
    const w = 500,
      h = 700;
    for (const scale of [0.5, 1, 2]) {
      const forward = (x: number, y: number) => {
        const u = x - 10,
          v = 720 - y;
        const [a, b] =
          rotation === 0
            ? [u, v]
            : rotation === 90
              ? [h - v, u]
              : rotation === 180
                ? [w - u, h - v]
                : [v, w - u];
        return [a! * scale, b! * scale];
      };
      const inverse = (x: number, y: number) => {
        x /= scale;
        y /= scale;
        const [u, v] =
          rotation === 0
            ? [x, y]
            : rotation === 90
              ? [y, h - x]
              : rotation === 180
                ? [w - x, h - y]
                : [w - y, x];
        return [10 + u!, 720 - v!];
      };
      const vp = {
        viewBox: [10, 20, 510, 720],
        width: (rotation % 180 ? h : w) * scale,
        height: (rotation % 180 ? w : h) * scale,
        convertToPdfPoint: inverse,
        convertToViewportPoint: forward,
      };
      const original = { page: 1, x: 72, y: 60, w: 100, h: 14 };
      const projected = projectSelectionBox(original, vp);
      const saved = selectionBoxes(
        [
          {
            left: 30 + projected.left,
            top: 40 + projected.top,
            right: 30 + projected.left + projected.width,
            bottom: 40 + projected.top + projected.height,
          },
        ],
        { left: 30, top: 40, right: 30 + vp.width, bottom: 40 + vp.height },
        vp,
        1,
      );
      expect(saved).toEqual([original]);
    }
  });
  const viewport = {
    width: 612,
    height: 792,
    viewBox: [0, 0, 612, 792],
    convertToPdfPoint: (x: number, y: number) => [x, 792 - y],
  };
  it.each([0.5, 1, 1.5, 2])('在 %s 倍显示下保存相同坐标，去掉重叠矩形', (scale) => {
    const bounds = { left: 30, top: 80, right: 30 + 612 * scale, bottom: 80 + 792 * scale };
    const rect = {
      left: 30 + 72 * scale,
      top: 80 + 60 * scale,
      right: 30 + 180 * scale,
      bottom: 80 + 74 * scale,
    };
    expect(selectionBoxes([rect, rect], bounds, viewport, 2)).toEqual([
      { page: 2, x: 72, y: 60, w: 108, h: 14 },
    ]);
  });
  it('90 度旋转后仍还原到原始 PDF，包含非零裁切原点', () => {
    const rotated = {
      width: 700,
      height: 500,
      viewBox: [10, 20, 510, 720],
      convertToPdfPoint: (x: number, y: number) => [10 + y, 20 + x],
    };
    expect(
      selectionBoxes(
        [{ left: 600, top: 50, right: 620, bottom: 150 }],
        { left: 0, top: 0, right: 700, bottom: 500 },
        rotated,
        1,
      ),
    ).toEqual([{ page: 1, x: 50, y: 80, w: 100, h: 20 }]);
  });
  it('过滤页面外与无尺寸矩形，不产生无效选区', () => {
    expect(
      selectionBoxes(
        [{ left: -30, top: 0, right: -1, bottom: 10 }],
        { left: 0, top: 0, right: 612, bottom: 792 },
        viewport,
        1,
      ),
    ).toEqual([]);
  });
  it('多行保持各行位置，跨栏明显间距提示核对', () => {
    const rects = [
      { left: 70, top: 60, right: 150, bottom: 74 },
      { left: 350, top: 60, right: 470, bottom: 74 },
    ];
    expect(columnWarning(rects, 612)).toContain('跨越两栏');
    expect(
      columnWarning([{ ...rects[0]! }, { ...rects[0]!, top: 90, bottom: 104 }], 612),
    ).toBeNull();
  });
});
