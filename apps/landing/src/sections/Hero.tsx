import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

import { EASE, Eyebrow, SplitHeadline } from '../components/fx';
import { ResearchBackdrop } from '../components/ResearchBackdrop';
import { APP_URL } from '../links';
import { useLang } from '../i18n';
import { HeroFrame } from '../mockups/HeroFrame';

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-grid mask-radial opacity-40" />
      <ResearchBackdrop className="absolute inset-0 h-full w-full" />
    </div>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const { t } = useLang();

  return (
    <section id="top" className="relative isolate overflow-hidden pt-28 pb-12 sm:pt-36 sm:pb-16">
      <Backdrop />
      <div className="mx-auto flex max-w-6xl flex-col items-center px-5 text-center sm:px-6">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE }}
        >
          <Eyebrow>{t.hero.eyebrow}</Eyebrow>
        </motion.div>
        <SplitHeadline
          as="h1"
          delay={0.05}
          stagger={0.02}
          key={t.hero.h1a}
          segments={[
            { text: t.hero.h1a, br: true },
            { text: t.hero.h1b, gradient: true },
          ]}
          className="text-silver mt-7 text-[40px] leading-[1.08] font-semibold tracking-[-0.035em] sm:text-6xl lg:text-[80px]"
        />
        <motion.p
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.35 }}
          className="mt-7 max-w-2xl text-[15px] leading-7 text-muted sm:text-lg sm:leading-8"
        >
          {t.hero.desc}
        </motion.p>
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.45 }}
          className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
        >
          <a href={APP_URL} className="group btn-primary h-12 px-6 text-[15px]">
            {t.openApp}
            <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
          <a
            href="#how"
            className="inline-flex h-12 items-center gap-2 rounded-xl border border-line-strong bg-canvas px-6 text-[15px] text-fg transition-colors duration-200 hover:border-faint/60 hover:bg-surface"
          >
            {t.hero.secondary}
            <ArrowDown className="size-4 text-muted" />
          </a>
        </motion.div>
      </div>

      {/* 首屏产品图挂载即淡入，不用 whileInView：矮屏上它在首屏以下，等视口触发会长时间整块空白 */}
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.25 }}
        className="mx-auto mt-12 max-w-6xl px-3 sm:mt-16 sm:px-6"
      >
        <HeroFrame />
      </motion.div>
    </section>
  );
}
