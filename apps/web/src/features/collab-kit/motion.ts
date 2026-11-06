import type { TargetAndTransition, Transition } from 'motion/react';
import { duration, ease } from '@/lib/motion';

/**
 * 协作功能里几个签名动效的预设（STYLE §4.2-6 清单完成、§4.2-11 LGTM），
 * 时长与曲线都取自 lib/motion.ts，组件里不再手写数值。
 * 每个预设都给出“减少动态效果”时的版本：不缩放、不描线，只保留最终状态。
 */

/** 按下反馈：轻微缩小 */
export function pressFeedback(reduced: boolean): TargetAndTransition | undefined {
  return reduced ? undefined : { scale: 0.97 };
}

/** 对勾描线：pathLength 0→1。checklist = 300ms（清单完成），signature = 480ms（LGTM） */
export function checkDraw(
  reduced: boolean,
  kind: 'checklist' | 'signature' = 'checklist',
): Transition {
  if (reduced) return { duration: 0 };
  return { duration: kind === 'signature' ? duration.slower : 0.3, ease: ease.out };
}

/** LGTM 外圈 success 涟漪：放大并淡出一次（480ms）；减少动态时不播放 */
export const ripple = {
  initial: { opacity: 0.6, scale: 1 },
  animate: { opacity: 0, scale: 1.35 },
  exit: { opacity: 0 },
  transition: { duration: duration.slower, ease: ease.out },
} as const;
