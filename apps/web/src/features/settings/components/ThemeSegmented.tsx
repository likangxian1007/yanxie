import { useId } from 'react';
import { motion } from 'motion/react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { THEME_LABEL, useThemeStore, type ThemePreference } from '@/lib/theme';
import { tr } from '@/lib/i18n';

const OPTIONS: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
];

/** 分段控件：bg-subtle rounded-md p-0.5，选中块 bg-surface shadow-xs 用 layoutId 滑动。 */
export function ThemeSegmented() {
  const name = useId();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const { spring } = useMotionPreset();

  return (
    <div
      role="radiogroup"
      aria-label={tr('主题')}
      className="inline-flex rounded-md bg-subtle p-0.5 ring-1 ring-line"
    >
      {OPTIONS.map(({ value, icon: Icon }) => {
        const active = preference === value;
        return (
          <label
            key={value}
            className={cn(
              'press relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-sm px-3 text-small has-focus-visible:outline-2 has-focus-visible:outline-accent max-md:h-11',
              active ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={active}
              onChange={() => setPreference(value)}
              className="sr-only"
            />
            {active && (
              <motion.span
                layoutId="theme-segmented-thumb"
                transition={spring.snappy}
                aria-hidden
                className="absolute inset-0 rounded-sm bg-surface shadow-xs dark:bg-muted"
              />
            )}
            <Icon size={14} strokeWidth={1.75} aria-hidden className="relative" />
            <span className="relative">{THEME_LABEL[value]}</span>
          </label>
        );
      })}
    </div>
  );
}
