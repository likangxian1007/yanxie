import { useEffect, useRef } from 'react';

/**
 * 首屏科研风动态背景：缓慢漂移的“文献引用网络”，偶尔有一条连线被 Agent 点亮（蓝色光点沿边移动，节点脉冲）。
 * 性能约束：单个 2D canvas；DPR 桌面 ≤2、手机 ≤1.5；手机 30fps；离屏 / 标签页隐藏时停帧；
 * prefers-reduced-motion 只画一帧静态图；首帧绘制后空闲时再初始化，不影响 LCP；ResizeObserver 防抖。
 */

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  pulse: number; // 0..1，被点亮后衰减
}

interface Link {
  a: number;
  b: number;
  t: number; // 0..1 光点进度
}

type RGB = [number, number, number];

function readColors(): { ink: RGB; glow: RGB; dark: boolean } {
  const cs = getComputedStyle(document.documentElement);
  const parse = (v: string, fb: RGB): RGB => {
    const n = v.trim().split(/\s+/).map(Number);
    return n.length === 3 && n.every((x) => Number.isFinite(x)) ? (n as RGB) : fb;
  };
  return {
    ink: parse(cs.getPropertyValue('--c-ink'), [255, 255, 255]),
    glow: parse(cs.getPropertyValue('--c-glow'), [77, 107, 254]),
    dark: document.documentElement.dataset.theme !== 'light',
  };
}

type BackdropProps = {
  className?: string;
  /** 文字区中心的纵向位置（0–1，相对画布高度），该处背景淡化保证可读 */
  focusY?: number;
  /** 文字区淡化椭圆的纵向半径（0–1） */
  focusH?: number;
  /** 边缘淡出：仅底部，或上下都淡出（夹在两段内容之间时用） */
  edges?: 'bottom' | 'both';
  /** 调试统计挂到 window 上的键名 */
  statsKey?: string;
};

export function ResearchBackdrop({
  className,
  focusY = 0.3,
  focusH = 0.2,
  edges = 'bottom',
  statsKey = '__bgStats',
}: BackdropProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (
      !canvas ||
      typeof ResizeObserver === 'undefined' ||
      typeof IntersectionObserver === 'undefined' ||
      /jsdom/i.test(navigator.userAgent)
    )
      return;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;
    const g = ctx;

    const mobile = window.matchMedia?.('(max-width: 768px)').matches ?? false;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const dprCap = mobile ? 1.5 : 2;
    const frameGap = mobile ? 1000 / 30 - 2 : 0; // 手机限 30fps
    const LINK_DIST = mobile ? 120 : 160;

    let W = 0;
    let H = 0;
    let nodes: Node[] = [];
    let links: Link[] = [];
    let colors = readColors();
    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let nextLink = 0;
    let visible = true;
    let started = false;
    let disposed = false;
    const stats = { frames: 0, ms: 0 };
    (window as unknown as Record<string, typeof stats>)[statsKey] = stats;

    const seed = () => {
      const count = mobile ? 22 : Math.round(Math.min(56, Math.max(40, (W * H) / 26000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 22, // px/s，缓慢但可察觉
        vy: (Math.random() - 0.5) * 22,
        r: Math.random() < 0.18 ? 2.2 : 1.3,
        pulse: 0,
      }));
      links = [];
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const nw = Math.max(1, Math.round(rect.width));
      const nh = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(nw * dpr);
      canvas.height = Math.round(nh * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const reseed = !nodes.length || Math.abs(nw - W) > 40 || Math.abs(nh - H) > 80;
      W = nw;
      H = nh;
      if (reseed) seed();
    };

    // 标题区域（上方居中）淡化，保证文字对比度
    const fade = (x: number, y: number) => {
      const dx = (x - W / 2) / (W * (mobile ? 0.55 : 0.34));
      const dy = (y - H * focusY) / (H * focusH);
      const d = dx * dx + dy * dy;
      const center = d < 1 ? 0.4 + 0.6 * d : 1;
      const bottom = y > H * 0.7 ? Math.max(0, 1 - (y - H * 0.7) / (H * 0.3)) : 1;
      const top = edges === 'both' && y < H * 0.25 ? Math.max(0, y / (H * 0.25)) : 1;
      return center * bottom * top;
    };

    const draw = () => {
      const [ir, ig, ib] = colors.ink;
      const [gr, gg, gb] = colors.glow;
      const lineA = colors.dark ? 0.2 : 0.22;
      const dotA = colors.dark ? 0.55 : 0.5;
      g.clearRect(0, 0, W, H);
      g.lineWidth = 1;

      // 连线：按透明度分 3 档批量描边，减少 stroke 调用
      const buckets: number[][] = [[], [], []];
      const n = nodes.length;
      const L2 = LINK_DIST * LINK_DIST;
      for (let i = 0; i < n; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > L2) continue;
          const k = (1 - d2 / L2) * fade((a.x + b.x) / 2, (a.y + b.y) / 2);
          const bi = k > 0.6 ? 2 : k > 0.3 ? 1 : k > 0.08 ? 0 : -1;
          if (bi >= 0) buckets[bi]!.push(a.x, a.y, b.x, b.y);
        }
      }
      buckets.forEach((seg, bi) => {
        if (!seg.length) return;
        g.strokeStyle = `rgba(${ir},${ig},${ib},${lineA * (0.35 + bi * 0.32)})`;
        g.beginPath();
        for (let s = 0; s < seg.length; s += 4) {
          g.moveTo(seg[s]!, seg[s + 1]!);
          g.lineTo(seg[s + 2]!, seg[s + 3]!);
        }
        g.stroke();
      });

      // 节点
      g.fillStyle = `rgba(${ir},${ig},${ib},${dotA})`;
      g.beginPath();
      for (const p of nodes) {
        const f = fade(p.x, p.y);
        if (f < 0.3 || p.pulse > 0.05) continue;
        g.moveTo(p.x + p.r, p.y);
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      }
      g.fill();
      for (const p of nodes) {
        const f = fade(p.x, p.y);
        if (f >= 0.3 && p.pulse <= 0.05) continue;
        g.globalAlpha = Math.max(f, p.pulse);
        g.fillStyle = p.pulse > 0.05 ? `rgb(${gr},${gg},${gb})` : `rgba(${ir},${ig},${ib},${dotA})`;
        g.beginPath();
        g.arc(p.x, p.y, p.r + p.pulse * 1.2, 0, Math.PI * 2);
        g.fill();
        if (p.pulse > 0.05) {
          g.strokeStyle = `rgba(${gr},${gg},${gb},${0.45 * p.pulse})`;
          g.beginPath();
          g.arc(p.x, p.y, p.r + 3 + (1 - p.pulse) * 10, 0, Math.PI * 2);
          g.stroke();
        }
      }
      g.globalAlpha = 1;

      // 被点亮的引用边 + 沿边移动的光点
      for (const l of links) {
        const a = nodes[l.a]!;
        const b = nodes[l.b]!;
        const f = Math.max(0.35, fade((a.x + b.x) / 2, (a.y + b.y) / 2));
        g.strokeStyle = `rgba(${gr},${gg},${gb},${0.5 * f * Math.min(1, (1 - l.t) * 3)})`;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(
          a.x + (b.x - a.x) * Math.min(1, l.t * 1.4),
          a.y + (b.y - a.y) * Math.min(1, l.t * 1.4),
        );
        g.stroke();
        const px = a.x + (b.x - a.x) * Math.min(1, l.t * 1.4);
        const py = a.y + (b.y - a.y) * Math.min(1, l.t * 1.4);
        g.fillStyle = `rgba(${gr},${gg},${gb},${0.9 * f})`;
        g.beginPath();
        g.arc(px, py, 1.8, 0, Math.PI * 2);
        g.fill();
      }
    };

    const step = (dt: number, now: number) => {
      for (const p of nodes) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -20) p.x = W + 20;
        else if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20;
        else if (p.y > H + 20) p.y = -20;
        if (p.pulse > 0) p.pulse = Math.max(0, p.pulse - dt * 0.6);
      }
      for (const l of links) {
        const before = l.t;
        l.t += dt * 0.55;
        if (before < 0.72 && l.t >= 0.72) nodes[l.b]!.pulse = 1;
      }
      links = links.filter((l) => l.t < 1);
      if (now > nextLink && links.length < (mobile ? 2 : 4)) {
        nextLink = now + 700 + Math.random() * 1100;
        const a = Math.floor(Math.random() * nodes.length);
        const src = nodes[a]!;
        let best = -1;
        let bestD = Infinity;
        nodes.forEach((p, i) => {
          if (i === a) return;
          const d = (p.x - src.x) ** 2 + (p.y - src.y) ** 2;
          if (d < LINK_DIST * LINK_DIST && d > 900 && d < bestD && Math.random() > 0.3) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0 && fade(src.x, src.y) > 0.4) {
          src.pulse = 1;
          links.push({ a, b: best, t: 0 });
        }
      }
    };

    const loop = (now: number) => {
      raf = 0;
      if (disposed || !visible || document.hidden) return;
      raf = requestAnimationFrame(loop);
      if (frameGap && now - lastDraw < frameGap) return;
      const t0 = performance.now();
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      lastDraw = now;
      step(dt, now);
      draw();
      stats.frames++;
      stats.ms += performance.now() - t0;
    };

    const kick = () => {
      if (!raf && started && !reduce && visible && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    };

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!started) return;
        resize();
        draw();
      }, 150);
    });
    const io = new IntersectionObserver(
      ([e]) => {
        visible = !!e?.isIntersecting;
        kick();
      },
      { rootMargin: '100px' },
    );
    const mo = new MutationObserver(() => {
      colors = readColors();
      if (started) draw();
    });
    const onVis = () => kick();

    const start = () => {
      if (disposed) return;
      started = true;
      resize();
      draw();
      canvas.style.opacity = '1';
      ro.observe(canvas);
      io.observe(canvas);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      document.addEventListener('visibilitychange', onVis);
      kick();
    };

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const hasIdle = typeof w.requestIdleCallback === 'function';
    const idle = hasIdle
      ? w.requestIdleCallback!(start, { timeout: 1500 })
      : window.setTimeout(start, 400);

    return () => {
      disposed = true;
      if (hasIdle) w.cancelIdleCallback?.(idle);
      else window.clearTimeout(idle);
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [focusY, focusH, edges, statsKey]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className}
      style={{ opacity: 0, transition: 'opacity 1.2s ease' }}
    />
  );
}
