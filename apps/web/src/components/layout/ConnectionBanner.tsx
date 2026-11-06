import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { WifiOff } from 'lucide-react';
import { useMotionPreset } from '@/lib/motion';
import { useRealtimeStore } from '@/lib/realtime-store';
import { tr } from '@/lib/i18n';

/**
 * 实时连接断开超过 3 秒时，在内容区顶部出现一条细横幅；重连后自动消失。
 * 短暂抖动（例如切网）不打扰用户。
 */
export function ConnectionBanner() {
  const status = useRealtimeStore((s) => s.status);
  const { variants } = useMotionPreset();
  const bad = status === 'reconnecting' || status === 'unauthorized';
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!bad) {
      const t = window.setTimeout(() => setShow(false), 0);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setShow(true), 3000);
    return () => window.clearTimeout(t);
  }, [bad]);

  return (
    <AnimatePresence>
      {show && bad && (
        <motion.div
          key="conn"
          role="status"
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="flex shrink-0 items-center justify-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-small text-warning"
        >
          <WifiOff size={14} strokeWidth={1.75} aria-hidden />
          {status === 'unauthorized'
            ? tr('登录已失效，实时更新已停止。请刷新页面重新登录。')
            : tr('实时连接断开了，正在重连…期间的消息会在恢复后补上。')}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
