import { Container, Cpu, Database, Users } from 'lucide-react';

import { Reveal, SectionHeading, SpotCard } from '../components/fx';
import { fmt, useLang } from '../i18n';

const CARDS = [
  { icon: Database, code: 'postgres://srh@db:5432/srh' },
  { icon: Container, code: 'docker compose up -d' },
  { icon: Cpu, code: 'LLM_BASE_URL=https://api.deepseek.com' },
  { icon: Users, code: null },
];

const SHOT_NAMES = ['doc', 'thread', 'review', 'library'];

/** 截图按界面语言分两套：中文在 /shots/，英文在 /shots/en/ */
const shotSrc = (name: string, lang: string) => `/shots/${lang === 'en' ? 'en/' : ''}${name}.webp`;

function BrowserShot({ src, caption, path }: { src: string; caption: string; path: string }) {
  const { t } = useLang();
  return (
    <figure className="w-[85%] shrink-0 snap-center sm:w-[70%] lg:w-auto">
      <div className="overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_80px_-30px_rgb(var(--c-shadow)/0.85)] transition-transform duration-500 hover:-translate-y-1">
        <div className="flex h-8 items-center gap-1.5 border-b border-line px-3">
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="size-2 rounded-full bg-line-strong" />
          <span className="ml-2 min-w-0 flex-1 truncate rounded-md bg-raised px-2 py-0.5 text-center font-mono text-[10px] text-faint">
            {t.brand} · {path}
          </span>
        </div>
        <img
          src={src}
          alt={fmt(t.selfhost.shotAlt, { c: caption })}
          width={1440}
          height={900}
          loading="lazy"
          decoding="async"
          className="block aspect-[16/10] w-full object-cover object-top"
        />
      </div>
      <figcaption className="mt-3 text-center text-sm text-muted">{caption}</figcaption>
    </figure>
  );
}

export function SelfHost() {
  const { t, lang } = useLang();
  const s = t.selfhost;
  return (
    <section id="selfhost" className="relative scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow={s.eyebrow}
          title={[{ text: s.titleA }, { text: s.titleB, gradient: true }]}
          desc={s.desc}
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.map((c, i) => (
            <Reveal key={i} delay={0.08 * i} className="h-full">
              <SpotCard className="flex h-full flex-col p-6">
                <span className="flex size-10 items-center justify-center rounded-xl border border-line-strong bg-raised text-agent">
                  <c.icon className="size-5" />
                </span>
                <h3 className="mt-5 font-medium text-fg">{s.cards[i]?.title}</h3>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted">{s.cards[i]?.desc}</p>
                <code className="mt-5 truncate rounded-lg border border-line bg-canvas/60 px-3 py-1.5 font-mono text-[11px] text-faint">
                  {c.code ?? s.rolesCode}
                </code>
              </SpotCard>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-16 text-center">
          <h3 className="text-silver text-2xl font-semibold tracking-tight sm:text-3xl">
            {s.realTitle}
          </h3>
          <p className="mt-3 text-sm text-muted sm:text-[15px]">{s.realDesc}</p>
        </Reveal>
      </div>
      <Reveal className="mx-auto mt-10 max-w-6xl lg:px-6">
        <div className="scrollbar-none flex snap-x snap-mandatory gap-5 overflow-x-auto px-5 pb-4 sm:px-6 lg:grid lg:grid-cols-2 lg:gap-8 lg:overflow-visible lg:px-0">
          {SHOT_NAMES.map((name, i) => (
            <BrowserShot
              key={name}
              src={shotSrc(name, lang)}
              caption={s.shots[i]?.caption ?? ''}
              path={s.shots[i]?.path ?? ''}
            />
          ))}
        </div>
      </Reveal>
    </section>
  );
}
