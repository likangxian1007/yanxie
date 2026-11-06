import {
  ClipboardList,
  FileText,
  FlaskConical,
  GitPullRequestDraft,
  ListTree,
  MessageSquare,
  Package,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import type { ReviewTargetKind } from '@srh/shared';
import { cn } from '@/lib/cn';
import { TARGET_KIND_LABEL } from '../lib/target';

const TARGET_ICON: Record<ReviewTargetKind, LucideIcon> = {
  document: FileText,
  experiment: FlaskConical,
  report: Presentation,
  thread: ListTree,
  plan: ClipboardList,
  message: MessageSquare,
  output: Package,
  proposal: GitPullRequestDraft,
  research_record: FlaskConical,
  research_finding: ClipboardList,
};

/** 审阅目标类型图标（带读屏文字） */
export function TargetIcon({
  kind,
  size = 16,
  className,
}: {
  kind: ReviewTargetKind;
  size?: number;
  className?: string;
}) {
  const Icon = TARGET_ICON[kind];
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      role="img"
      aria-label={TARGET_KIND_LABEL[kind]}
      className={cn('shrink-0', className)}
    />
  );
}
