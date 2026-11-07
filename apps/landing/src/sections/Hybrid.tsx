import { ArrowDown, ArrowRight, Cloud, Cpu, RefreshCw, ShieldCheck } from 'lucide-react';

import { cx, Reveal, SectionHeading, SpotCard, useTicker } from '../components/fx';
import { useLang } from '../i18n';

/**
 * 本地 + 云端混合 AI（服务端见 apps/server/src/agents/llm/hybrid.ts，PDF 翻译见 modules/pdf-translate）。
 * 只用 opacity / 颜色过渡，不用模糊与指针特效（微信 X5）。
 */

type Seg = { t: string; s?: boolean };

function Segs({ segs, tone }: { segs: Seg[]; tone: 'raw' | 'mask' }) {
  return (
    <>
      {segs.map((g, i) =>
        g.s ? (
          <span
            key={i}
            className={cx(
              'rounded px-1 font-medium',
              tone === 'raw' ? 'bg-success/15 text-success' : 'bg-accent/15 text-agent',
            )}
          >
            {g.t}
          </span>
        ) : (
          <span key={i}>{g.t}</span>
        ),
      )}
    </>
  );
}

function Arrow() {
  return (
    <div aria-hidden className="flex items-center justify-center text-faint">
      <ArrowDown className="size-4 lg:hidden" />
      <ArrowRight className="hidden size-4 lg:block" />
    </div>
  );
}

function RoundTrip() {
  const h = useLang().t.hybrid;
  const active = useTicker(3, 2200, 2);
  const steps = [
    { label: h.trip.steps[0], where: h.trip.local, body: <Segs segs={h.trip.raw} tone="raw" /> },
    {
      label: h.trip.steps[1],
      where: h.trip.cloud,
      body: <Segs segs={h.trip.masked} tone="mask" />,
    },
    { label: h.trip.steps[2], where: h.trip.local, body: <span>{h.trip.restored}</span> },
  ];
  return (
    <SpotCard className="glow-border p-5 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium text-fg">
          <ShieldCheck className="size-4 text-agent" />
          {h.trip.title}
        </h3>
        <span className="font-mono text-[11px] text-faint">{h.trip.meta}</span>
      </div>
      <div className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        {steps.map((s, i) => (
          <div key={i} className="contents">
            {i > 0 ? <Arrow /> : null}
            <div
              className={cx(
                'rounded-2xl border bg-canvas/60 p-4 transition-colors duration-500',
                active === i ? 'border-accent/70' : 'border-line',
              )}
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-fg">{s.label}</span>
                <span
                  className={cx(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
                    i === 1 ? 'bg-raised text-muted' : 'bg-success/15 text-success',
                  )}
                >
                  {i === 1 ? <Cloud className="size-3" /> : <Cpu className="size-3" />}
                  {s.where}
                </span>
              </div>
              <p className="mt-3 text-[15px] leading-7 break-words text-fg">{s.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-2xl border border-line">
        <div className="border-b border-line px-4 py-2 text-xs text-muted">{h.trip.mapTitle}</div>
        <ul className="grid grid-cols-1 gap-x-6 px-4 py-2 font-mono text-[12px] sm:grid-cols-2">
          {h.trip.map.map(([k, v]) => (
            <li key={k} className="flex min-w-0 items-center gap-2 py-1">
              <span className="shrink-0 text-agent">{k}</span>
              <span className="text-faint">→</span>
              <span className="truncate text-fg">{v}</span>
            </li>
          ))}
        </ul>
      </div>
    </SpotCard>
  );
}

const ROUTE_ICONS = [Cpu, Cloud, RefreshCw];

function Shot({
  src,
  alt,
  caption,
  w,
  hgt,
}: {
  src: string;
  alt: string;
  caption: string;
  w: number;
  hgt: number;
}) {
  return (
    <figure className="flex h-full flex-col">
      <div className="overflow-hidden rounded-2xl border border-line-strong bg-surface">
        <img
          src={src}
          alt={alt}
          width={w}
          height={hgt}
          loading="lazy"
          decoding="async"
          className="block aspect-[7/6] w-full object-cover object-top"
        />
      </div>
      <figcaption className="mt-3 text-sm leading-6 text-muted">{caption}</figcaption>
    </figure>
  );
}

export function Hybrid() {
  const h = useLang().t.hybrid;
  return (
    <section id="hybrid" className="relative scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow={h.eyebrow}
          title={[{ text: h.titleA }, { text: h.titleB, gradient: true }]}
          desc={h.desc}
        />
        <Reveal className="mt-10 lg:mt-12">
          <RoundTrip />
        </Reveal>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {h.routes.map((r, i) => {
            const Icon = ROUTE_ICONS[i] ?? Cpu;
            return (
              <Reveal key={i} delay={0.08 * i} className="h-full">
                <SpotCard className="flex h-full flex-col p-5 sm:p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-raised text-agent">
                      <Icon className="size-4" />
                    </span>
                    <h3 className="font-medium text-fg">{r.title}</h3>
                  </div>
                  <p className="mt-3 font-mono text-[11px] leading-5 text-faint">{r.meta}</p>
                  <p className="mt-3 text-sm leading-6 text-muted">{r.desc}</p>
                  <ul className="mt-4 flex flex-wrap gap-1.5">
                    {r.items.map((it) => (
                      <li
                        key={it}
                        className="rounded-full border border-line bg-canvas/60 px-2.5 py-1 text-xs text-muted"
                      >
                        {it}
                      </li>
                    ))}
                  </ul>
                </SpotCard>
              </Reveal>
            );
          })}
        </div>
        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <Reveal className="min-w-0">
            <h3 className="font-medium text-fg">{h.dash.title}</h3>
            <p className="mt-2 mb-4 text-sm leading-6 text-muted">{h.dash.desc}</p>
            <Shot
              src="/shots/hybrid-dashboard.webp"
              alt={h.dash.alt}
              caption={h.dash.caption}
              w={782}
              hgt={674}
            />
          </Reveal>
          <Reveal delay={0.08} className="min-w-0">
            <h3 className="font-medium text-fg">{h.pdf.title}</h3>
            <p className="mt-2 mb-4 text-sm leading-6 text-muted">{h.pdf.desc}</p>
            <Shot
              src="/shots/pdf-translate.webp"
              alt={h.pdf.alt}
              caption={h.pdf.caption}
              w={856}
              hgt={744}
            />
          </Reveal>
        </div>
        <Reveal className="mt-10">
          <p className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface/60 px-5 py-4 text-center text-sm leading-6 text-muted">
            {h.note}
          </p>
        </Reveal>
      </div>
    </section>
  );
}
