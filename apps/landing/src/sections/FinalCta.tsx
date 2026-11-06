import { ArrowRight, ArrowUpRight } from 'lucide-react';

import { Reveal, SplitHeadline } from '../components/fx';
import { ResearchBackdrop } from '../components/ResearchBackdrop';
import { useLang } from '../i18n';
import { APP_URL } from '../links';

export function FinalCta() {
  const { t } = useLang();
  return (
    <section
      aria-label={t.cta.aria}
      className="relative isolate overflow-hidden border-t border-line/60 px-5 pt-16 pb-20 sm:px-6 sm:pt-20 sm:pb-24"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid mask-radial opacity-30" />
        {/* 与首屏同一套科研网络背景；文字区（约 45% 高度处）淡化，上下边缘淡出 */}
        <ResearchBackdrop
          className="absolute inset-0 h-full w-full"
          focusY={0.45}
          focusH={0.32}
          edges="both"
          statsKey="__bgStatsCta"
        />
      </div>
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <SplitHeadline
          as="h2"
          key={t.cta.titleA}
          segments={[
            { text: t.cta.titleA, br: true },
            { text: t.cta.titleB, gradient: true },
          ]}
          className="text-silver text-[40px] leading-[1.08] font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[72px]"
        />
        <Reveal delay={0.15}>
          <p className="mx-auto mt-6 max-w-lg text-[15px] leading-7 text-pretty text-muted sm:text-[17px]">
            {t.cta.desc}
          </p>
        </Reveal>
        <Reveal delay={0.25} className="mt-9 flex flex-col items-center gap-4 sm:flex-row sm:gap-7">
          <a href={APP_URL} className="group btn-primary h-12 px-7 text-[15px]">
            {t.openApp}
            <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
          <a href="#how" className="group link-quiet min-h-11 text-[15px]">
            {t.cta.secondary}
            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" />
          </a>
        </Reveal>
        <Reveal delay={0.32}>
          <p className="mt-8 font-mono text-[11.5px] tracking-wide text-faint">{t.cta.note}</p>
        </Reveal>
      </div>
    </section>
  );
}
