import { useReducedMotion } from 'motion/react';
import { createRef, useId, useLayoutEffect, useState, type RefObject } from 'react';

/** 稳定的一组 ref，供 Beams 的 to 使用 */
export function useRefs<T extends HTMLElement>(n: number) {
  const [refs] = useState(() => Array.from({ length: n }, () => createRef<T>()));
  return refs;
}

interface Path {
  d: string;
  key: string;
}

/**
 * 从一个元素向若干元素画弧线光束（尺寸变化时重算）。  * 光束是两层：一层暗的底线，一层沿路径流动的渐变短线。  */
export function Beams({
  container,
  from,
  to,
  curvature = 0.45,
  fromSide = 'right',
  toSide = 'left',
}: {
  container: RefObject<HTMLElement | null>;
  from: RefObject<HTMLElement | null>;
  to: Array<RefObject<HTMLElement | null>>;
  curvature?: number;
  fromSide?: 'right' | 'bottom';
  toSide?: 'left' | 'top';
}) {
  const id = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  const [paths, setPaths] = useState<Path[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const root = container.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const compute = () => {
      const c = root.getBoundingClientRect();
      const f = from.current?.getBoundingClientRect();
      if (!f || c.width === 0) return;
      const sx = fromSide === 'right' ? f.right - c.left : f.left + f.width / 2 - c.left;
      const sy = fromSide === 'right' ? f.top + f.height / 2 - c.top : f.bottom - c.top;
      const next: Path[] = [];
      to.forEach((ref, i) => {
        const t = ref.current?.getBoundingClientRect();
        if (!t) return;
        const ex = toSide === 'left' ? t.left - c.left : t.left + t.width / 2 - c.left;
        const ey = toSide === 'left' ? t.top + t.height / 2 - c.top : t.top - c.top;
        let d: string;
        if (fromSide === 'right') {
          const dx = (ex - sx) * curvature;
          d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
        } else {
          const dy = (ey - sy) * curvature;
          d = `M ${sx} ${sy} C ${sx} ${sy + dy}, ${ex} ${ey - dy}, ${ex} ${ey}`;
        }
        next.push({ d, key: String(i) });
      });
      setBox({ w: c.width, h: c.height });
      setPaths(next);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => ro.disconnect();
  }, [container, from, to, curvature, fromSide, toSide]);

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-visible"
      width={box.w}
      height={box.h}
      viewBox={`0 0 ${box.w || 1} ${box.h || 1}`}
    >
      <defs>
        <linearGradient id={`beam-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4d6bfe" stopOpacity="0" />
          <stop offset="35%" stopColor="#4d6bfe" />
          <stop offset="70%" stopColor="#7d93ff" />
          <stop offset="100%" stopColor="#7d93ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {paths.map((p, i) => (
        <g key={p.key}>
          <path d={p.d} fill="none" stroke="rgb(var(--c-ink) / 0.08)" strokeWidth={1.5} />
          {!reduce && (
            <path
              d={p.d}
              fill="none"
              stroke={`url(#beam-${id})`}
              strokeWidth={2}
              strokeLinecap="round"
              className="beam-path"
              style={{ animationDelay: `${i * 0.55}s` }}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
