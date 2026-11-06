import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { animate } from 'motion/react';
import { useMotionPreset } from '@/lib/motion';
import type { Rect } from './geometry';

export interface SpotlightProps {
  /** 高亮框；null 时收拢成一点（居中卡片的步骤） */
  hole: Rect | null;
  /** true：从上一个位置弹簧过去；false：直接跟上（窗口缩放、滚动） */
  animateMove: boolean;
}

const RADIUS = 10;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function collapsed(from: Rect | null, viewport: { w: number; h: number }): Rect {
  const cx = from ? from.x + from.w / 2 : viewport.w / 2;
  const cy = from ? from.y + from.h / 2 : viewport.h / 2;
  return { x: cx, y: cy, w: 0, h: 0 };
}

/**
 * 压暗整页并挖出目标：一张全屏 SVG，遮罩里的圆角矩形就是“洞”，外面再描一圈 accent 柔光。
 * 洞在步骤之间用 spring.gentle 移动（只改 SVG 几何属性，不触发页面重排）；减少动态效果时直接跳。
 */
export function Spotlight({ hole, animateMove }: SpotlightProps) {
  const rawId = useId();
  const maskId = `tour-mask-${rawId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const holeRef = useRef<SVGRectElement>(null);
  const ringRef = useRef<SVGRectElement>(null);
  const glowRef = useRef<SVGRectElement>(null);
  const shown = useRef<Rect | null>(null);
  const { reduced, spring } = useMotionPreset();

  const apply = (r: Rect, ringOpacity: number) => {
    shown.current = r;
    const rx = Math.min(RADIUS, r.w / 2, r.h / 2);
    for (const el of [holeRef.current, ringRef.current, glowRef.current]) {
      if (!el) continue;
      el.setAttribute('x', String(r.x));
      el.setAttribute('y', String(r.y));
      el.setAttribute('width', String(Math.max(0, r.w)));
      el.setAttribute('height', String(Math.max(0, r.h)));
      el.setAttribute('rx', String(Math.max(0, rx)));
    }
    if (ringRef.current) ringRef.current.style.opacity = String(ringOpacity);
    if (glowRef.current) glowRef.current.style.opacity = String(ringOpacity);
  };

  // 首次挂载：直接放到位，不从角落飞过来
  useLayoutEffect(() => {
    if (shown.current) return;
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    apply(hole ?? collapsed(null, viewport), hole ? 1 : 0);
    // 只在挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const from = shown.current ?? collapsed(hole, viewport);
    const to = hole ?? collapsed(from.w > 0 ? from : null, viewport);
    const fromOpacity = Number(ringRef.current?.style.opacity || 0);
    const toOpacity = hole ? 1 : 0;
    if (!animateMove || reduced) {
      apply(to, toOpacity);
      return;
    }
    const controls = animate(0, 1, {
      ...spring.gentle,
      onUpdate: (t) => {
        const k = Math.max(0, t);
        apply(
          {
            x: lerp(from.x, to.x, k),
            y: lerp(from.y, to.y, k),
            w: lerp(from.w, to.w, k),
            h: lerp(from.h, to.h, k),
          },
          lerp(fromOpacity, toOpacity, Math.min(1, k)),
        );
      },
    });
    return () => controls.stop();
    // apply 只读 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hole?.x, hole?.y, hole?.w, hole?.h, hole === null, animateMove, reduced, spring.gentle]);

  return (
    <svg aria-hidden className="pointer-events-auto fixed inset-0 size-full" focusable="false">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="100%" height="100%" style={{ fill: 'white' }} />
          <rect ref={holeRef} style={{ fill: 'black' }} />
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        mask={`url(#${maskId})`}
        style={{ fill: 'var(--overlay)' }}
      />
      <rect
        ref={glowRef}
        style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 8, strokeOpacity: 0.16 }}
      />
      <rect
        ref={ringRef}
        style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.5, strokeOpacity: 0.9 }}
      />
    </svg>
  );
}
