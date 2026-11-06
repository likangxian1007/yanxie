import { AnimatePresence, motion } from 'motion/react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { THEME_LABEL, useThemeStore, type ThemePreference } from '@/lib/theme';
import { tr } from '@/lib/i18n';

const ICON: Record<ThemePreference, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/** 顶栏主题按钮：浅色 → 深色 → 跟随系统，图标旋转切换。 */
export function ThemeToggle({ className }: { className?: string }) {
  const preference = useThemeStore((s) => s.preference);
  const cycle = useThemeStore((s) => s.cycle);
  // 减少动态效果时 iconSwap 只剩淡入淡出
  const { variants } = useMotionPreset();
  const Icon = ICON[preference];

  return (
    <IconButton
      label={tr('主题：{value}（点击切换）', { value: THEME_LABEL[preference] })}
      onClick={cycle}
      className={className}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={preference}
          className="flex"
          variants={variants.iconSwap}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <Icon strokeWidth={1.75} aria-hidden />
        </motion.span>
      </AnimatePresence>
    </IconButton>
  );
}
