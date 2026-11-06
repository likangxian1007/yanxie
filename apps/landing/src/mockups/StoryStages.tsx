import {
  AlertTriangle,
  AtSign,
  Brain,
  CalendarRange,
  FileCheck2,
  GitPullRequestArrow,
  Sparkles,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { Beams, useRefs } from '../components/beams';
import { Avatar, cx, EASE, useTicker } from '../components/fx';
import { useLang } from '../i18n';
import { THREADS, ThreadCard } from './HeroFrame';

export function StageShell({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface/95 shadow-[0_30px_80px_-30px_rgb(var(--c-shadow)/0.8)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-[11.5px]">
        <span className="font-medium text-fg">{title}</span>
        {meta ? <span className="truncate text-faint">· {meta}</span> : null}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

/* 1 · 协调者拆解 */
export function PlanStage() {
  const box = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const targets = useRefs<HTMLDivElement>(3);
  const { t: d } = useLang();
  const s = d.stages.plan;
  return (
    <StageShell title={s.title} meta={s.meta}>
      <div ref={box} className="relative flex h-full items-center gap-6 p-5 sm:gap-10 sm:p-7">
        <div className="relative z-10 flex w-[42%] flex-col gap-3">
          <div
            ref={hub}
            className="rounded-2xl border border-agent/40 bg-agent/[0.08] p-3.5 shadow-[0_0_40px_-10px_rgb(77_107_254/0.6)]"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-agent-gradient">
                <Sparkles className="size-3.5 text-white" />
              </span>
              <span className="text-[13px] font-semibold">{s.coordinator}</span>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{s.coordDesc}</p>
          </div>
          {s.memory.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 + i * 0.12, ease: EASE, duration: 0.7 }}
              className="flex items-center gap-2 rounded-lg border border-line bg-canvas/60 px-2.5 py-1.5 text-[11px] text-muted"
            >
              <Brain className="size-3 text-agent" />
              {m}
            </motion.div>
          ))}
        </div>
        <div className="relative z-10 flex flex-1 flex-col gap-3">
          {d.frame.agents.map((a, i) => (
            <motion.div
              key={i}
              ref={targets[i]}
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.5 + i * 0.15, ease: EASE, duration: 0.8 }}
              className="rounded-xl border border-line bg-raised p-2.5"
            >
              <div className="flex items-center gap-2 text-[11.5px] font-medium">
                <Avatar name={a.slice(0, 1)} tone="agent" size="sm" />
                <span className="truncate">{d.frame.threads[i]}</span>
              </div>
            </motion.div>
          ))}
        </div>
        <Beams container={box} from={hub} to={targets} />
      </div>
    </StageShell>
  );
}

/* 2 · 线程并行 */
export function ThreadStage() {
  const { t: d } = useLang();
  const s = d.stages.thread;
  const CHECK = s.checks;
  const step = useTicker(CHECK.length + 2, 1100, CHECK.length);
  const live = useTicker(12, 1600, 3);
  return (
    <StageShell title={s.title} meta={d.frame.threads[0]}>
      <div className="flex h-full flex-col gap-4 p-5 sm:flex-row sm:p-6">
        <div className="flex-1">
          <div className="text-[11px] tracking-wide text-faint">{s.checklist}</div>
          <ul className="mt-3 space-y-2.5">
            {CHECK.map((c, i) => {
              const state = i < step ? 'done' : i === step ? 'run' : 'todo';
              return (
                <li key={i} className="flex items-center gap-2.5 text-[12.5px]">
                  <span
                    className={cx(
                      'flex size-5 items-center justify-center rounded-full border text-[11px] transition-colors duration-500',
                      state === 'done' && 'border-success/50 bg-success/15 text-success',
                      state === 'run' && 'border-agent/60 text-agent',
                      state === 'todo' && 'border-line text-faint',
                    )}
                  >
                    {state === 'done' ? (
                      '✱'
                    ) : state === 'run' ? (
                      <span className="mobile-static inline-block animate-spin-slow">✱</span>
                    ) : (
                      '○'
                    )}
                  </span>
                  <span
                    className={cx(
                      'transition-colors duration-500',
                      state === 'todo' ? 'text-faint' : 'text-fg',
                      state === 'done' && 'text-muted line-through decoration-line-strong',
                    )}
                  >
                    {c}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-5 text-[11px] tracking-wide text-faint">{s.outputs}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {s.files.map((o, i) => (
              <motion.span
                key={i}
                animate={{ opacity: step > i + 1 ? 1 : 0.35 }}
                className="rounded-md border border-line bg-canvas/60 px-2 py-1 font-mono text-[10.5px] text-muted"
              >
                {o}
              </motion.span>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2.5 sm:w-[44%]">
          <div className="text-[11px] tracking-wide text-faint">{s.alsoRunning}</div>
          {THREADS.map((t, i) => (
            <ThreadCard key={i} t={t} index={i} live={live} compact />
          ))}
        </div>
      </div>
    </StageShell>
  );
}

/* 3 · 文档协同 */
export function DocStage() {
  const t = useTicker(8, 1300, 5);
  const { t: d } = useLang();
  const s = d.stages.doc;
  const p = d.people;
  return (
    <StageShell title={s.title} meta={s.meta}>
      <div className="relative h-full overflow-hidden px-6 py-5 text-[12.5px] leading-[1.9] text-muted sm:px-8">
        <div className="mb-2 text-[15px] font-semibold text-fg">{s.heading}</div>
        <p>
          {s.p1a}
          <span className="rounded-sm bg-sky/20 text-fg">{s.p1hl}</span>
          <span className="relative inline-block h-4 w-px translate-y-0.5 bg-sky">
            <span className="absolute -top-5 left-0 rounded bg-sky px-1 text-[9.5px] leading-4 whitespace-nowrap text-canvas">
              {p.chen}
            </span>
          </span>
          {s.p1b}
        </p>
        <div className="relative mt-2 rounded-lg border border-dashed border-agent/50 bg-agent/[0.05] p-2.5">
          <span className="absolute -top-2.5 left-3 flex items-center gap-1 rounded-full bg-agent-gradient px-2 text-[10px] leading-5 text-white">
            <Sparkles className="size-2.5" /> {s.claimed}
          </span>
          <span className="text-fg">{s.typed.slice(0, 10 + t * s.typeStep)}</span>
          <span className="ml-px inline-block h-3.5 w-[2px] translate-y-0.5 animate-blink bg-agent" />
        </div>
        <p className="mt-2">
          {s.p2a}
          <span className="relative">
            {s.p2term}
            <span className="absolute -top-0.5 -right-1 h-4 w-px bg-warning" />
            <span className="absolute -top-5 left-10 rounded bg-warning px-1 text-[9.5px] leading-4 whitespace-nowrap text-canvas">
              {p.lin}
            </span>
          </span>
          {s.p2b}
        </p>
        <AnimatePresence>
          {t >= 3 && (
            <motion.div
              key="warn"
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.6, ease: EASE }}
              className="absolute right-4 bottom-16 left-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-canvas/95 p-3 shadow-xl backdrop-blur sm:left-auto sm:w-72"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <div className="text-[11.5px] leading-snug">
                <div className="font-medium text-fg">{s.conflict}</div>
                <div className="text-muted">{s.conflictDesc}</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="absolute right-4 bottom-4 left-4 flex items-center gap-2 rounded-lg border border-line bg-raised/90 px-3 py-2 text-[11.5px]">
          <AtSign className="size-3.5 text-accent" />
          <span className="text-fg">{s.mention}</span>
          <span className="truncate text-muted">{s.mentionMsg}</span>
        </div>
      </div>
    </StageShell>
  );
}

/* 4 · 审阅 LGTM */
export function ReviewStage() {
  const t = useTicker(6, 1200, 4);
  const approved = t >= 3;
  const { t: d } = useLang();
  const s = d.stages.review;
  const p = d.people;
  return (
    <StageShell title={s.title} meta={s.meta}>
      <div className="relative flex h-full flex-col gap-3 p-5 sm:p-6">
        <div className="flex items-center gap-2 text-[12px]">
          <GitPullRequestArrow className="size-4 text-accent" />
          <span className="font-medium">{s.proposed}</span>
          <span className="ml-auto font-mono text-[10.5px] text-success">+38</span>
          <span className="font-mono text-[10.5px] text-danger">−2</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-line font-mono text-[11px] leading-6">
          <div className="bg-danger/[0.08] px-3 text-danger/90">− {s.del}</div>
          <div className="bg-success/[0.08] px-3 text-success/90">+ {s.add1}</div>
          <div className="px-3 text-faint"> {s.ctx}</div>
          <div className="bg-success/[0.08] px-3 text-success/90">+ {s.add2}</div>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-canvas/50 p-3">
          <Avatar name={p.zhouInitial} tone="success" size="sm" />
          <div className="text-[11.5px] text-muted">
            <span className="text-fg">{p.zhou}</span> {s.comment}
          </div>
        </div>
        <div className="mt-auto flex items-center gap-3 rounded-xl border border-line bg-raised p-3">
          <Avatar name={p.linInitial} tone="warning" />
          <div className="text-[12px]">
            <div className="font-medium">{s.verdict}</div>
            <div className="text-faint">{s.linRole}</div>
          </div>
          <motion.span
            animate={approved ? { scale: [1, 0.92, 1] } : {}}
            className={cx(
              'ml-auto rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors duration-500',
              approved ? 'bg-success text-canvas' : 'border border-success/50 text-success',
            )}
          >
            LGTM
          </motion.span>
          <span className="hidden rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted sm:inline">
            {s.requestChanges}
          </span>
        </div>
        <AnimatePresence>
          {approved && (
            <motion.div
              key="stamp"
              initial={{ opacity: 0, scale: 2.4, rotate: -24 }}
              animate={{ opacity: 1, scale: 1, rotate: -12 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 16 }}
              className="pointer-events-none absolute top-[34%] right-6 flex flex-col items-center rounded-xl border-[3px] border-success px-4 py-1.5 text-success shadow-[0_0_40px_-6px_rgb(95_191_130/0.6)] sm:right-12"
            >
              <span className="text-2xl font-black tracking-widest">LGTM</span>
              <span className="text-[9px] tracking-[0.3em]">{s.allPassed}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </StageShell>
  );
}

/* 5 · 组会汇报 */
export function ReportStage() {
  const { t: d } = useLang();
  const s = d.stages.report;
  const REPORT = s.lines;
  const t = useTicker(REPORT.length + 3, 1000, REPORT.length);
  return (
    <StageShell title={s.title} meta={s.meta}>
      <div className="flex h-full flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas/60 px-2.5 py-1.5 text-fg">
            <CalendarRange className="size-3.5 text-accent" /> {s.range}
          </span>
          {s.stats.map((x, i) => (
            <span key={i} className="rounded-lg border border-line px-2 py-1.5 text-muted">
              {x}
            </span>
          ))}
        </div>
        <div className="flex-1 rounded-xl border border-line bg-canvas/50 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <FileCheck2 className="size-4 text-agent" /> {s.heading}
          </div>
          <ul className="mt-3 space-y-2.5">
            {REPORT.map((r, i) => (
              <motion.li
                key={i}
                animate={{
                  opacity: i < t ? 1 : 0,
                  y: i < t ? 0 : 6,
                }}
                transition={{ duration: 0.6, ease: EASE }}
                className="flex gap-2 text-[12px] leading-relaxed text-muted"
              >
                <span className="mt-2 size-1 shrink-0 rounded-full bg-agent" />
                {r}
              </motion.li>
            ))}
          </ul>
          {t < REPORT.length ? (
            <div className="mt-3 h-2 w-2/3 animate-shimmer rounded-full bg-[linear-gradient(90deg,var(--c-line),var(--c-line-strong),var(--c-line))] bg-[length:200%_100%]" />
          ) : null}
        </div>
      </div>
    </StageShell>
  );
}
