import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export const EASE = [0.16, 1, 0.3, 1] as const;

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

/** 逐字出现的标题。segments 里每段可以带自己的样式（如渐变字）。 */
export interface HeadlineSegment {
  text: string;
  gradient?: boolean;
  br?: boolean;
}

export function SplitHeadline({
  segments,
  className,
  delay = 0,
  stagger = 0.02,
  as = 'h1',
}: {
  segments: HeadlineSegment[];
  className?: string;
  delay?: number;
  stagger?: number;
  as?: 'h1' | 'h2';
}) {
  const reduce = useReducedMotion();
  const Tag = as === 'h1' ? motion.h1 : motion.h2;
  let index = 0;
  const label = segments.map((s) => s.text).join('');
  return (
    <Tag
      className={className}
      aria-label={label}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.15 }}
    >
      {segments.map((seg, si) => {
        let ci = -1;
        // 英文/数字连成一组不断行（逐字 inline-block 之间处处可断，否则会出现 “A / I” 拆行）
        const tokens = seg.text.match(/[A-Za-z0-9]+|[\s\S]/gu) ?? [];
        const renderChar = (ch: string) => {
          ci++;
          const i = index++;
          // 逐字动画的字一律实色，不用 background-clip:text（微信/X5 会画成整块白底）；重点词用强调色。
          return (
            <motion.span
              key={ci}
              className={cx('split-char inline-block', seg.gradient && 'split-accent')}
              variants={{
                hidden: reduce ? { opacity: 0 } : { opacity: 0, y: '0.42em' },
                show: {
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.5, ease: EASE, delay: delay + i * stagger },
                },
              }}
            >
              {ch === ' ' ? '\u00A0' : ch}
            </motion.span>
          );
        };
        const words = (
          <span key={si} aria-hidden className="inline">
            {tokens.map((tok, ti) =>
              tok.length > 1 ? (
                <span key={`w${ti}`} className="inline-block whitespace-nowrap">
                  {Array.from(tok).map((c) => renderChar(c))}
                </span>
              ) : (
                renderChar(tok)
              ),
            )}
          </span>
        );
        return seg.br ? [<br key={`br${si}`} />, words] : words;
      })}
    </Tag>
  );
}

export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
  ...rest
}: { children: ReactNode; delay?: number; y?: number; className?: string } & Omit<
  HTMLMotionProps<'div'>,
  'children'
>) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15, margin: '0px 0px -10% 0px' }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** 卡片容器（静态，无指针跟随效果） */
export function SpotCard({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cx('overflow-hidden rounded-3xl border border-line bg-surface', className)}
    >
      {children}
    </div>
  );
}

export function Marquee({
  children,
  duration = 40,
  reverse = false,
  className,
}: {
  children: ReactNode;
  duration?: number;
  reverse?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('group mask-fade-x flex overflow-hidden', className)}>
      <div
        className="flex w-max shrink-0 animate-marquee gap-3 pr-3 group-hover:[animation-play-state:paused]"
        style={
          {
            '--marquee-duration': `${duration}s`,
            animationDirection: reverse ? 'reverse' : 'normal',
          } as CSSProperties
        }
      >
        {children}
        <div aria-hidden className="flex gap-3">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium tracking-wide text-muted',
        className,
      )}
    >
      <span className="relative flex size-1.5">
        <span className="relative size-1.5 rounded-full bg-agent" />
      </span>
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  desc,
  center = true,
}: {
  eyebrow: string;
  title: HeadlineSegment[];
  desc?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={cx('flex flex-col gap-5', center && 'items-center text-center')}>
      <Reveal>
        <Eyebrow>{eyebrow}</Eyebrow>
      </Reveal>
      <SplitHeadline
        as="h2"
        segments={title}
        stagger={0.015}
        className="text-silver text-[32px] leading-[1.12] font-semibold tracking-[-0.03em] sm:text-5xl lg:text-[56px]"
      />
      {desc ? (
        <Reveal delay={0.15}>
          <p
            className={cx(
              'max-w-2xl text-[15px] leading-7 text-muted sm:text-[17px]',
              center && 'mx-auto',
            )}
          >
            {desc}
          </p>
        </Reveal>
      ) : null}
    </div>
  );
}

let lastScrollAt = 0;
let scrollListening = false;
function isScrolling() {
  if (!scrollListening) {
    scrollListening = true;
    window.addEventListener(
      'scroll',
      () => {
        lastScrollAt = performance.now();
      },
      { passive: true },
    );
  }
  return performance.now() - lastScrollAt < 250;
}

/** 每 interval 毫秒推进一次的步进器；减少动态时停在 still 帧 */
export function useTicker(count: number, interval: number, still = count - 1) {
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => {
      // 滚动中/后台时不推进：页面上同时有十几个演示动画，滚动时让出主线程，手机上才跟手
      if (document.hidden || isScrolling()) return;
      setTick((t) => (t + 1) % count);
    }, interval);
    return () => window.clearInterval(id);
  }, [count, interval, reduce]);
  return reduce ? still : tick;
}

export function Avatar({
  name,
  tone = 'accent',
  size = 'md',
}: {
  name: string;
  tone?: 'accent' | 'agent' | 'success' | 'warning' | 'sky';
  size?: 'sm' | 'md';
}) {
  const tones = {
    accent: 'bg-accent/20 text-agent ring-accent/40',
    agent: 'bg-agent-gradient text-white ring-agent/50',
    success: 'bg-success/15 text-success ring-success/40',
    warning: 'bg-warning/15 text-warning ring-warning/40',
    sky: 'bg-sky/15 text-sky ring-sky/40',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1',
        size === 'sm' ? 'size-5 text-[10px]' : 'size-7 text-xs',
        tones[tone],
      )}
    >
      {name}
    </span>
  );
}
