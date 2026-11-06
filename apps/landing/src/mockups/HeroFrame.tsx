import {
  BookOpen,
  CheckCheck,
  ClipboardList,
  FileText,
  FlaskConical,
  Inbox,
  Layers,
  MessagesSquare,
  Presentation,
  Sparkles,
  SquareUser,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { Beams, useRefs } from '../components/beams';
import { Avatar, cx, EASE, useTicker } from '../components/fx';
import { fmt, useLang } from '../i18n';

const NAV = [
  { icon: MessagesSquare, active: true },
  { icon: SquareUser },
  { icon: FileText },
  { icon: Layers },
  { icon: FlaskConical },
  { icon: BookOpen },
  { icon: ClipboardList },
  { icon: Presentation },
  { icon: Inbox, badge: 3 },
] as { icon: typeof Inbox; active?: boolean; badge?: number }[];

// 线程标题与 Agent 名来自 i18n 字典（frame.threads / frame.agents），按下标对应
export const THREADS = [
  { done: 4, total: 5, tone: 'sky' as const },
  { done: 2, total: 6, tone: 'agent' as const },
  { done: 0, total: 4, tone: 'success' as const },
];

function Bubble({
  delay,
  children,
  className,
}: {
  delay: number;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

export function ThreadCard({
  t,
  index,
  live,
  compact,
}: {
  t: (typeof THREADS)[number];
  index: number;
  live: number;
  compact?: boolean;
}) {
  const { t: d } = useLang();
  const title = d.frame.threads[index] ?? '';
  const agent = d.frame.agents[index] ?? '';
  // live 让进度条轻微推进，像真的在跑
  const extra = index === 1 ? live % 3 : index === 0 ? live % 2 : 0;
  const done = Math.min(t.done + extra, t.total);
  const pct = (done / t.total) * 100;
  const running = done < t.total && (index !== 2 || live % 4 > 1);
  return (
    <div
      className={cx(
        'relative rounded-xl border border-line bg-raised/90 backdrop-blur',
        compact ? 'p-2.5' : 'p-3',
      )}
    >
      <div className="flex items-center gap-2">
        <Avatar name={agent.slice(0, 1)} tone="agent" size="sm" />
        <span className="truncate text-[12px] font-medium text-fg">{title}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
          <motion.div
            className="h-full rounded-full bg-agent-gradient"
            animate={{ width: `${Math.max(pct, 4)}%` }}
            transition={{ duration: 1.2, ease: EASE }}
          />
        </div>
        <span className="font-mono text-[10px] text-faint tabular-nums">
          {done}/{t.total}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-muted">
        {running ? (
          <>
            <span className="mobile-static inline-block animate-spin-slow text-agent">✱</span>
            <span className="shimmer-text">{fmt(d.frame.running, { a: agent })}</span>
          </>
        ) : done === t.total ? (
          <>
            <CheckCheck className="size-3 text-success" />
            <span>{d.frame.doneReview}</span>
          </>
        ) : (
          <>
            <span className="text-faint">○</span>
            <span>{d.frame.queued}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function HeroFrame() {
  const container = useRef<HTMLDivElement>(null);
  const coord = useRef<HTMLDivElement>(null);
  const targets = useRefs<HTMLDivElement>(3);
  const live = useTicker(12, 1600, 3);
  const { t: d } = useLang();
  const p = d.people;

  return (
    <div className="glow-border rounded-[20px] bg-canvas">
      <div className="relative overflow-hidden rounded-[20px] border border-line-strong bg-surface shadow-[0_30px_80px_-30px_rgb(var(--c-shadow)/0.5)]">
        {/* 顶栏 */}
        <div className="flex h-10 items-center gap-3 border-b border-line bg-canvas/60 px-4">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]/80" />
            <span className="size-2.5 rounded-full bg-[#febc2e]/80" />
            <span className="size-2.5 rounded-full bg-[#28c840]/80" />
          </div>
          <div className="min-w-0 flex-1 truncate text-center text-[11px] text-faint">
            {d.frame.topbar}
          </div>
          <div className="hidden -space-x-1.5 sm:flex">
            <Avatar name={p.linInitial} tone="warning" size="sm" />
            <Avatar name={p.chenInitial} tone="sky" size="sm" />
            <Avatar name={p.zhouInitial} tone="success" size="sm" />
          </div>
        </div>

        <div className="flex h-[440px] sm:h-[520px]">
          {/* 侧栏 */}
          <aside className="hidden w-44 shrink-0 flex-col gap-0.5 border-r border-line bg-canvas/40 p-3 lg:flex">
            <div className="mb-3 flex items-center gap-2 px-2">
              <img src="/favicon.svg" alt="" width={20} height={20} className="size-5" />
              <span className="text-[13px] font-semibold">{d.brand}</span>
            </div>
            {NAV.map(({ icon: Icon, active, badge }, i) => (
              <div
                key={i}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]',
                  active ? 'bg-accent/15 text-fg' : 'text-muted',
                )}
              >
                <Icon className={cx('size-3.5', active && 'text-accent')} />
                <span className="flex-1 truncate">{d.frame.nav[i]}</span>
                {badge ? (
                  <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
                    {badge}
                  </span>
                ) : null}
              </div>
            ))}
          </aside>

          {/* 对话 + 线程 */}
          <div ref={container} className="relative flex min-w-0 flex-1">
            <div className="relative z-10 flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
              <Bubble delay={0.9} className="flex items-start gap-2.5">
                <Avatar name={p.linInitial} tone="warning" />
                <div className="min-w-0">
                  <div className="text-[11px] text-faint">{d.frame.linRole}</div>
                  <div className="mt-1 rounded-2xl rounded-tl-sm border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-fg">
                    {d.frame.ask}
                  </div>
                </div>
              </Bubble>

              <Bubble delay={1.5} className="flex items-start gap-2.5">
                <div className="relative">
                  <span className="absolute inset-0 animate-pulse-ring rounded-full bg-agent/40" />
                  <span className="relative flex size-7 items-center justify-center rounded-full bg-agent-gradient">
                    <Sparkles className="size-3.5 text-white" />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-faint">{d.frame.coordMeta}</div>
                  <div
                    ref={coord}
                    className="mt-1 rounded-2xl rounded-tl-sm border border-agent/30 bg-agent/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-fg"
                  >
                    {d.frame.coordReply}
                  </div>
                  {/* 小屏：线程直接内嵌在消息中 */}
                  <div className="mt-2 grid gap-2 md:hidden">
                    {THREADS.slice(0, 2).map((t, i) => (
                      <ThreadCard key={i} t={t} index={i} live={live} compact />
                    ))}
                  </div>
                </div>
              </Bubble>

              <Bubble
                delay={2.1}
                className="ml-9 max-w-sm rounded-xl border border-warning/30 bg-warning/[0.06] p-3"
              >
                <div className="text-[11px] font-medium text-warning">{d.frame.decision}</div>
                <div className="mt-1 text-[12px] text-fg">{d.frame.decisionQ}</div>
                <div className="mt-2 flex gap-2">
                  <span className="rounded-md bg-fg px-2 py-0.5 text-[11px] font-medium text-canvas">
                    {d.frame.include}
                  </span>
                  <span className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted">
                    {d.frame.exclude}
                  </span>
                </div>
              </Bubble>

              <div className="mt-auto flex items-center gap-2 rounded-xl border border-line bg-canvas/60 px-3 py-2.5">
                <span className="font-mono text-[12px] text-agent">/</span>
                <span className="text-[12px] text-faint">{d.frame.input}</span>
                <span className="ml-auto hidden rounded-md border border-line px-1.5 py-0.5 text-[10px] text-faint sm:inline">
                  {d.frame.effort}
                </span>
              </div>
            </div>

            {/* 线程面板 */}
            <div className="relative z-10 hidden w-[42%] max-w-[300px] shrink-0 flex-col justify-center gap-3 border-l border-line/60 bg-canvas/30 p-4 md:flex">
              <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
                <span>{d.frame.threadsPanel}</span>
                <span className="font-mono">3</span>
              </div>
              {THREADS.map((t, i) => (
                <motion.div
                  key={i}
                  ref={targets[i]}
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.9, ease: EASE, delay: 2.0 + i * 0.18 }}
                >
                  <ThreadCard t={t} index={i} live={live} />
                </motion.div>
              ))}
            </div>
            <div className="hidden md:block">
              <Beams container={container} from={coord} to={targets} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
