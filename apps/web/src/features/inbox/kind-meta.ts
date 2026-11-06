import {
  AtSign,
  BadgeCheck,
  CircleCheck,
  CircleQuestionMark,
  ListTodo,
  RefreshCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { InboxKind } from '@srh/shared';
import { tr } from '@/lib/i18n';

export interface InboxKindMeta {
  /** 条目上的类型标签 */
  label: string;
  /** 筛选条上的短名 */
  filterLabel: string;
  icon: LucideIcon;
  /** 32px 图标块：中性底 + 细描边，只有图标带类型色（大面积彩色底块显得花） */
  tile: string;
  /** 类型标签文字色 */
  text: string;
}

export const INBOX_KIND_META: Record<InboxKind, InboxKindMeta> = {
  decision: {
    label: tr('待你拍板'),
    filterLabel: tr('决策'),
    icon: CircleQuestionMark,
    tile: 'bg-surface text-warning ring-line',
    text: 'text-warning',
  },
  review: {
    label: tr('请你审阅'),
    filterLabel: tr('审阅'),
    icon: BadgeCheck,
    tile: 'bg-surface text-agent ring-line',
    text: 'text-agent-text',
  },
  conflict: {
    label: tr('冲突预警'),
    filterLabel: tr('冲突'),
    icon: TriangleAlert,
    tile: 'bg-surface text-warning ring-line',
    text: 'text-warning',
  },
  mention: {
    label: tr('提到了你'),
    filterLabel: tr('提及'),
    icon: AtSign,
    tile: 'bg-surface text-accent ring-line',
    text: 'text-accent-text',
  },
  assignment: {
    label: tr('指派给你'),
    filterLabel: tr('指派'),
    icon: ListTodo,
    tile: 'bg-surface text-accent ring-line',
    text: 'text-accent-text',
  },
  recheck: {
    label: tr('依据需复核'),
    filterLabel: tr('复核'),
    icon: RefreshCcw,
    tile: 'bg-surface text-warning ring-line',
    text: 'text-warning',
  },
  finished: {
    label: tr('已完成'),
    filterLabel: tr('完成'),
    icon: CircleCheck,
    tile: 'bg-surface text-success ring-line',
    text: 'text-success',
  },
};

/** 筛选条顺序 = 优先级顺序（决策 → 审阅 → 冲突 → 提及/复核 → 指派 → 完成）。 */
export const INBOX_FILTER_KINDS: InboxKind[] = [
  'decision',
  'review',
  'conflict',
  'mention',
  'recheck',
  'assignment',
  'finished',
];

export type InboxFilter = InboxKind | 'all';
