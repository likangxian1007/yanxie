import {
  BookOpen,
  Bot,
  CalendarClock,
  FileStack,
  FlaskConical,
  GitBranch,
  Globe,
  History,
  Inbox,
  KanbanSquare,
  Link2,
  NotebookPen,
  Play,
  Quote,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode } from 'react';
import { Avatar, cx, EASE, Reveal, SectionHeading, SpotCard, useTicker } from '../components/fx';
import { useLang } from '../i18n';

function Card({
  icon: Icon,
  title,
  desc,
  className,
  children,
  delay = 0,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  className?: string;
  children: ReactNode;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className={cx('min-w-0', className)}>
      <SpotCard className="flex h-full flex-col">
        <div className="relative min-h-[180px] flex-1 overflow-hidden">{children}</div>
        <div className="relative border-t border-line/60 p-5 sm:p-6">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <Icon className="size-4 text-agent" />
            {title}
          </div>
          <p className="mt-1.5 text-[13.5px] leading-6 text-muted">{desc}</p>
        </div>
      </SpotCard>
    </Reveal>
  );
}

function LibraryVisual() {
  const t = useTicker(5, 1500, 3);
  const s = useLang().t.bento.library;
  const answer = s.answer;
  return (
    <div className="flex h-full flex-col gap-3 p-5 sm:p-6">
      <div className="flex items-center gap-2 rounded-xl border border-line bg-canvas/60 p-3">
        <div className="flex h-12 w-9 shrink-0 flex-col gap-1 rounded-sm bg-fg/90 p-1.5">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-[2px] rounded bg-canvas/40" />
          ))}
        </div>
        <div className="min-w-0 text-[12px]">
          <div className="truncate font-medium text-fg">An Image is Worth 16x16 Words</div>
          <div className="truncate text-faint">{s.authors}</div>
        </div>
        <span className="ml-auto hidden shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted sm:inline">
          BibTeX
        </span>
      </div>
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-accent/20 px-3 py-2 text-[12px] text-fg">
        {s.question}
      </div>
      <div className="flex items-start gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-agent-gradient">
          <Sparkles className="size-3 text-white" />
        </span>
        <div className="rounded-2xl rounded-tl-sm border border-line bg-raised px-3 py-2 text-[12px] leading-relaxed text-muted">
          {answer.slice(0, Math.min(answer.length, 12 + t * s.answerStep))}
          <AnimatePresence>
            {t >= 2 && (
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                className="ml-1 inline-flex items-center gap-1 rounded-md bg-agent/20 px-1.5 align-middle font-mono text-[10px] text-agent"
              >
                <Quote className="size-2.5" />
                {s.cite}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {s.chips.map((c, i) => (
          <span
            key={i}
            className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-faint"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

const SLASH_CMDS = ['/goal', '/plan', '/skill', '/model', '/profile', '/compact'] as const;

function SlashVisual() {
  const t = useTicker(SLASH_CMDS.length, 1100, 0);
  const items = useLang().t.bento.slash.items;
  return (
    <div className="flex h-full items-center justify-center p-5 sm:p-6">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-line-strong bg-canvas/90 shadow-2xl">
        <div className="space-y-0.5 p-1.5">
          {SLASH_CMDS.map((cmd, i) => (
            <div
              key={cmd}
              className={cx(
                'relative flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-[12px]',
                i === t ? 'text-fg' : 'text-muted',
              )}
            >
              {i === t && (
                <motion.span
                  layoutId="slash-hl"
                  className="absolute inset-0 rounded-lg bg-accent/15 ring-1 ring-accent/30"
                  transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                />
              )}
              <span className="relative w-16 font-mono text-agent">{cmd}</span>
              <span className="relative truncate">{items[i]}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 border-t border-line px-3 py-2 font-mono text-[12px]">
          <span className="text-agent">/</span>
          <span className="h-3.5 w-[2px] animate-blink bg-fg" />
        </div>
      </div>
    </div>
  );
}

function PlansVisual() {
  const t = useTicker(2, 2200, 0);
  const s = useLang().t.bento.plans;
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 p-5">
      <div className="relative flex rounded-lg border border-line bg-canvas/60 p-0.5 text-[11px]">
        {s.tabs.map((l, i) => (
          <span
            key={i}
            className={cx(
              'relative z-10 flex-1 py-1 text-center transition-colors',
              i === t ? 'text-fg' : 'text-faint',
            )}
          >
            {i === t && (
              <motion.span
                layoutId="plan-tab"
                className="absolute inset-0 -z-10 rounded-md bg-raised ring-1 ring-line-strong"
              />
            )}
            {l}
          </span>
        ))}
      </div>
      {[
        [s.evidenceK, s.evidenceV],
        [s.proposalK, t === 1 ? s.proposalB : s.proposalA],
        [s.memoryK, s.memoryV],
      ].map(([k, v], i) => (
        <div
          key={i}
          className="rounded-lg border border-line bg-raised/70 px-2.5 py-1.5 text-[11px]"
        >
          <span className="text-faint">{k} · </span>
          <span className="text-fg">{v}</span>
        </div>
      ))}
    </div>
  );
}

function InboxVisual() {
  const t = useTicker(4, 1500, 3);
  const s = useLang().t.bento.inbox;
  const items = s.items;
  return (
    <div className="flex h-full flex-col justify-center gap-2 p-5">
      <div className="flex items-center gap-2 text-[12px]">
        <Inbox className="size-4 text-accent" /> {s.title}
        <motion.span
          key={t}
          initial={{ scale: 1.5 }}
          animate={{ scale: 1 }}
          className="ml-auto rounded-full bg-accent px-1.5 font-mono text-[10px] font-semibold text-white"
        >
          {Math.max(t, 1)}
        </motion.span>
      </div>
      {items.map(([k, v], i) => (
        <motion.div
          key={i}
          animate={{ opacity: i < Math.max(t, 1) ? 1 : 0.25, x: i < Math.max(t, 1) ? 0 : 6 }}
          className="flex items-center gap-2 rounded-lg border border-line bg-raised/70 px-2.5 py-1.5 text-[11px]"
        >
          <span className="rounded bg-accent/15 px-1 text-[10px] text-accent">{k}</span>
          <span className="truncate text-muted">{v}</span>
        </motion.div>
      ))}
    </div>
  );
}

function ResearchVisual() {
  const labels = useLang().t.bento.research.nodes;
  const nodes = [
    { x: 8, y: 18, label: labels[0], tone: 'border-sky/40 text-sky' },
    { x: 56, y: 10, label: labels[1], tone: 'border-warning/40 text-warning' },
    { x: 30, y: 60, label: labels[2], tone: 'border-agent/50 text-agent' },
    { x: 64, y: 62, label: labels[3], tone: 'border-success/40 text-success' },
  ];
  return (
    <div className="relative h-full min-h-[200px] p-4">
      <div className="bg-grid absolute inset-0 opacity-60 [background-size:22px_22px]" />
      <svg
        className="absolute inset-0 size-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        {[
          'M 20 26 C 30 40, 30 50, 42 66',
          'M 66 18 C 70 40, 74 48, 76 68',
          'M 48 68 C 56 70, 60 70, 66 68',
        ].map((d, i) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="rgb(77 107 254 / 0.55)"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
            className="beam-path"
            style={{ animationDelay: `${i * 0.6}s`, strokeDasharray: '40 60' }}
          />
        ))}
      </svg>
      {nodes.map((n, i) => (
        <motion.div
          key={i}
          className={cx(
            'absolute rounded-lg border bg-canvas/90 px-2 py-1 text-[10.5px] whitespace-nowrap backdrop-blur',
            n.tone,
          )}
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
          animate={{ y: [0, i % 2 ? -4 : 4, 0] }}
          transition={{ duration: 5 + i, repeat: Infinity, ease: 'easeInOut' }}
        >
          {n.label}
        </motion.div>
      ))}
    </div>
  );
}

function NotebookVisual() {
  const t = useTicker(4, 1400, 3);
  const p = useLang().t.people;
  return (
    <div className="flex h-full flex-col justify-center gap-2 p-5 font-mono text-[10.5px]">
      {[
        ['[3]', 'model = TinyViT(depth=4)'],
        ['[4]', 'trainer.fit(model, dm)'],
      ].map(([n, code], i) => (
        <div key={n} className="flex gap-2 rounded-lg border border-line bg-canvas/70 px-2 py-1.5">
          <span className="text-faint">{i === 1 && t < 3 ? '[*]' : n}</span>
          <span className="truncate text-fg">{code}</span>
        </div>
      ))}
      <div className="flex h-12 items-end gap-1 rounded-lg border border-line bg-raised/60 px-2 pb-1.5">
        {[30, 45, 52, 61, 70, 76, 81, 84].map((h, i) => (
          <motion.span
            key={i}
            className="flex-1 rounded-sm bg-agent-gradient"
            animate={{ height: i <= t * 2 + 1 ? `${h}%` : '6%' }}
            transition={{ duration: 0.6, ease: EASE }}
          />
        ))}
      </div>
      <div className="flex -space-x-1">
        <Avatar name={p.chenInitial} tone="sky" size="sm" />
        <Avatar name={p.zhouInitial} tone="success" size="sm" />
      </div>
    </div>
  );
}

function KanbanVisual() {
  const t = useTicker(2, 2000, 1);
  const s = useLang().t.bento.tasks;
  return (
    <div className="grid h-full grid-cols-3 gap-1.5 p-4 text-[10px]">
      {s.cols.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-1.5 rounded-lg bg-canvas/50 p-1.5">
          <span className="text-faint">{col}</span>
          {ci === 0 && (
            <div className="rounded-md border border-line bg-raised px-1.5 py-1 text-muted">
              {s.todo}
            </div>
          )}
          {ci === t + 1 && (
            <motion.div
              layoutId="kb-card"
              className="rounded-md border border-agent/40 bg-agent/10 px-1.5 py-1 text-fg"
            >
              {s.moving}
            </motion.div>
          )}
          {ci === 2 && (
            <div className="rounded-md border border-line bg-raised px-1.5 py-1 text-muted">
              {s.done}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ProfileVisual() {
  const t = useTicker(3, 1800, 0);
  const s = useLang().t.bento.profile;
  const profiles = s.profiles;
  const sources = ['OpenAlex', 'Semantic Scholar', 'Crossref', 'arXiv'];
  return (
    <div className="flex h-full flex-col justify-center gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap gap-2">
        {profiles.map((p, i) => (
          <span
            key={i}
            className={cx(
              'rounded-full border px-3 py-1 text-[12px] transition-all duration-500',
              i === t
                ? 'border-agent/60 bg-agent/15 text-fg shadow-[0_0_24px_-6px_rgb(77_107_254/0.7)]'
                : 'border-line text-muted',
            )}
          >
            {p}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Globe className="size-3.5 text-sky" />
        {sources.map((s, i) => (
          <motion.span
            key={s}
            animate={{ opacity: [0.45, 1, 0.45] }}
            transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.4 }}
            className="rounded-md bg-sky/10 px-2 py-0.5 text-sky"
          >
            {s}
          </motion.span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-faint">
        {[
          [CalendarClock, s.scheduled],
          [TerminalSquare, 'MCP'],
          [Bot, s.models],
        ].map(([I, l], i) => {
          const Icon = I as LucideIcon;
          return (
            <span
              key={i}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5"
            >
              <Icon className="size-3" /> {l as string}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ShareVisual() {
  const t = useTicker(3, 1500, 2);
  const s = useLang().t.bento.share;
  const levels = s.levels;
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 p-5">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas/60 px-2.5 py-1.5 font-mono text-[10.5px] text-muted">
        <Link2 className="size-3 text-accent" /> <span className="truncate">/s/k9f2…</span>
      </div>
      <div className="flex gap-1">
        {levels.map((l, i) => (
          <span
            key={i}
            className={cx(
              'flex-1 rounded-md py-1 text-center text-[10.5px] transition-colors duration-500',
              i === t ? 'bg-accent text-white' : 'bg-raised text-faint',
            )}
          >
            {l}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px] text-faint">
        {s.roles.map((r, i) => (
          <span key={i} className="rounded border border-line px-1.5">
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

function VersionVisual() {
  const t = useTicker(4, 1300, 3);
  const s = useLang().t.bento.version;
  return (
    <div className="flex h-full flex-col justify-center gap-0 p-5 text-[11px]">
      {s.items.map((v, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <div className="flex flex-col items-center">
            <span
              className={cx(
                'size-2 rounded-full transition-colors duration-500',
                i === t ? 'bg-agent shadow-[0_0_10px_2px_rgb(77_107_254/0.6)]' : 'bg-line-strong',
              )}
            />
            {i < 3 && <span className="h-5 w-px bg-line" />}
          </div>
          <span
            className={cx(
              '-mt-5 truncate transition-colors',
              i === t ? 'text-fg' : 'text-faint',
              i === 3 && 'mt-0',
            )}
          >
            {v}
          </span>
          {i === t && (
            <span className="-mt-5 ml-auto rounded bg-raised px-1 text-[9.5px] text-muted">
              {s.restore}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function Bento() {
  const { t } = useLang();
  const b = t.bento;
  return (
    <section className="relative mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <SectionHeading
        eyebrow={b.eyebrow}
        title={[{ text: b.titleA }, { text: b.titleB, gradient: true, br: true }]}
        desc={b.desc}
      />
      <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card
          className="lg:col-span-2 lg:row-span-2"
          icon={BookOpen}
          title={b.library.title}
          desc={b.library.desc}
        >
          <LibraryVisual />
        </Card>
        <Card
          className="lg:col-span-2"
          icon={TerminalSquare}
          title={b.slash.title}
          desc={b.slash.desc}
          delay={0.05}
        >
          <SlashVisual />
        </Card>
        <Card icon={GitBranch} title={b.plans.title} desc={b.plans.desc} delay={0.1}>
          <PlansVisual />
        </Card>
        <Card icon={Inbox} title={b.inbox.title} desc={b.inbox.desc} delay={0.15}>
          <InboxVisual />
        </Card>
        <Card
          className="lg:col-span-2"
          icon={FlaskConical}
          title={b.research.title}
          desc={b.research.desc}
        >
          <ResearchVisual />
        </Card>
        <Card icon={NotebookPen} title={b.notebook.title} desc={b.notebook.desc} delay={0.05}>
          <NotebookVisual />
        </Card>
        <Card icon={KanbanSquare} title={b.tasks.title} desc={b.tasks.desc} delay={0.1}>
          <KanbanVisual />
        </Card>
        <Card
          className="lg:col-span-2"
          icon={Sparkles}
          title={b.profile.title}
          desc={b.profile.desc}
        >
          <ProfileVisual />
        </Card>
        <Card icon={FileStack} title={b.share.title} desc={b.share.desc} delay={0.05}>
          <ShareVisual />
        </Card>
        <Card icon={History} title={b.version.title} desc={b.version.desc} delay={0.1}>
          <VersionVisual />
        </Card>
      </div>
      <div className="sr-only">
        <Play />
      </div>
    </section>
  );
}
