import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { queryClient as defaultClient } from '@/lib/query';
import { initTheme } from '@/lib/theme';

export interface ProvidersProps {
  children: ReactNode;
  /** 测试里传入独立的 QueryClient */
  queryClient?: QueryClient;
}

/** 应用级 Provider：数据请求、主题同步、动效全局配置（尊重系统“减少动态效果”）。 */
export function Providers({ children, queryClient }: ProvidersProps) {
  const [client] = useState(() => queryClient ?? defaultClient);

  useEffect(() => initTheme(), []);

  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </QueryClientProvider>
  );
}
