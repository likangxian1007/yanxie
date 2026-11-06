import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ComponentType } from 'react';

import { cx, EASE, Reveal, SectionHeading } from '../components/fx';
import { useLang } from '../i18n';
import { DocStage, PlanStage, ReportStage, ReviewStage, ThreadStage } from '../mockups/StoryStages';

interface Step {
  title: string;
  desc: string;
}

// 舞台组件与文案按下标对应（文案来自 i18n 字典）
const STAGES: ComponentType[] = [PlanStage, ThreadStage, DocStage, ReviewStage, ReportStage];

function StepItem({
  step,
  index,
  active,
  onActive,
}: {
  step: Step;
  index: number;
  active: boolean;
  onActive: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-40% 0px -50% 0px' });
  useEffect(() => {
    if (inView) onActive(index);
  }, [inView, index, onActive]);

  return (
    <div ref={ref} className="flex min-h-[42vh] items-center">
      <div
        className={cx(
          'relative border-l-2 py-2 pl-6 transition-[opacity,border-color] duration-300',
          active ? 'border-agent opacity-100' : 'border-line opacity-55',
        )}
      >
        <div className="font-mono text-xs tracking-widest text-faint">
          {String(index + 1).padStart(2, '0')} / {String(STAGES.length).padStart(2, '0')}
        </div>
        <h3
          className={cx(
            'mt-3 text-2xl font-semibold tracking-tight transition-colors duration-500 xl:text-3xl',
            active ? 'text-fg' : 'text-muted',
          )}
        >
          {step.title}
        </h3>
        <p className="mt-3 max-w-md text-[15px] leading-7 text-muted">{step.desc}</p>
      </div>
    </div>
  );
}

export function Story() {
  const reduce = useReducedMotion();
  const { t } = useLang();
  const steps: Step[] = t.story.steps;
  const [active, setActive] = useState(0);
  const ActiveStage = STAGES[active] ?? PlanStage;

  return (
    <section id="how" className="relative scroll-mt-20 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <SectionHeading
          eyebrow={t.story.eyebrow}
          title={[{ text: t.story.titleA }, { text: t.story.titleB, gradient: true }]}
          desc={t.story.desc}
        />

        {/* 桌面：左侧步骤随滚动高亮，右侧舞台吸顶常驻；切换时新旧舞台重叠交叉淡入，不留空帧 */}
        <div className="mt-10 hidden grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-14 lg:grid">
          <div className="py-[4vh]">
            {steps.map((s, i) => (
              <StepItem key={i} step={s} index={i} active={active === i} onActive={setActive} />
            ))}
          </div>
          <div className="relative">
            <div className="sticky top-[calc(50vh-260px)] h-[520px]">
              <AnimatePresence initial={false}>
                <motion.div
                  key={active}
                  initial={reduce ? { opacity: 1 } : { opacity: 0.6, y: 10 }}
                  animate={{ opacity: 1, y: 0, zIndex: 1 }}
                  exit={{ opacity: 0, zIndex: 0, transition: { duration: 0.25 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="absolute inset-0"
                >
                  <ActiveStage />
                </motion.div>
              </AnimatePresence>
              <div className="absolute -bottom-10 left-0 flex gap-2">
                {STAGES.map((_, i) => (
                  <span
                    key={i}
                    className={cx(
                      'h-1 rounded-full transition-[opacity,border-color] duration-300',
                      i === active ? 'w-8 bg-agent' : 'w-3 bg-line-strong',
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 移动端：步骤与舞台成对堆叠 */}
        <div className="mt-10 flex flex-col gap-12 lg:hidden">
          {steps.map((s, i) => {
            const Stage = STAGES[i] ?? PlanStage;
            return (
              <Reveal key={i} className="flex flex-col gap-5">
                <div className="border-l-2 border-agent pl-5">
                  <div className="font-mono text-xs tracking-widest text-faint">
                    {String(i + 1).padStart(2, '0')} / {String(STAGES.length).padStart(2, '0')}
                  </div>
                  <h3 className="mt-2 text-xl font-semibold tracking-tight text-fg sm:text-2xl">
                    {s.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-7 text-muted">{s.desc}</p>
                </div>
                <div className="min-w-0">
                  <Stage />
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
