import { useNavigate } from 'react-router';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { BrandMark } from '@/components/layout/BrandMark';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export interface NotFoundPageProps {
  /** 在项目外壳内显示（不再占满整屏、不显示标识） */
  inShell?: boolean;
}

/** 404 */
export function NotFoundPage({ inShell = false }: NotFoundPageProps) {
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center bg-canvas px-4',
        inShell ? 'flex-1 py-16' : 'min-h-dvh',
      )}
    >
      {!inShell && <BrandMark className="mb-8" />}
      <EmptyState
        icon={Compass}
        title={tr('页面不存在')}
        description={tr('你访问的地址可能已被移动或删除。检查一下链接，或者回到我的课题。')}
        action={
          <>
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {tr('返回上一页')}
            </Button>
            <Button variant="primary" onClick={() => navigate('/')}>
              {tr('回到我的课题')}
            </Button>
          </>
        }
      />
    </div>
  );
}
