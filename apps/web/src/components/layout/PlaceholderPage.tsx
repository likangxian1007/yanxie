import type { ReactNode } from 'react';
import { Plus, type LucideIcon } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { Page, PageHeader, type PageWidth } from './Page';

export interface PlaceholderPageProps {
  title: string;
  description: ReactNode;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: ReactNode;
  /** 主按钮文案（动词开头 2–6 字）；不传则不显示 */
  actionLabel?: string;
  actionIcon?: LucideIcon;
  width?: PageWidth;
  eyebrow?: ReactNode;
  /** 页头右侧操作 */
  headerActions?: ReactNode;
  children?: ReactNode;
}

/**
 * 功能尚未实现时的占位页：页头 + 框起来的空状态，说明“这里会出现什么 + 怎么开始”。
 * 功能线程实现页面时直接替换掉对它的使用即可。
 */
export function PlaceholderPage({
  title,
  description,
  icon,
  emptyTitle,
  emptyDescription,
  actionLabel,
  actionIcon: ActionIcon = Plus,
  width = 'feed',
  eyebrow,
  headerActions,
  children,
}: PlaceholderPageProps) {
  return (
    <Page width={width}>
      <PageHeader
        title={title}
        description={description}
        eyebrow={eyebrow}
        actions={headerActions}
      />
      {children}
      <EmptyState
        framed
        icon={icon}
        title={emptyTitle}
        description={emptyDescription}
        action={
          actionLabel ? (
            <Button variant="primary" leftIcon={<ActionIcon strokeWidth={2} aria-hidden />}>
              {actionLabel}
            </Button>
          ) : undefined
        }
      />
    </Page>
  );
}
