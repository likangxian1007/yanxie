import { KeyRound, Network, ShieldCheck, Terminal } from 'lucide-react';
import { motion } from 'motion/react';

import { EASE, Reveal, SectionHeading, SpotCard, useTicker } from '../components/fx';
import { useLang } from '../i18n';

/** 研协服务端的入站 MCP 端点与 API 令牌前缀（见 apps/server/src/modules/mcp） */
const MCP_PATH = '/api/v1/mcp';
const TOKEN_PREFIX = 'srh_pat_';

type Tok = { t: string; c?: string };
type TermText = { termComment1: string; termComment2: string; termDone: string };

/** 终端演示的行（注释与完成提示来自 i18n 字典；行数与语言无关） */
function buildLines(a: TermText): Tok[][] {
  return [
    [{ t: a.termComment1, c: 'text-faint' }],
    [
      { t: '$ ', c: 'text-success' },
      { t: 'claude mcp add --transport http srh \\', c: 'text-fg' },
    ],
    [{ t: `    https://co.thinkloft.io${MCP_PATH} \\`, c: 'text-sky' }],
    [{ t: `    --header "Authorization: Bearer ${TOKEN_PREFIX}…"`, c: 'text-agent' }],
    [{ t: ' ' }],
    [{ t: a.termComment2, c: 'text-faint' }],
    [{ t: '{', c: 'text-muted' }],
    [{ t: '  "mcpServers": {', c: 'text-muted' }],
    [{ t: '    "srh": {', c: 'text-muted' }],
    [
      { t: '      "url": ', c: 'text-muted' },
      { t: `"https://co.thinkloft.io${MCP_PATH}"`, c: 'text-sky' },
      { t: ',', c: 'text-muted' },
    ],
    [
      { t: '      "headers": { ', c: 'text-muted' },
      { t: '"Authorization"', c: 'text-fg' },
      { t: ': ', c: 'text-muted' },
      { t: `"Bearer ${TOKEN_PREFIX}…"`, c: 'text-agent' },
      { t: ' }', c: 'text-muted' },
    ],
    [{ t: '    }', c: 'text-muted' }],
    [{ t: '  }', c: 'text-muted' }],
    [{ t: '}', c: 'text-muted' }],
    [{ t: a.termDone, c: 'text-success' }],
  ];
}

const POINT_ICONS = [ShieldCheck, KeyRound, Network];

function TerminalCard() {
  const a = useLang().t.agents;
  const LINES = buildLines(a);
  const tick = useTicker(LINES.length + 8, 380, LINES.length + 7);
  const shown = Math.min(tick + 1, LINES.length);
  return (
    <SpotCard className="glow-border relative min-w-0">
      <div className="flex h-10 items-center gap-2 border-b border-line px-4">
        <span className="size-2.5 rounded-full bg-danger/70" />
        <span className="size-2.5 rounded-full bg-warning/70" />
        <span className="size-2.5 rounded-full bg-success/70" />
        <span className="ml-3 inline-flex items-center gap-1.5 font-mono text-[11px] text-faint">
          <Terminal className="size-3.5" /> ~/my-research
        </span>
      </div>
      <pre
        aria-label={a.termAria}
        className="scrollbar-none min-h-[380px] overflow-x-auto p-4 font-mono text-[11.5px] leading-6 sm:p-5 sm:text-[12.5px]"
      >
        {LINES.map((line, i) => (
          <motion.div
            key={i}
            initial={false}
            animate={{ opacity: i < shown ? 1 : 0, x: i < shown ? 0 : -6 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="whitespace-pre"
          >
            {line.map((tok, j) => (
              <span key={j} className={tok.c}>
                {tok.t}
              </span>
            ))}
            {i === shown - 1 && shown < LINES.length ? (
              <span className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-fg/70" />
            ) : null}
          </motion.div>
        ))}
      </pre>
    </SpotCard>
  );
}

export function ExternalAgents() {
  const { t } = useLang();
  const a = t.agents;
  return (
    <section id="agents" className="relative scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow={a.eyebrow}
          title={[{ text: a.titleA }, { text: a.titleB, gradient: true }]}
          desc={a.desc}
        />
        <div className="mt-10 grid items-center gap-8 lg:mt-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-12">
          <Reveal className="min-w-0">
            <TerminalCard />
          </Reveal>
          <div className="flex flex-col gap-4">
            {a.points.map((p, i) => {
              const Icon = POINT_ICONS[i] ?? ShieldCheck;
              return (
                <Reveal key={i} delay={0.1 * i}>
                  <div className="flex gap-4 rounded-2xl border border-line/70 bg-surface/40 p-5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-agent">
                      <Icon className="size-5" />
                    </span>
                    <div>
                      <h3 className="font-medium text-fg">{p.title}</h3>
                      <p className="mt-1.5 text-sm leading-6 text-muted">{p.desc}</p>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
