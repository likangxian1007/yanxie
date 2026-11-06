/** 浮层锚点（视口坐标）。 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 安全地取编辑器某个位置的视口坐标（jsdom 等环境下可能抛错）。 */
export function coordsAt(
  view: { coordsAtPos: (pos: number) => AnchorRect },
  pos: number,
): AnchorRect {
  try {
    const c = view.coordsAtPos(pos);
    return { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
  } catch {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
}
