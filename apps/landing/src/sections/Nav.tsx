import { ArrowUpRight, Moon, Sun } from 'lucide-react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import { useEffect, useState } from 'react';

import { cx, EASE } from '../components/fx';
import { APP_URL } from '../links';
import { LANG_SWITCH_LABEL, useLang } from '../i18n';

type Theme = 'dark' | 'light';

const THEME_COLOR: Record<Theme, string> = { dark: '#0a0a0a', light: '#ffffff' };

function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 亮/暗主题切换：写 <html data-theme>，记到 localStorage；首帧前由 index.html 的内联脚本恢复 */
function ThemeToggle() {
  const { t } = useLang();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next]);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // 隐私模式等不可写时只在本次会话生效
    }
    setTheme(next);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.nav.themeAria}
      title={theme === 'dark' ? t.nav.toLight : t.nav.toDark}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-fg md:size-9"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/** 中/英切换：即时生效（React context），记到 localStorage 'srh-lang' */
function LangToggle() {
  const { lang, setLang, t } = useLang();
  const next = lang === 'zh' ? 'en' : 'zh';
  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      aria-label={t.nav.langAria}
      title={t.nav.langAria}
      lang={next === 'zh' ? 'zh-CN' : 'en'}
      className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-1.5 md:h-9 md:min-w-9 text-[12.5px] font-semibold text-muted transition-colors hover:bg-raised hover:text-fg"
    >
      {LANG_SWITCH_LABEL[lang]}
    </button>
  );
}

const LINK_HREFS = ['#how', '#features', '#hybrid', '#agents', '#mobile'];

/** 当前所在章节（导航高亮）：章节进入视口中部带时切换 */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        setActive(ids.find((id) => seen.get(id)) ?? null);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

const SECTION_IDS = ['how', 'features', 'hybrid', 'agents', 'mobile'];

export function Nav() {
  const { t } = useLang();
  const reduce = useReducedMotion();
  const active = useActiveSection(SECTION_IDS);
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (v) => setScrolled(v > 24));

  return (
    <motion.header
      initial={reduce ? false : { y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: EASE }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:px-4"
    >
      <nav
        aria-label={t.nav.aria}
        className={cx(
          'flex w-full max-w-5xl items-center justify-between gap-3 rounded-2xl border px-3 py-2 transition-[background-color,border-color,box-shadow] duration-500 sm:px-4',
          scrolled
            ? 'border-line bg-canvas/95 md:bg-canvas/80 md:backdrop-blur-xl'
            : 'border-transparent bg-transparent',
        )}
      >
        <a
          href="#top"
          className="flex min-h-11 shrink-0 items-center gap-2 md:min-h-9"
          aria-label={t.nav.homeAria}
        >
          <img src="/favicon.svg" alt="" width={24} height={24} className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight text-fg">{t.brand}</span>
        </a>
        <ul className="hidden items-center gap-1 md:flex">
          {LINK_HREFS.map((href, i) => (
            <li key={href}>
              <a
                href={href}
                aria-current={active === href.slice(1) ? 'location' : undefined}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-sm transition-colors hover:bg-raised hover:text-fg',
                  active === href.slice(1) ? 'text-fg' : 'text-muted',
                )}
              >
                {t.nav.links[i]}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex shrink-0 items-center gap-1.5">
          <LangToggle />
          <ThemeToggle />
          <a
            href={APP_URL}
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-fg px-3.5 text-sm font-medium text-canvas transition-opacity hover:opacity-85 md:h-9"
          >
            {t.openApp}
            <ArrowUpRight className="size-4" />
          </a>
        </div>
      </nav>
    </motion.header>
  );
}
