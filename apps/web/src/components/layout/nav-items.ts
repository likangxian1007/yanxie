import {
  BadgeCheck,
  FileText,
  Inbox,
  LibraryBig,
  ListTree,
  MessagesSquare,
  Presentation,
  ScrollText,
  Microscope,
  Settings,
  SquareKanban,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { tr } from '@/lib/i18n';

export interface NavItem {
  /** 相对项目根 `/p/:projectId` 的路径；空串为协作台 */
  to: string;
  label: string;
  icon: LucideIcon;
}

export const INBOX_NAV: NavItem = { to: 'inbox', label: tr('待我处理'), icon: Inbox };
export const PRIMARY_NAV: NavItem[] = [
  { to: '', label: tr('协作台'), icon: MessagesSquare },
  { to: 'workspace', label: tr('我的工作区'), icon: UserRound },
  INBOX_NAV,
];
export const THREADS_NAV: NavItem = { to: 'threads', label: tr('线程'), icon: ListTree };
/** 方案与依据是课题的主线，放在分组外，分组收起时也能直接看到。 */
export const PLANS_NAV: NavItem = { to: 'plans', label: tr('方案与依据'), icon: ScrollText };
export const RESOURCE_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: tr('资料'),
    items: [
      { to: 'docs', label: tr('文档'), icon: FileText },
      { to: 'library', label: tr('项目文献库'), icon: LibraryBig },
    ],
  },
  {
    label: tr('推进'),
    items: [
      { to: 'tasks', label: tr('任务'), icon: SquareKanban },
      { to: 'research', label: tr('研究空间'), icon: Microscope },
      { to: 'reviews', label: tr('审阅'), icon: BadgeCheck },
      { to: 'reports', label: tr('组会汇报'), icon: Presentation },
    ],
  },
];
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: tr('工作'), items: PRIMARY_NAV },
  {
    label: tr('资源'),
    items: [THREADS_NAV, PLANS_NAV, ...RESOURCE_GROUPS.flatMap((group) => group.items)],
  },
];
/** 不含单独登记的收件箱，兼容命令面板等现有调用。 */
export const MAIN_NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items).filter(
  (item) => item.to !== 'inbox',
);

export const SETTINGS_NAV: NavItem = { to: 'settings', label: tr('设置'), icon: Settings };

export function projectPath(projectId: string, to: string): string {
  return to ? `/p/${projectId}/${to}` : `/p/${projectId}`;
}
