import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { LayoutGrid } from 'lucide-react';
import { Sheet } from '@/components/ui';
import { useInboxCount } from '@/features/inbox/use-inbox-count';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { activeTabKey, MORE_NAV, opensSoftKeyboard, TABBAR_LABEL, TABS } from './mobile-tabbar';
import { projectPath, type NavItem } from './nav-items';
import { tr } from '@/lib/i18n';

/**
 * 手机底部标签栏（< 768px）：协作台 · 线程 · 待我处理 · 审阅 · 更多。
 * - 放在外壳的纵向 flex 里、滚动区下面，所以内容和吸底的 Composer 天然停在它上方，不会被挡住；
 * - 选中项的胶囊底色用 layoutId 在标签之间滑动（spring.snappy）；
 * - 输入框获得焦点（软键盘弹起）时整条收起，把高度让给键盘上方的输入区；
 * - 「更多」从底部升起一张 Sheet，列出其余页面。
 * 出现时给 <html> 提供 --tabbar-h（含安全区），需要整屏高度的页面用它扣掉标签栏。
 */

/** 软键盘是否弹起：用“焦点在可输入的元素里”近似（手机上足够可靠，不依赖 visualViewport） */
function useSoftKeyboardOpen(): boolean {
  const [open, setOpen] = useState(() =>
    typeof document === 'undefined' ? false : opensSoftKeyboard(document.activeElement),
  );
  useEffect(() => {
    const onIn = (e: FocusEvent) => setOpen(opensSoftKeyboard(e.target));
    // focusout 时 relatedTarget 是下一个拿到焦点的元素（没有就是失焦到 body）
    const onOut = (e: FocusEvent) => setOpen(opensSoftKeyboard(e.relatedTarget));
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return open;
}

function TabBadge({ count }: { count: number }) {
  const { variants } = useMotionPreset();
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.span
          key="badge"
          aria-hidden
          variants={variants.popIn}
          initial="hidden"
          animate="visible"
          exit="exit"
          className={cn(
            'absolute -top-1 left-[calc(50%+5px)] flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1',
            'bg-danger-solid text-[11px] leading-none font-semibold text-accent-fg tabular-nums ring-2 ring-canvas',
          )}
        >
          {count > 99 ? '99+' : count}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

const ITEM_CLASS = cn(
  'press relative flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 select-none',
  'text-caption transition-colors duration-(--dur-fast) ease-(--ease-standard)',
  'focus-visible:-outline-offset-4',
);

function TabFace({
  icon: Icon,
  label,
  active,
  badge,
}: {
  icon: NavItem['icon'];
  label: string;
  active: boolean;
  badge?: number;
}) {
  const { spring } = useMotionPreset();
  return (
    <>
      <span className="relative flex h-8 w-14 items-center justify-center">
        {active && (
          <motion.span
            layoutId="mobile-tab-indicator"
            transition={spring.snappy}
            aria-hidden
            className="absolute inset-0 rounded-full bg-accent-soft"
          />
        )}
        <Icon
          size={20}
          strokeWidth={active ? 2 : 1.75}
          aria-hidden
          className={cn('relative', active ? 'text-accent-text' : 'text-fg-muted')}
        />
        {badge !== undefined && <TabBadge count={badge} />}
      </span>
      <span
        className={cn(
          'relative max-w-full truncate px-0.5 leading-none',
          active ? 'font-semibold text-accent-text' : 'font-medium text-fg-muted',
        )}
      >
        {label}
      </span>
    </>
  );
}

function MoreSheet({
  projectId,
  open,
  onOpenChange,
  activeTo,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTo: string | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="bottom" title={tr('更多')}>
      <nav aria-label={tr('更多页面')} className="px-3 pt-1 pb-4">
        <ul className="grid grid-cols-4 gap-x-1 gap-y-2">
          {MORE_NAV.map((item) => {
            const Icon = item.icon;
            const active = activeTo === item.to;
            return (
              <li key={item.to}>
                <NavLink
                  to={projectPath(projectId, item.to)}
                  onClick={() => onOpenChange(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'press flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-lg px-1 py-2',
                    'transition-colors duration-(--dur-fast) ease-(--ease-standard) active:bg-subtle',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-12 place-items-center rounded-lg ring-1',
                      active
                        ? 'bg-accent-soft text-accent-text ring-accent/30'
                        : 'bg-subtle text-fg-muted ring-line',
                    )}
                  >
                    <Icon size={22} strokeWidth={1.75} />
                  </span>
                  <span
                    className={cn(
                      'max-w-full truncate text-small',
                      active ? 'font-semibold text-accent-text' : 'text-fg',
                    )}
                  >
                    {item.label}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </Sheet>
  );
}

export interface MobileTabBarProps {
  projectId: string;
}

export function MobileTabBar({ projectId }: MobileTabBarProps) {
  const { pathname } = useLocation();
  const { variants } = useMotionPreset();
  const inboxCount = useInboxCount(projectId);
  const keyboardOpen = useSoftKeyboardOpen();
  // 记下是在哪个地址打开的「更多」：换页（点了某一项、浏览器后退）后自然就收起了
  const [moreAt, setMoreAt] = useState<string | null>(null);
  const moreOpen = moreAt === pathname;
  const setMoreOpen = (open: boolean) => setMoreAt(open ? pathname : null);

  const routeKey = activeTabKey(pathname, projectId);
  const activeKey = moreOpen ? 'more' : routeKey;
  const first = pathname.split('/')[3] ?? '';
  const activeMoreTo = routeKey === 'more' ? first : null;

  return (
    <>
      <AnimatePresence initial={false}>
        {!keyboardOpen && (
          <motion.nav
            key="tabbar"
            aria-label={TABBAR_LABEL}
            data-mobile-tabbar=""
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            className={cn(
              'relative z-sticky shrink-0 border-t border-line bg-canvas md:hidden',
              'pb-[env(safe-area-inset-bottom)]',
            )}
          >
            <LayoutGroup id="mobile-tabbar">
              <ul className="grid h-14 grid-cols-5">
                {TABS.map((tab) => (
                  <li key={tab.key} className="min-w-0">
                    <NavLink
                      to={projectPath(projectId, tab.to)}
                      end={tab.to === ''}
                      aria-label={
                        tab.key === 'inbox' && inboxCount > 0
                          ? tr('{label}（{inboxCount} 条）', { label: tab.label, inboxCount })
                          : tab.label
                      }
                      className={ITEM_CLASS}
                    >
                      <TabFace
                        icon={tab.icon}
                        label={tab.label}
                        active={activeKey === tab.key}
                        {...(tab.key === 'inbox' ? { badge: inboxCount } : {})}
                      />
                    </NavLink>
                  </li>
                ))}
                <li className="min-w-0">
                  <button
                    type="button"
                    aria-label={tr('更多页面')}
                    aria-haspopup="dialog"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen(true)}
                    className={ITEM_CLASS}
                  >
                    <TabFace icon={LayoutGrid} label={tr('更多')} active={activeKey === 'more'} />
                  </button>
                </li>
              </ul>
            </LayoutGroup>
          </motion.nav>
        )}
      </AnimatePresence>
      <MoreSheet
        projectId={projectId}
        open={moreOpen}
        onOpenChange={setMoreOpen}
        activeTo={activeMoreTo}
      />
    </>
  );
}
