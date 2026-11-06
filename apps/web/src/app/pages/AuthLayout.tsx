import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { BrandMark } from '@/components/layout/BrandMark';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { useMotionPreset } from '@/lib/motion';

export interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}

/** 登录 / 注册页的居中卡片布局。 */
export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  const { variants } = useMotionPreset();
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-canvas px-4 py-12">
      <LanguageToggle className="absolute right-4 top-4" />
      <motion.div
        variants={variants.fadeUp}
        initial="hidden"
        animate="visible"
        className="relative w-full max-w-[400px]"
      >
        <div className="mb-8 flex justify-center">
          <BrandMark />
        </div>
        <div className="chrome-popover rounded-2xl border border-line p-6 shadow-md sm:p-8">
          <h1 className="text-h2 text-fg">{title}</h1>
          <p className="mt-1 text-small text-fg-muted">{description}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-small text-fg-muted">{footer}</p>
      </motion.div>
    </div>
  );
}
