import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast-store';
import { tr } from '@/lib/i18n';
import { ApiRequestError } from './api';
import { withBase } from './base-path';

let lastCreditsToast = 0;

/** 余额不足（402 insufficient_credits）：全局提示一次，带「去充值」入口 */
export function notifyInsufficientCredits(error: unknown) {
  if (!(error instanceof ApiRequestError) || error.code !== 'insufficient_credits') return;
  const now = Date.now();
  if (now - lastCreditsToast < 5000) return;
  lastCreditsToast = now;
  toast({
    title: error.message,
    tone: 'warning',
    duration: 8000,
    action: { label: tr('去充值'), onClick: () => window.location.assign(withBase('/billing')) },
  });
}

/** 4xx（除 408/429）是确定性的错误，重试没有意义。 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    const { status } = error;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: notifyInsufficientCredits }),
    mutationCache: new MutationCache({ onError: notifyInsufficientCredits }),
    defaultOptions: {
      queries: {
        // 实时事件走 WebSocket，REST 数据不必频繁重新拉取
        staleTime: 30_000,
        // 离开页面后缓存多留一会：回到看过的页面先显示上次的数据、后台刷新，不再闪骨架屏
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();

/** 查询键集中管理，避免各处拼字符串。 */
export const queryKeys = {
  health: ['health'] as const,
};
