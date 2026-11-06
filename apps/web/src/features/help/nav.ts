import { CircleHelp } from 'lucide-react';
import type { NavItem } from '@/components/layout/nav-items';
import { tr } from '@/lib/i18n';

/** 侧栏底部「设置」旁的帮助入口（桌面侧栏与手机抽屉共用） */
export const HELP_NAV: NavItem = { to: 'help', label: tr('帮助'), icon: CircleHelp };
