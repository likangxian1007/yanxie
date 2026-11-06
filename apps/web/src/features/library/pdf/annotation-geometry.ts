export interface AnnotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 同一行的相交矩形只绘制一次。只改变显示，不改已保存的坐标或标注记录。 */
export function mergeAnnotationRects(rects: AnnotationRect[]): AnnotationRect[] {
  const rows: AnnotationRect[] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;
    let merged = { ...rect };
    for (let i = 0; i < rows.length;) {
      const row = rows[i]!;
      const overlapY =
        Math.min(row.top + row.height, merged.top + merged.height) - Math.max(row.top, merged.top);
      const minHeight = Math.min(row.height, merged.height);
      const centers = Math.abs(row.top + row.height / 2 - merged.top - merged.height / 2);
      const sameLine = overlapY >= minHeight * 0.8 && centers <= minHeight * 0.25;
      const touches =
        row.left <= merged.left + merged.width + 0.25 && merged.left <= row.left + row.width + 0.25;
      if (!sameLine || !touches) {
        i++;
        continue;
      }
      const left = Math.min(row.left, merged.left),
        top = Math.min(row.top, merged.top);
      merged = {
        left,
        top,
        width: Math.max(row.left + row.width, merged.left + merged.width) - left,
        height: Math.max(row.top + row.height, merged.top + merged.height) - top,
      };
      rows.splice(i, 1);
      i = 0;
    }
    rows.push(merged);
  }
  return rows.sort((a, b) => a.top - b.top || a.left - b.left);
}

export const rectPath = (rects: AnnotationRect[]) =>
  rects.map((r) => `M${r.left} ${r.top}h${r.width}v${r.height}h${-r.width}Z`).join(' ');

export const underlinePath = (rects: AnnotationRect[]) =>
  rects.map((r) => `M${r.left} ${r.top + r.height}h${r.width}`).join(' ');
