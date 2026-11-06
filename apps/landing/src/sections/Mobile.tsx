import {
  BellRing,
  Check,
  FileDiff,
  Inbox,
  LayoutGrid,
  MessagesSquare,
  MoreHorizontal,
  Smartphone,
  Workflow,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

import { Avatar, cx, EASE, Reveal, SectionHeading } from '../components/fx';
import { useLang } from '../i18n';

const DIFF_KINDS = ['ctx', 'del', 'add', 'add', 'ctx'] as const;

const TABS: { icon: typeof Inbox; badge?: number; active?: boolean }[] = [
  { icon: LayoutGrid },
  { icon: Workflow },
  { icon: Inbox, badge: 2 },
  { icon: FileDiff, active: true },
  { icon: MoreHorizontal },
];

const POINT_ICONS = [Smartphone, BellRing, MessagesSquare];

function PhoneReview() {
  const reduce = useReducedMotion();
  const [approved, setApproved] = useState(false);
  const { t } = useLang();
  const m = t.mobile;

  // 自动演示：几秒后自己盖章，再复位，循环播放
  useEffect(() => {
    if (reduce) return;
    const id = window.setTimeout(() => setApproved((a) => !a), approved ? 3200 : 2600);
    return () => window.clearTimeout(id);
  }, [approved, reduce]);

  return (
    <div className="relative mx-auto w-[300px] max-w-full sm:w-[320px]">
      <div className="relative rounded-[44px] border border-line-strong bg-gradient-to-b from-raised to-canvas p-2.5 shadow-[0_40px_100px_-30px_rgb(var(--c-shadow)/0.9),inset_0_1px_0_0_rgb(var(--c-ink)/0.08)]">
        <div className="relative flex h-[600px] flex-col overflow-hidden rounded-[36px] bg-canvas">
          {/* 刘海 */}
          <div className="absolute top-2 left-1/2 z-10 h-6 w-24 -translate-x-1/2 rounded-full bg-black" />
          <div className="flex h-11 shrink-0 items-end justify-between px-6 pb-1 font-mono text-[11px] text-fg">
            <span>9:41</span>
            <span className="text-faint">5G</span>
          </div>

          <div className="border-b border-line px-4 py-3">
            <div className="text-[11px] text-faint">{m.phoneMeta}</div>
            <div className="mt-1 text-[15px] font-semibold text-fg">{m.phoneTitle}</div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
              <Avatar name={t.people.zhouInitial} tone="success" size="sm" />
              {m.phoneSeen}
            </div>
          </div>

          <div className="flex-1 overflow-hidden px-3 py-3 font-mono text-[11px] leading-6">
            <div className="overflow-hidden rounded-xl border border-line">
              {DIFF_KINDS.map((k, i) => (
                <div
                  key={i}
                  className={cx(
                    'px-3 break-words',
                    k === 'del' && 'bg-danger/[0.08] text-danger/90',
                    k === 'add' && 'bg-success/[0.08] text-success/90',
                    k === 'ctx' && 'text-faint',
                  )}
                >
                  {k === 'del' ? '− ' : k === 'add' ? '+ ' : '  '}
                  {m.diff[i]}
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-xl border border-line bg-surface p-3 font-sans text-[12px] text-muted">
              <span className="text-fg">{t.people.lin}</span>
              {m.comment}
            </div>
          </div>

          <div className="relative px-4 pb-3">
            <button
              type="button"
              onClick={() => setApproved((a) => !a)}
              className={cx(
                'relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl text-[15px] font-semibold transition-colors duration-500',
                approved
                  ? 'bg-success/15 text-success ring-1 ring-success/40'
                  : 'bg-agent-gradient text-white',
              )}
            >
              <Check className="size-5" />
              {approved ? m.approved : 'LGTM'}
            </button>
            <AnimatePresence>
              {approved ? (
                <motion.div
                  key="stamp"
                  aria-hidden
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 2.4, rotate: -24 }}
                  animate={{ opacity: 1, scale: 1, rotate: -12 }}
                  exit={{ opacity: 0 }}
                  transition={
                    reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 420, damping: 18 }
                  }
                  className="pointer-events-none absolute -top-40 right-6 rounded-xl border-[3px] border-success px-3 py-1 font-mono text-2xl font-black tracking-widest text-success shadow-[0_0_30px_rgb(95_191_130/0.35)]"
                >
                  LGTM
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <nav className="grid shrink-0 grid-cols-5 border-t border-line bg-surface/80 px-1 pt-2 pb-5 backdrop-blur">
            {TABS.map((tab, i) => (
              <div
                key={i}
                className={cx(
                  'relative flex flex-col items-center gap-1 text-[10px]',
                  tab.active ? 'text-agent' : 'text-faint',
                )}
              >
                <tab.icon className="size-5" />
                <span className="max-w-full truncate px-0.5">{m.tabs[i]}</span>
                {tab.badge ? (
                  <span className="absolute -top-1 right-2 flex size-4 items-center justify-center rounded-full bg-danger text-[9px] text-white">
                    {tab.badge}
                  </span>
                ) : null}
              </div>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function Mobile() {
  const m = useLang().t.mobile;
  return (
    <section id="mobile" className="relative scroll-mt-20 overflow-hidden py-16 sm:py-24">
      <div className="mx-auto grid max-w-6xl items-center gap-16 px-5 sm:px-6 lg:grid-cols-2">
        <div className="flex flex-col gap-10">
          <SectionHeading
            center={false}
            eyebrow={m.eyebrow}
            title={[
              { text: m.titleA, br: true },
              { text: m.titleB, gradient: true },
            ]}
            desc={m.desc}
          />
          <div className="flex flex-col gap-5">
            {m.points.map((p, i) => {
              const Icon = POINT_ICONS[i] ?? Smartphone;
              return (
                <Reveal key={i} delay={0.1 * i} className="flex gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-agent">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <h3 className="font-medium text-fg">{p.title}</h3>
                    <p className="mt-1.5 text-sm leading-6 text-muted">{p.desc}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.15 }}
          transition={{ duration: 1, ease: EASE }}
        >
          <PhoneReview />
        </motion.div>
      </div>
    </section>
  );
}
