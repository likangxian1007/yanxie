import { useEffect } from 'react';
import { withBase } from '@/lib/base-path';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { tr } from '@/lib/i18n';

/** 路由渲染出错时的兜底页：说清楚发生了什么 + 怎么办。开发环境下附上错误信息。 */
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const detail = error instanceof Error ? error.message : null;

  useEffect(() => {
    if (!notFound) console.error(error);
  }, [error, notFound]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4">
      <EmptyState
        icon={TriangleAlert}
        title={notFound ? tr('页面不存在') : tr('页面出错了')}
        description={
          notFound
            ? tr('你访问的地址可能已被移动或删除。')
            : tr('这个页面加载时遇到了问题。刷新一下通常就能恢复；如果反复出现，请告诉我们。')
        }
        action={
          <>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              {tr('刷新页面')}
            </Button>
            <Button variant="primary" onClick={() => window.location.assign(withBase('/'))}>
              {tr('回到首页')}
            </Button>
          </>
        }
      >
        {import.meta.env.DEV && detail && (
          <pre
            data-testid="route-error-detail"
            className="mt-4 max-w-xl overflow-x-auto rounded-md bg-subtle px-3 py-2 text-left font-mono text-caption whitespace-pre-wrap text-fg-muted"
          >
            {detail}
          </pre>
        )}
      </EmptyState>
    </div>
  );
}
