import { useMemo } from 'react';
import { useReducedMotion, type Transition, type Variant, type Variants } from 'motion/react';

/**
 * 动效预设（STYLE.md §4）。组件里不要手写时长、曲线和弹簧参数，一律从这里取。
 * 需要尊重“减少动态效果”时用 `useMotionPreset()`，它会把位移/缩放换成纯淡入淡出。
 */

/** 时长（秒），与 tokens.css 的 --dur-* 一致。 */
export const duration = {
  instant: 0.08,
  fast: 0.14,
  base: 0.2,
  slow: 0.32,
  slower: 0.48,
} as const;

/** 曲线，与 tokens.css 的 --ease-* 一致。 */
export const ease = {
  standard: [0.2, 0, 0, 1],
  out: [0.16, 1, 0.3, 1],
  in: [0.7, 0, 0.84, 0],
  overshoot: [0.34, 1.56, 0.64, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** 离场时长 = 入场 × 0.7 */
const exitOf = (seconds: number) => Math.round(seconds * 0.7 * 1000) / 1000;

export const spring = {
  /** 导航高亮、Tabs、开关 */
  snappy: { type: 'spring', stiffness: 520, damping: 40, mass: 0.8 },
  /** 面板、卡片重排 */
  gentle: { type: 'spring', stiffness: 260, damping: 30 },
  /** 反应、徽标 */
  bouncy: { type: 'spring', stiffness: 420, damping: 22 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof spring;

/**
 * 统一的变体：状态名固定为 `hidden` / `visible` / `exit`，
 * 用法：<motion.div variants={variants.fadeUp} initial="hidden" animate="visible" exit="exit" />
 */
export const variants = {
  /** opacity 0→1, y 8→0, 240ms ease-out（页面、卡片入场） */
  fadeUp: {
    hidden: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.24, ease: ease.out } },
    exit: { opacity: 0, y: 4, transition: { duration: exitOf(0.24), ease: ease.in } },
  },
  /** opacity 0→1, 200ms */
  fadeIn: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: duration.base, ease: ease.out } },
    exit: { opacity: 0, transition: { duration: exitOf(duration.base), ease: ease.in } },
  },
  /** opacity 0→1, scale .96→1, 200ms ease-out（菜单、对话框；transform-origin 由调用方按触发点设置） */
  scaleIn: {
    hidden: { opacity: 0, scale: 0.96 },
    visible: { opacity: 1, scale: 1, transition: { duration: duration.base, ease: ease.out } },
    exit: {
      opacity: 0,
      scale: 0.96,
      transition: { duration: exitOf(duration.base), ease: ease.in },
    },
  },
  /** opacity 0→1, y 6→0, blur 4px→0, 260ms ease-out（聊天消息） */
  messageIn: {
    hidden: { opacity: 0, y: 6, filter: 'blur(4px)' },
    visible: {
      opacity: 1,
      y: 0,
      filter: 'blur(0px)',
      transition: { duration: 0.26, ease: ease.out },
    },
    exit: { opacity: 0, transition: { duration: exitOf(0.26), ease: ease.in } },
  },
  /** x 24→0 + fade，320ms（右侧面板） */
  slideInRight: {
    hidden: { opacity: 0, x: 24 },
    visible: { opacity: 1, x: 0, transition: { duration: duration.slow, ease: ease.out } },
    exit: { opacity: 0, x: 24, transition: { duration: exitOf(duration.slow), ease: ease.in } },
  },
  /** 左侧抽屉（移动端侧栏）：整幅滑入，320ms ease-out */
  drawerLeft: {
    hidden: { x: '-100%' },
    visible: { x: 0, transition: { duration: duration.slow, ease: ease.out } },
    exit: { x: '-100%', transition: { duration: exitOf(duration.slow), ease: ease.in } },
  },
  /** 右侧 Sheet：整幅滑入，320ms ease-out */
  drawerRight: {
    hidden: { x: '100%' },
    visible: { x: 0, transition: { duration: duration.slow, ease: ease.out } },
    exit: { x: '100%', transition: { duration: exitOf(duration.slow), ease: ease.in } },
  },
  /** 底部 Sheet（移动端「更多」）：整幅从下方滑入，320ms ease-out */
  drawerUp: {
    hidden: { y: '100%' },
    visible: { y: 0, transition: { duration: duration.slow, ease: ease.out } },
    exit: { y: '100%', transition: { duration: exitOf(duration.slow), ease: ease.in } },
  },
  /** Tooltip：opacity 0→1, scale .96→1, 140ms ease-out；离场 80ms（transform-origin 由调用方按方向设置） */
  tooltipIn: {
    hidden: { opacity: 0, scale: 0.96 },
    visible: { opacity: 1, scale: 1, transition: { duration: duration.fast, ease: ease.out } },
    exit: { opacity: 0, transition: { duration: duration.instant, ease: ease.in } },
  },
  /** Toast：从下方 12px 弹入（spring.gentle），离场 140ms 淡出 */
  toastIn: {
    hidden: { opacity: 0, y: 12 },
    visible: { opacity: 1, y: 0, transition: spring.gentle },
    exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.in } },
  },
  /** 计数徽标换值：scale .6→1 弹出（spring.bouncy），旧值 80ms 淡出 */
  popIn: {
    hidden: { opacity: 0, scale: 0.6 },
    visible: { opacity: 1, scale: 1, transition: spring.bouncy },
    exit: { opacity: 0, transition: { duration: duration.instant, ease: ease.in } },
  },
  /** 图标切换（主题按钮）：rotate -90→0 + scale .6→1 旋入（spring.snappy），旧图标转到 90° 离场 */
  iconSwap: {
    hidden: { opacity: 0, rotate: -90, scale: 0.6 },
    visible: { opacity: 1, rotate: 0, scale: 1, transition: spring.snappy },
    exit: {
      opacity: 0,
      rotate: 90,
      scale: 0.6,
      transition: { duration: exitOf(duration.base), ease: ease.in },
    },
  },
  /** 冲突预警竖条（STYLE §4.2-7）：scaleY 0→1，200ms ease-out；origin 由调用方设置 */
  growY: {
    hidden: { scaleY: 0 },
    visible: { scaleY: 1, transition: { duration: duration.base, ease: ease.out } },
    exit: {},
  },
  /** 冲突预警整体轻抖一次（x: 0,-3,3,-2,0，320ms），等竖条长出后开始，之后静止 */
  shake: {
    hidden: { x: 0 },
    visible: {
      x: [0, -3, 3, -2, 0],
      transition: { duration: duration.slow, ease: ease.standard, delay: duration.base },
    },
    exit: {},
  },
} as const satisfies Record<string, Variants>;

export type VariantName = keyof typeof variants;

/** 列表依次入场：子项间隔 `step` 秒，只有前 12 项有递增延迟，之后同时出现。 */
export function stagger(step = 0.035, maxStaggered = 12): Variants {
  return {
    hidden: {},
    visible: {
      transition: { delayChildren: (i: number) => Math.min(i, maxStaggered) * step },
    },
    exit: {},
  };
}

// ---------------------------------------------------------------- 减少动态效果

const MOTION_KEYS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'filter']);

function toOpacityOnly(variant: Variant): Variant {
  if (typeof variant === 'function') return variant;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variant)) {
    if (!MOTION_KEYS.has(key)) out[key] = value;
  }
  return out as Variant;
}

function reduceVariants<T extends Variants>(source: T): T {
  const out: Variants = {};
  for (const [key, value] of Object.entries(source)) out[key] = toOpacityOnly(value);
  return out as T;
}

const reducedSpring = {
  snappy: { duration: 0 },
  gentle: { duration: 0 },
  bouncy: { duration: 0 },
} as const satisfies Record<SpringName, Transition>;

const reducedVariants = {
  fadeUp: reduceVariants(variants.fadeUp),
  fadeIn: variants.fadeIn,
  scaleIn: reduceVariants(variants.scaleIn),
  messageIn: reduceVariants(variants.messageIn),
  slideInRight: reduceVariants(variants.slideInRight),
  drawerLeft: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: duration.base } },
    exit: { opacity: 0, transition: { duration: exitOf(duration.base) } },
  },
  drawerRight: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: duration.base } },
    exit: { opacity: 0, transition: { duration: exitOf(duration.base) } },
  },
  drawerUp: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: duration.base } },
    exit: { opacity: 0, transition: { duration: exitOf(duration.base) } },
  },
  tooltipIn: reduceVariants(variants.tooltipIn),
  // 下面三个入场用的是弹簧，减少动态效果时换成普通淡入淡出
  toastIn: variants.fadeIn,
  popIn: variants.fadeIn,
  iconSwap: variants.fadeIn,
  // 只有位移/缩放：去掉后元素直接停在终态
  growY: reduceVariants(variants.growY),
  shake: reduceVariants(variants.shake),
} satisfies Record<VariantName, Variants>;

export interface MotionPreset {
  reduced: boolean;
  spring: Record<SpringName, Transition>;
  variants: Record<VariantName, Variants>;
  stagger: typeof stagger;
}

const FULL: MotionPreset = { reduced: false, spring, variants, stagger };
const REDUCED: MotionPreset = {
  reduced: true,
  spring: reducedSpring,
  variants: reducedVariants,
  stagger: () => ({ hidden: {}, visible: {}, exit: {} }),
};

/**
 * 组件里取动效预设的唯一入口：系统开启“减少动态效果”时，
 * 位移/缩放/模糊都去掉，只保留淡入淡出；弹簧变为瞬时。
 */
export function useMotionPreset(): MotionPreset {
  const reduced = useReducedMotion() ?? false;
  return useMemo(() => (reduced ? REDUCED : FULL), [reduced]);
}
