import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { Thread } from '@srh/shared';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PlanEditor } from './PlanEditor';
import { PlanView, type PlanViewProps } from './PlanView';
import { tr } from '@/lib/i18n';

export interface EditablePlanProps extends Omit<PlanViewProps, 'text'> {
  thread: Thread;
  /** 成员可以改计划；访客 / 只读时不出现编辑入口 */
  canEdit: boolean;
  /** 还没有计划时的说明；不给则什么都不显示（成员仍可「写计划」） */
  emptyText?: string;
}

/** 计划卡：平时是 PlanView，成员点「编辑计划」后原地换成编辑器。 */
export function EditablePlan({
  thread,
  canEdit,
  emptyText,
  className,
  ...viewProps
}: EditablePlanProps) {
  const [editing, setEditing] = useState(false);
  const hasPlan = thread.statusText.trim().length > 0;

  if (editing && canEdit) {
    return <PlanEditor thread={thread} onDone={() => setEditing(false)} className={className} />;
  }

  return (
    <div className={cn('min-w-0', className)}>
      {hasPlan ? (
        <PlanView text={thread.statusText} {...viewProps} />
      ) : (
        emptyText && <p className="text-small text-fg-subtle">{emptyText}</p>
      )}
      {canEdit && (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<Pencil strokeWidth={1.75} aria-hidden />}
          onClick={() => setEditing(true)}
          className={cn('-ml-2', (hasPlan || emptyText) && 'mt-2')}
        >
          {hasPlan ? tr('编辑计划') : tr('写计划')}
        </Button>
      )}
    </div>
  );
}
