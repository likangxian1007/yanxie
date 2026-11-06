import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { animate, AnimatePresence, motion, useMotionValue } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  FileText,
  Inbox,
  ListTree,
  MapPin,
  MessagesSquare,
  Presentation,
  Search,
  Smartphone,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { useFocusTrap } from '@/components/layout/focus-trap';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { placeCard, sheetDock, spotlightRect, type Rect, type Side, type Size } from './geometry';
import { Spotlight } from './Spotlight';
import { useTourStore, type ActiveTour } from './tour-store';
import { localizeStep, stepsFor, type StepIcon } from './tour-steps';
import { useCoarsePointer } from '@/lib/use-media-query';
import { useTourTarget } from './use-tour-target';
import { tr } from '@/lib/i18n';

const ICONS: Record<StepIcon, LucideIcon> = {
  coordinator: MessagesSquare,
  threads: ListTree,
  workspace: UserRound,
  docs: FileText,
  reviews: BadgeCheck,
  reports: Presentation,
  inbox: Inbox,
  search: Search,
  phone: Smartphone,
};

/** 桌面卡片宽度 */
const CARD_W = 340;
/** < 768px 用贴边的底部卡片（STYLE §5 的移动端断点） */
const MOBILE_MAX = 767;

const ORIGIN: Record<Side, string> = {
  right: 'left center',
  left: 'right center',
  bottom: 'center top',
  top: 'center bottom',
  center: 'center',
};

function useViewport(): Size {
  const [size, setSize] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** 新手引导浮层：压暗 + 高亮目标 + 旁边的说明卡片。挂在外壳里，没有进行中的引导时什么都不渲染。 */
export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {active && <TourLayer key={`${active.projectId}:${active.variant}`} tour={active} />}
    </AnimatePresence>,
    document.body,
  );
}

function TourLayer({ tour }: { tour: ActiveTour }) {
  const steps = stepsFor(tour.variant);
  // 触屏设备上不讲 ⌘K、? 这类键盘快捷键
  const touch = useCoarsePointer();
  const rawStep = steps[tour.step];
  const step = rawStep ? localizeStep(rawStep, touch) : undefined;
  const total = steps.length;
  const isLast = tour.step === total - 1;
  const next = useTourStore((s) => s.next);
  const prev = useTourStore((s) => s.prev);
  const skip = useTourStore((s) => s.skip);
  const { variants, spring, reduced } = useMotionPreset();
  const viewport = useViewport();
  const mobile = viewport.w <= MOBILE_MAX;
  const stepKey = `${tour.variant}:${step?.id ?? ''}`;
  // 传原始步骤（引用稳定）：目标选择器两种文案都一样，换文案不需要重新找目标
  const target = useTourTarget(rawStep, tour.projectId, stepKey);

  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState<Size | null>(null);

  // 焦点锁在卡片里；Esc = 跳过引导
  useFocusTrap(cardRef, true, skip);

  // 打开时与每一步：焦点放在主按钮上，回车就能继续
  useEffect(() => {
    const t = window.setTimeout(() => primaryRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, [tour.step]);

  // ← / → 切换步骤
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, prev]);

  // 量卡片尺寸（offsetWidth 不受入场缩放影响）
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      setCardSize((prevSize) => {
        const size = { w: el.offsetWidth, h: el.offsetHeight };
        return prevSize && prevSize.w === size.w && prevSize.h === size.h ? prevSize : size;
      });
    };
    const frame = window.requestAnimationFrame(measure);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, [mobile]);

  const targetRect = target?.rect ?? null;
  const hole: Rect | null = useMemo(
    () => (targetRect ? spotlightRect(targetRect, viewport) : null),
    [targetRect, viewport],
  );
  const ready = target !== null && cardSize !== null;
  const placement = placeCard(hole, cardSize ?? { w: CARD_W, h: 220 }, viewport);
  const dock = sheetDock(hole, viewport);
  const animateMove = target?.reason === 'step';

  // 桌面卡片位置：第一次直接放到位（还看不见），之后换步骤时用 spring.gentle 跟过去
  const cardX = useMotionValue(placement.x);
  const cardY = useMotionValue(placement.y);
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!ready) return;
    if (!placed.current || !animateMove || reduced) {
      placed.current = true;
      cardX.set(placement.x);
      cardY.set(placement.y);
      return;
    }
    const ax = animate(cardX, placement.x, spring.gentle);
    const ay = animate(cardY, placement.y, spring.gentle);
    return () => {
      ax.stop();
      ay.stop();
    };
  }, [ready, placement.x, placement.y, animateMove, reduced, spring.gentle, cardX, cardY]);

  if (!step) return null;
  const Icon = ICONS[step.icon];
  const showWhere = target !== null && target.kind !== 'target' && Boolean(step.where);
  const announce = tr('第 {value} 步，共 {total} 步。{title}。{body}{value2}', {
    value: tour.step + 1,
    total,
    title: step.title,
    body: step.body,
    value2: showWhere ? step.where : '',
  });
  const buttonSize = mobile ? 'lg' : 'sm';

  const content = (
    <>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'grid shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text',
            mobile ? 'size-9' : 'size-8',
          )}
        >
          <Icon size={16} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p aria-hidden className="text-caption text-fg-subtle tabular-nums">
            {tour.step + 1} / {total}
          </p>
          {/* 换步骤时文字淡入（重新挂载，不留空白帧，卡片高度不会先塌再撑开） */}
          <motion.h2
            key={step.id}
            id={titleId}
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            className="text-h3 text-pretty text-fg"
          >
            {step.title}
          </motion.h2>
        </div>
      </div>
      <motion.div key={step.id} variants={variants.fadeIn} initial="hidden" animate="visible">
        <p id={bodyId} className="mt-2.5 text-body text-pretty text-fg-muted">
          {step.body}
        </p>
        {showWhere && (
          <p className="mt-2 flex items-start gap-1.5 text-small text-fg-muted">
            <MapPin
              size={14}
              strokeWidth={1.75}
              aria-hidden
              className="mt-[3px] shrink-0 text-accent-text"
            />
            <span className="text-pretty">{step.where}</span>
          </p>
        )}
      </motion.div>

      <div aria-hidden className="mt-4 flex gap-1">
        {steps.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-(--dur-base) ease-(--ease-standard)',
              i <= tour.step ? 'bg-accent' : 'bg-muted',
            )}
          />
        ))}
      </div>

      <div className={cn('flex items-center gap-2', mobile ? 'mt-5' : 'mt-4')}>
        {!isLast && (
          <Button
            variant="ghost"
            size={buttonSize}
            onClick={skip}
            className={cn('-ml-2', mobile && 'h-11 px-3')}
          >
            {tr('跳过引导')}
          </Button>
        )}
        <span className="flex-1" />
        {tour.step > 0 && (
          <Button
            variant="secondary"
            size={buttonSize}
            onClick={prev}
            leftIcon={mobile ? undefined : <ArrowLeft strokeWidth={1.75} aria-hidden />}
            className={cn(mobile && 'h-11 px-3.5')}
          >
            {tr('上一步')}
          </Button>
        )}
        <Button
          ref={primaryRef}
          variant="primary"
          size={buttonSize}
          onClick={next}
          rightIcon={isLast || mobile ? undefined : <ArrowRight strokeWidth={1.75} aria-hidden />}
          className={cn(mobile && 'h-11 px-4')}
        >
          {isLast ? tr('开始使用') : tr('下一步')}
        </Button>
      </div>
    </>
  );

  const dialogProps = {
    ref: cardRef,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': bodyId,
    tabIndex: -1,
    'data-tour-card': '',
  } as const;

  return (
    <motion.div
      className="fixed inset-0 z-modal"
      variants={variants.fadeIn}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <Spotlight hole={hole} animateMove={animateMove} />

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>

      {mobile ? (
        <div
          className={cn(
            'pointer-events-none fixed inset-x-0 flex justify-center px-3',
            dock === 'bottom'
              ? 'bottom-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]'
              : 'top-0 pt-[max(env(safe-area-inset-top),0.75rem)]',
          )}
        >
          <motion.div
            {...dialogProps}
            variants={variants.fadeUp}
            initial="hidden"
            animate={ready ? 'visible' : 'hidden'}
            className="pointer-events-auto w-full max-w-[480px] rounded-xl border border-line bg-elevated p-4 shadow-lg outline-none"
          >
            {content}
          </motion.div>
        </div>
      ) : (
        <motion.div
          className="fixed top-0 left-0"
          style={{ x: cardX, y: cardY, width: `min(${CARD_W}px, calc(100vw - 24px))` }}
        >
          <motion.div
            {...dialogProps}
            variants={variants.scaleIn}
            initial="hidden"
            animate={ready ? 'visible' : 'hidden'}
            style={{ transformOrigin: ORIGIN[placement.side] }}
            className="rounded-xl border border-line bg-elevated p-4 shadow-lg outline-none"
          >
            {content}
          </motion.div>
        </motion.div>
      )}
    </motion.div>
  );
}
