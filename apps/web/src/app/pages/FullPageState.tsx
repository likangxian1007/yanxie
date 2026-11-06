import { CloudOff } from 'lucide-react';
import { Button, EmptyState, Spinner } from '@/components/ui';
import { BrandMark } from '@/components/layout/BrandMark';
import { tr } from '@/lib/i18n';

/** 整页加载（会话检查时） */
export function FullPageLoading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas">
      <div className="flex flex-col items-center gap-4 text-fg-subtle">
        <BrandMark />
        <Spinner size={18} label={tr('加载中')} />
      </div>
    </div>
  );
}

export function FullPageError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4">
      <EmptyState
        icon={CloudOff}
        title={tr('暂时连不上服务')}
        description={error instanceof Error ? error.message : tr('请检查网络后重试。')}
        action={
          <Button variant="primary" onClick={onRetry}>
            {tr('重试')}
          </Button>
        }
      />
    </div>
  );
}
