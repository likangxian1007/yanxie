import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import {
  ArrowUpRight,
  Compass,
  GraduationCap,
  Keyboard,
  Lightbulb,
  MessageCircleQuestion,
  MessageSquarePlus,
  Search,
  SearchX,
  Wrench,
  X,
} from 'lucide-react';
import { Button, EmptyState, IconButton, Input, Kbd } from '@/components/ui';
import { Page, PageHeader } from '@/components/layout/Page';
import { ServiceStatusDetails } from '@/components/layout/ServiceStatus';
import { useServiceStatus } from '@/components/layout/use-service-status';
import { projectPath } from '@/components/layout/nav-items';
import { useTourStore } from '@/features/onboarding/tour-store';
import { FEEDBACK_COPY } from '@/features/feedback/copy';
import { openFeedbackDialog } from '@/features/feedback/feedback-store';
import { tourVariantForRole } from '@/features/onboarding/tour-steps';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { isApplePlatform } from '@/lib/platform';
import { useMyRole, useProjectId } from '@/lib/project';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  ADVISOR_GUIDE,
  FAQ,
  HELP_MODULES,
  localizeModule,
  matchesQuery,
  moduleText,
  SHORTCUTS,
  TOOL_MODULES,
  type HelpModule,
  type ShortcutGroup,
} from '../content';
import { tr } from '@/lib/i18n';

/** 只有触屏、没有能悬停的指针（手机、平板） */
const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';

interface TocItem {
  id: string;
  label: string;
}

function keyLabel(key: string, apple: boolean): string {
  if (key === 'mod') return apple ? '⌘' : 'Ctrl';
  if (key === 'alt') return apple ? '⌥' : 'Alt';
  if (key === 'Shift') return apple ? '⇧' : 'Shift';
  return key;
}

function shortcutText(keys: string[][], apple: boolean): string {
  return keys.map((combo) => combo.map((k) => keyLabel(k, apple)).join(' ')).join(tr(' 然后 '));
}

/** 一个快捷键：组合键内用 +（苹果上不加），先后按的键之间写“然后” */
function Keys({ keys, apple }: { keys: string[][]; apple: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-caption font-normal text-fg-subtle">
      {keys.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="px-0.5">{tr('然后')}</span>}
          {combo.map((k, j) => (
            <Fragment key={`${k}-${j}`}>
              {j > 0 && !apple && <span aria-hidden>+</span>}
              <Kbd>{keyLabel(k, apple)}</Kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="mb-4 flex items-center gap-2 text-h2 text-fg">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-subtle text-fg-muted ring-1 ring-line"
      >
        {icon}
      </span>
      {children}
    </h2>
  );
}

function ModuleSection({ m, projectId }: { m: HelpModule; projectId: string }) {
  const Icon = m.icon;
  return (
    <section
      id={m.id}
      aria-labelledby={`${m.id}-title`}
      className="scroll-mt-20 rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text"
        >
          <Icon size={16} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`${m.id}-title`} className="text-h3 text-fg">
            {m.title}
          </h3>
          <p className="mt-1 text-body text-pretty text-fg-muted">{m.what}</p>
        </div>
        {m.to !== undefined && (
          <Link
            to={projectPath(projectId, m.to)}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-small text-accent-text hover:underline max-sm:min-h-11"
            aria-label={tr('打开{title}', { title: m.title })}
          >
            {tr('打开')}
            <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
          </Link>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:pl-11">
        <div>
          <h4 className="mb-2 text-caption text-fg-subtle">{tr('典型流程')}</h4>
          <ol className="flex flex-col gap-1.5">
            {m.steps.map((s, i) => (
              <li key={s} className="flex items-start gap-2.5 text-body text-fg">
                <span
                  aria-hidden
                  className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full bg-subtle text-caption text-fg-muted tabular-nums ring-1 ring-line"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 text-pretty">{s}</span>
              </li>
            ))}
          </ol>
        </div>

        <figure className="rounded-md border-l-2 border-accent/50 bg-subtle px-3.5 py-2.5">
          <figcaption className="mb-1 text-caption text-fg-subtle">{tr('举个例子')}</figcaption>
          <p className="text-small text-pretty text-fg-muted">{m.example}</p>
        </figure>

        {m.tips.length > 0 && (
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-caption text-fg-subtle">
              <Lightbulb size={12} strokeWidth={2} aria-hidden />
              {tr('小技巧')}
            </h4>
            <ul className="flex flex-col gap-1">
              {m.tips.map((t) => (
                <li key={t} className="flex items-start gap-2 text-small text-fg-muted">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-fg-subtle" />
                  <span className="min-w-0 text-pretty">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function ShortcutTable({ group, apple }: { group: ShortcutGroup; apple: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <h3 className="border-b border-line bg-subtle/60 px-4 py-2 text-caption text-fg-muted">
        {group.title}
      </h3>
      <table className="w-full text-small">
        <caption className="sr-only">{tr('{title}快捷键', { title: group.title })}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">{tr('按键')}</th>
            <th scope="col">{tr('作用')}</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r) => (
            <tr key={r.label} className="border-b border-line last:border-b-0">
              <td className="w-[46%] px-4 py-2 align-top sm:w-[40%]">
                <Keys keys={r.keys} apple={apple} />
              </td>
              <td className="px-4 py-2 align-top text-pretty text-fg">{r.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 当前看到哪一节（目录高亮用） */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('|');
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const root = document.getElementById('app-scroll');
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        const first = key.split('|').find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { root, rootMargin: '-64px 0px -55% 0px', threshold: 0 },
    );
    for (const id of key.split('|')) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key]);
  return active;
}

/** 帮助中心：每个模块怎么用、给导师的说明、快捷键、常见问题；可以搜索，也可以从这里重看新手引导。 */
export function HelpPage() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const role = useMyRole(projectId);
  const requestTour = useTourStore((s) => s.requestTour);
  const { spring } = useMotionPreset();
  const [query, setQuery] = useState('');
  const service = useServiceStatus();
  const apple = isApplePlatform();
  // 只有触屏、没有鼠标（手机、平板）：文案不讲快捷键，快捷键表也不默认展示（搜索时仍可搜到）
  const touchOnly = useMediaQuery(TOUCH_ONLY_QUERY);
  const variant = tourVariantForRole(role);
  const q = query.trim();

  const modules = useMemo(
    () =>
      HELP_MODULES.map((m) => localizeModule(m, touchOnly)).filter((m) =>
        matchesQuery(moduleText(m), q),
      ),
    [q, touchOnly],
  );
  const tools = useMemo(
    () =>
      TOOL_MODULES.map((m) => localizeModule(m, touchOnly)).filter((m) =>
        matchesQuery(moduleText(m), q),
      ),
    [q, touchOnly],
  );
  const advisor = useMemo(
    () =>
      ADVISOR_GUIDE.map((b) => ({
        ...b,
        items: matchesQuery(b.title, q) ? b.items : b.items.filter((i) => matchesQuery(i, q)),
      })).filter((b) => b.items.length > 0 || matchesQuery(tr('给导师 导师 老师 advisor'), q)),
    [q],
  );
  const shortcuts = useMemo(
    () =>
      (touchOnly && !q ? [] : SHORTCUTS)
        .map((g) => ({
          ...g,
          rows: matchesQuery(tr('{title} 快捷键 shortcut', { title: g.title }), q)
            ? g.rows
            : g.rows.filter((r) => matchesQuery(`${r.label} ${shortcutText(r.keys, apple)}`, q)),
        }))
        .filter((g) => g.rows.length > 0),
    [q, apple, touchOnly],
  );
  const faq = useMemo(() => FAQ.filter((f) => matchesQuery(`${f.q} ${f.a.join(' ')}`, q)), [q]);
  const serviceMatches = matchesQuery(tr('服务状态 数据库 网络 连接 诊断'), q);
  const total =
    Number(serviceMatches) +
    modules.length +
    tools.length +
    advisor.reduce((n, b) => n + b.items.length, 0) +
    shortcuts.reduce((n, g) => n + g.rows.length, 0) +
    faq.length;

  const toc: TocItem[] = useMemo(() => {
    const items: TocItem[] = modules.map((m) => ({ id: m.id, label: m.title }));
    // 工具类在目录里只占一项，点进去是整节
    if (tools.length) items.push({ id: 'tools', label: tr('agent 能力与工具') });
    if (advisor.length) items.push({ id: 'advisor', label: tr('给导师') });
    if (shortcuts.length) items.push({ id: 'shortcuts', label: tr('快捷键') });
    if (faq.length) items.push({ id: 'faq', label: tr('常见问题') });
    return items;
  }, [modules, tools.length, advisor.length, shortcuts.length, faq.length]);
  const active = useActiveSection(toc.map((t) => t.id));

  // 带锚点进来（模块介绍条的“了解更多”）：滚到对应的一节
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/u, ''));
    if (!id) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (id === 'service-status' && el instanceof HTMLDetailsElement) el.open = true;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hash]);

  const startTour = (v = variant) => {
    navigate(projectPath(projectId, ''));
    requestTour(v);
  };
  const otherVariant = variant === 'advisor' ? 'member' : 'advisor';

  return (
    <Page width="full" className="max-w-5xl">
      <PageHeader
        title={tr('帮助中心')}
        description={
          touchOnly
            ? tr(
                '每个模块是做什么的、平时怎么用，agent 能用哪些工具，以及常见问题。随时可以从「更多」回到这里。',
              )
            : tr(
                '每个模块是做什么的、平时怎么用，agent 能用哪些工具，以及快捷键和常见问题。随时按 ? 回到这里。',
              )
        }
        actions={
          <div className="flex gap-2 max-sm:w-full max-sm:flex-col">
            <Button
              leftIcon={<MessageSquarePlus strokeWidth={1.75} aria-hidden />}
              onClick={() => openFeedbackDialog()}
              className="max-sm:h-11 max-sm:w-full"
            >
              {FEEDBACK_COPY.entryLong}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Compass strokeWidth={1.75} aria-hidden />}
              onClick={() => startTour()}
              className="max-sm:h-11 max-sm:w-full"
            >
              {tr('重看新手引导')}
            </Button>
          </div>
        }
      />

      {serviceMatches && <ServiceStatusDetails info={service} />}

      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <label htmlFor="help-search" className="sr-only">
            {tr('搜索帮助')}
          </label>
          <Input
            id="help-search"
            type="search"
            size="lg"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr('搜索帮助，例如：LGTM、认领、LaTeX')}
            leading={<Search strokeWidth={1.75} aria-hidden />}
            trailing={
              query ? (
                <IconButton label={tr('清除搜索')} size="sm" onClick={() => setQuery('')}>
                  <X strokeWidth={1.75} aria-hidden />
                </IconButton>
              ) : undefined
            }
            autoComplete="off"
            className="max-sm:h-11 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <Button
          variant="ghost"
          onClick={() => startTour(otherVariant)}
          className="max-sm:h-11 sm:shrink-0"
        >
          {otherVariant === 'advisor' ? tr('看导师版引导') : tr('看成员版引导')}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {q ? (total ? tr('找到 {total} 条相关内容', { total }) : tr('没有找到相关内容')) : ''}
      </p>

      {q && total === 0 ? (
        <EmptyState
          framed
          icon={SearchX}
          title={tr('没有找到和「{q}」相关的帮助', { q })}
          description={tr('换个说法试试，比如模块名、按钮上的字或快捷键。')}
          action={
            <Button variant="secondary" onClick={() => setQuery('')}>
              {tr('清除搜索')}
            </Button>
          }
        />
      ) : (
        <div className="lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-10">
          <nav
            aria-label={tr('帮助目录')}
            className="mb-6 lg:sticky lg:top-[calc(var(--topbar-h)+24px)] lg:mb-0 lg:self-start"
          >
            <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:-mx-6 md:px-6 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
              {toc.map((t) => {
                const isActive = active === t.id;
                return (
                  <li key={t.id} className="shrink-0">
                    <a
                      href={`#${t.id}`}
                      aria-current={isActive ? 'location' : undefined}
                      className={cn(
                        'relative flex h-8 items-center rounded-sm px-2.5 text-small whitespace-nowrap transition-colors duration-(--dur-fast) ease-(--ease-standard) max-lg:h-9 max-lg:rounded-full max-lg:border max-lg:border-line max-lg:bg-surface',
                        isActive ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="help-toc-active"
                          transition={spring.snappy}
                          aria-hidden
                          className="absolute inset-0 rounded-[inherit] bg-subtle ring-1 ring-line"
                        />
                      )}
                      <span className="relative">{t.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-12">
            {modules.length > 0 && (
              <div>
                <SectionTitle icon={<Compass size={15} strokeWidth={1.75} />}>
                  {tr('各模块怎么用')}
                </SectionTitle>
                <div className="flex flex-col gap-4">
                  {modules.map((m) => (
                    <ModuleSection key={m.id} m={m} projectId={projectId} />
                  ))}
                </div>
              </div>
            )}

            {tools.length > 0 && (
              <section id="tools" aria-labelledby="tools-title" className="scroll-mt-20">
                <SectionTitle icon={<Wrench size={15} strokeWidth={1.75} />}>
                  <span id="tools-title">{tr('agent 能力与工具')}</span>
                </SectionTitle>
                <p className="-mt-2 mb-4 text-body text-pretty text-fg-muted">
                  {tr(
                    '斜杠指令、Skill、MCP、模型与强度、科研 profile，以及 agent 能用的检索、文献库、Notebook。',
                  )}
                </p>
                <div className="flex flex-col gap-4">
                  {tools.map((m) => (
                    <ModuleSection key={m.id} m={m} projectId={projectId} />
                  ))}
                </div>
              </section>
            )}

            {advisor.length > 0 && (
              <section id="advisor" aria-labelledby="advisor-title" className="scroll-mt-20">
                <SectionTitle icon={<GraduationCap size={15} strokeWidth={1.75} />}>
                  <span id="advisor-title">{tr('给导师')}</span>
                </SectionTitle>
                <p className="-mt-2 mb-4 text-body text-pretty text-fg-muted">
                  {tr('不需要了解所有功能。看进展、处理待办、给结论，这三件事就够用了。')}
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  {advisor.map((b) => (
                    <div
                      key={b.id}
                      id={b.id}
                      className="scroll-mt-20 rounded-lg border border-line bg-surface p-4 shadow-sm"
                    >
                      <h3 className="text-h3 text-fg">{b.title}</h3>
                      <ol className="mt-3 flex flex-col gap-2">
                        {b.items.map((item, i) => (
                          <li
                            key={item}
                            className="flex items-start gap-2.5 text-small text-fg-muted"
                          >
                            <span
                              aria-hidden
                              className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-subtle text-caption text-fg-muted tabular-nums ring-1 ring-line"
                            >
                              {i + 1}
                            </span>
                            <span className="min-w-0 text-pretty">{item}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
                {variant !== 'advisor' && (
                  <p className="mt-3 text-small text-fg-muted">
                    {tr('想先看看导师会看到什么？')}
                    <button
                      type="button"
                      onClick={() => startTour('advisor')}
                      className="ml-1 cursor-pointer rounded-xs text-accent-text hover:underline max-sm:py-3"
                    >
                      {tr('看导师版引导')}
                    </button>
                  </p>
                )}
              </section>
            )}

            {shortcuts.length > 0 && (
              <section id="shortcuts" aria-labelledby="shortcuts-title" className="scroll-mt-20">
                <SectionTitle icon={<Keyboard size={15} strokeWidth={1.75} />}>
                  <span id="shortcuts-title">{tr('快捷键')}</span>
                </SectionTitle>
                <p className="-mt-2 mb-4 text-small text-fg-muted">
                  {apple ? tr('⌘ 是 Command 键，⌥ 是 Option 键。') : tr('在 Mac 上，Ctrl 换成 ⌘。')}
                  {tr('正在输入文字时，单字母快捷键不会触发。')}
                </p>
                <div className="grid items-start gap-4 md:grid-cols-2">
                  {shortcuts.map((g) => (
                    <ShortcutTable key={g.title} group={g} apple={apple} />
                  ))}
                </div>
              </section>
            )}

            {faq.length > 0 && (
              <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20">
                <SectionTitle icon={<MessageCircleQuestion size={15} strokeWidth={1.75} />}>
                  <span id="faq-title">{tr('常见问题')}</span>
                </SectionTitle>
                <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                  {faq.map((f) => (
                    <div key={f.id} id={f.id} className="scroll-mt-20 px-4 py-4 sm:px-5">
                      <h3 className="text-h3 text-fg">{f.q}</h3>
                      {f.a.map((p) => (
                        <p key={p} className="mt-1.5 text-body text-pretty text-fg-muted">
                          {p}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
