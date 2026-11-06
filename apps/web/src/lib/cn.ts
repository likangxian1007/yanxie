import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * 让 tailwind-merge 认识我们在 index.css `@theme` 里自定义的字号、阴影和层级，
 * 否则 `text-h1` 会被当成颜色类、和 `text-fg` 互相覆盖。
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['display', 'h1', 'h2', 'h3', 'body', 'prose', 'small', 'caption'],
      shadow: ['glow'],
    },
    classGroups: {
      z: [{ z: ['base', 'sticky', 'sidebar', 'overlay', 'modal', 'popover', 'toast', 'tooltip'] }],
    },
  },
});

/** 合并类名：clsx 处理条件，tailwind-merge 去掉冲突的 Tailwind 类（后者优先）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
