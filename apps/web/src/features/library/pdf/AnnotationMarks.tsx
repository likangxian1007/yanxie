import type { AnnotationColor } from '@srh/shared';
import {
  mergeAnnotationRects,
  rectPath,
  underlinePath,
  type AnnotationRect,
} from './annotation-geometry';

interface Mark {
  key: string;
  tone: 'highlight' | 'comment';
  color?: AnnotationColor;
  active?: boolean;
  rect: AnnotationRect;
}

/** 整组高亮统一透明度，重叠位置不累积变深；批注单独绘制细下划线。 */
export function AnnotationMarks({ marks }: { marks: Mark[] }) {
  const groups = new Map<string, Omit<Mark, 'rect'> & { rects: AnnotationRect[] }>();
  for (const { rect, ...mark } of marks) {
    const group = groups.get(mark.key);
    if (group) group.rects.push(rect);
    else groups.set(mark.key, { ...mark, rects: [rect] });
  }
  const rows = [...groups.values()]
    .map((mark) => ({ ...mark, rects: mergeAnnotationRects(mark.rects) }))
    .sort((a, b) => Number(Boolean(a.active)) - Number(Boolean(b.active)));
  return (
    <svg
      aria-hidden
      className="lib-annotation-layer pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      <g className="lib-annotation-fills">
        {rows
          .filter((mark) => mark.tone === 'highlight')
          .map((mark) => (
            <path
              key={mark.key}
              data-annotation-mark={mark.key}
              data-color={mark.color ?? 'yellow'}
              className="lib-annotation-mark lib-annotation-highlight"
              d={rectPath(mark.rects)}
            />
          ))}
      </g>
      <g>
        {rows
          .filter((mark) => mark.tone === 'comment')
          .map((mark) => (
            <path
              key={mark.key}
              data-annotation-mark={mark.key}
              data-color={mark.color ?? 'yellow'}
              className="lib-annotation-mark lib-annotation-comment"
              d={underlinePath(mark.rects)}
            />
          ))}
      </g>
      {rows
        .filter((mark) => mark.active)
        .map((mark) => (
          <path
            key={mark.key}
            data-annotation-active={mark.key}
            data-color={mark.color ?? 'yellow'}
            className="lib-annotation-mark lib-annotation-active"
            d={mark.tone === 'comment' ? underlinePath(mark.rects) : rectPath(mark.rects)}
          />
        ))}
    </svg>
  );
}
