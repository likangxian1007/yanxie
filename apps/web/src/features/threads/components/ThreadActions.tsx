import type { ReactElement } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Thread } from '@srh/shared';
import { IconButton, Menu } from '@/components/ui';
import { useThreadActions } from './thread-actions';
import { tr } from '@/lib/i18n';

export interface ThreadActionsMenuProps {
  thread: Thread;
  projectId: string;
  /** 自定义触发按钮（默认是一个小的「⋯」图标按钮） */
  trigger?: ReactElement;
  align?: 'start' | 'end';
  className?: string;
}

/** 「⋯」更多操作菜单。 */
export function ThreadActionsMenu({
  thread,
  projectId,
  trigger,
  align = 'end',
  className,
}: ThreadActionsMenuProps) {
  const { items, dialogs } = useThreadActions(thread, projectId);
  return (
    <>
      <Menu
        align={align}
        label={tr('「{title}」的操作', { title: thread.title })}
        trigger={
          trigger ?? (
            <IconButton
              size="sm"
              label={tr('更多操作')}
              className={className}
              // 不冒泡到外层卡片 / 行；别 preventDefault，Popover 靠它判断要不要打开
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal strokeWidth={1.75} />
            </IconButton>
          )
        }
      >
        {items}
      </Menu>
      {dialogs}
    </>
  );
}
