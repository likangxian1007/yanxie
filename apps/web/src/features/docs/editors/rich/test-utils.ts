import { vi } from 'vitest';

/** jsdom 缺的几个布局 API（ProseMirror 选区同步 / 滚动会用到）。只在测试里用。 */
export function mockLayoutApis() {
  const rect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  const rects = () => {
    const list = [] as unknown as DOMRectList;
    Object.assign(list, { item: () => null });
    return list;
  };
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = rects;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = rect as () => DOMRect;
  }
  if (!document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(performance.now()), 0),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  }
}
