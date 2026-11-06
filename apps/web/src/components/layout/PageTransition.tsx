import { useLocation, useOutlet } from 'react-router';
import { motion } from 'motion/react';
import { useMotionPreset } from '@/lib/motion';

/** 同一页面内切换子项时不整页重挂载（例如工作区左侧会话列表保持不动）。 */
const STABLE_SECTIONS = new Set(['workspace']);

function transitionKey(pathname: string): string {
  // /p/:projectId/<section>/...
  const [, , projectId, section] = pathname.split('/');
  if (section && STABLE_SECTIONS.has(section)) return `/p/${projectId}/${section}`;
  return pathname;
}

/**
 * 内容区页面切换：按路径重新挂载并 fadeUp 入场（侧栏与顶栏不动，不做左右滑动）。
 */
export function PageTransition() {
  const location = useLocation();
  const outlet = useOutlet();
  const { variants } = useMotionPreset();

  return (
    <motion.div
      key={transitionKey(location.pathname)}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      className="flex min-h-full flex-1 flex-col"
    >
      {outlet}
    </motion.div>
  );
}
