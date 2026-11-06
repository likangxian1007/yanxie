import { BadgeCheck, Inbox, ListTree, MessagesSquare } from 'lucide-react';
import { HELP_NAV } from '@/features/help/nav';
import { MAIN_NAV, SETTINGS_NAV, type NavItem } from './nav-items';
import { tr } from '@/lib/i18n';

/** 手机底部标签栏的纯逻辑：标签定义、「更多」里的页面、当前路由属于哪个标签、软键盘判断。 */

export const TABBAR_LABEL = tr('底部导航');

export interface Tab {
  key: string;
  to: string;
  label: string;
  icon: NavItem['icon'];
}

export const TABS: Tab[] = [
  { key: 'timeline', to: '', label: tr('协作台'), icon: MessagesSquare },
  { key: 'threads', to: 'threads', label: tr('线程'), icon: ListTree },
  { key: 'inbox', to: 'inbox', label: tr('待我处理'), icon: Inbox },
  { key: 'reviews', to: 'reviews', label: tr('审阅'), icon: BadgeCheck },
];

const TAB_PATHS = new Set(TABS.map((t) => t.to));

/** 「更多」里的页面：主导航里没进标签栏的 + 设置 + 帮助 */
export const MORE_NAV: NavItem[] = [
  ...MAIN_NAV.filter((item) => !TAB_PATHS.has(item.to)),
  SETTINGS_NAV,
  HELP_NAV,
];

const MORE_PATHS = new Set(MORE_NAV.map((item) => item.to));

/** 当前路由属于哪个标签：协作台只认项目根，其余按第一段路径 */
export function activeTabKey(pathname: string, projectId: string): string | null {
  const root = `/p/${projectId}`;
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
  const first = pathname.slice(root.length).replace(/^\/+/u, '').split('/')[0] ?? '';
  const tab = TABS.find((t) => t.to === first);
  if (tab) return tab.key;
  return MORE_PATHS.has(first) ? 'more' : null;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** 这个元素获得焦点时手机会弹出软键盘吗 */
export function opensSoftKeyboard(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  }
  return el.isContentEditable === true;
}
