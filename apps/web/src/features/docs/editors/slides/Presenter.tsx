import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, NotebookText, Pause, Play, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useElementSize } from '../shared/dom';
import type { SlideRef } from './model/deck';
import { useSlide } from './model/hooks';
import type { DeckInfo } from './model/types';
import { SlideRender } from './render/SlideRender';
import { tr } from '@/lib/i18n';

interface PresenterProps {
  slides: SlideRef[];
  deck: DeckInfo;
  startIndex: number;
  onClose: (lastIndex: number) => void;
}

/**
 * 放映：全屏（Fullscreen API，失败时就是 fixed 覆盖层）黑底居中画布。
 * ←/→/空格/PageUp/PageDown/点击翻页，Home/End 首尾，N 切换演讲者备注，P 暂停 / 继续计时，R 计时归零，Esc 退出。
 * 只用 token：背景在亮色主题取 --fg（近黑）、暗色主题取 --canvas（近黑），用 light-dark() 选择。
 */
const STAGE_BG = 'light-dark(var(--fg), var(--canvas))';
const STAGE_FG = 'light-dark(var(--fg-inverse), var(--fg))';

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 放映计时：开始放映就走，可暂停 / 继续 / 归零 */
function useTimer() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    if (!running) return;
    // 每次跳动按真实流逝的时间累加（标签页在后台时计时器变慢也不会少算）
    let last = Date.now();
    const t = window.setInterval(() => {
      const now = Date.now();
      const d = now - last;
      last = now;
      setElapsed((e) => e + d);
    }, 250);
    return () => window.clearInterval(t);
  }, [running]);
  return {
    elapsed,
    running,
    toggle: () => setRunning((r) => !r),
    reset: () => setElapsed(0),
  };
}

function PresenterSlide({
  slide,
  deck,
  width,
}: {
  slide: SlideRef;
  deck: DeckInfo;
  width: number;
}) {
  const model = useSlide(slide, deck);
  if (!model) return null;
  return (
    <SlideRender
      elements={model.elements}
      bg={model.bg}
      deck={deck}
      width={width}
      className="rounded-sm shadow-lg"
    />
  );
}

function NotesText({ slide, deck }: { slide: SlideRef; deck: DeckInfo }) {
  const model = useSlide(slide, deck);
  return <>{model?.notes.trim() || tr('这一页没有备注。')}</>;
}

export function Presenter({ slides, deck, startIndex, onClose }: PresenterProps) {
  const timer = useTimer();
  const timerRef = useRef(timer);
  useEffect(() => {
    timerRef.current = timer;
  });
  const [index, setIndex] = useState(() => Math.max(0, Math.min(startIndex, slides.length - 1)));
  const [showNotes, setShowNotes] = useState(false);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const { variants } = useMotionPreset();
  const indexRef = useRef(index);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    indexRef.current = index;
    onCloseRef.current = onClose;
  });

  const count = slides.length;
  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const slide = slides[safeIndex];

  // 进入全屏；用户用浏览器自己的方式退出全屏时一起退出放映
  useEffect(() => {
    if (!rootEl) return;
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement === rootEl) entered = true;
      else if (entered) onCloseRef.current(indexRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    if (typeof rootEl.requestFullscreen === 'function') {
      rootEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
        // 不支持或被拒绝：保持 fixed 覆盖层
      });
    }
    rootEl.focus();
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === rootEl) void document.exitFullscreen().catch(() => {});
    };
  }, [rootEl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          e.preventDefault();
          setIndex((i) => Math.min(count - 1, i + 1));
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault();
          setIndex((i) => Math.max(0, i - 1));
          break;
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(count - 1);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          setShowNotes((v) => !v);
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          timerRef.current.toggle();
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          timerRef.current.reset();
          break;
        case 'Escape':
          e.preventDefault();
          onCloseRef.current(indexRef.current);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [count]);

  // 按页面比例适配舞台
  const pad = 48;
  const availW = Math.max(0, stage.width - pad * 2);
  const availH = Math.max(0, stage.height - pad * 2);
  const width = Math.min(availW, (availH * deck.width) / deck.height);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={setRootEl}
      role="dialog"
      aria-modal="true"
      aria-label={tr('放映幻灯片')}
      tabIndex={-1}
      className="fixed inset-0 z-modal flex flex-col outline-none select-none"
      style={{ background: STAGE_BG, color: STAGE_FG }}
    >
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const back = e.clientX < rect.left + rect.width * 0.25;
          setIndex((i) => (back ? Math.max(0, i - 1) : Math.min(count - 1, i + 1)));
        }}
      >
        <div className="absolute inset-0 grid place-items-center">
          <AnimatePresence mode="wait" initial={false}>
            {slide && width > 0 && (
              <motion.div
                key={slide.id}
                variants={variants.fadeUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ width }}
              >
                <PresenterSlide slide={slide} deck={deck} width={width} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          aria-label={tr('退出放映')}
          onClick={(e) => {
            e.stopPropagation();
            onClose(safeIndex);
          }}
          className="absolute top-4 right-4 grid size-9 cursor-pointer place-items-center rounded-md opacity-50 transition-opacity duration-(--dur-fast) hover:opacity-100"
        >
          <X size={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <AnimatePresence>
        {showNotes && slide && (
          <motion.div
            variants={variants.fadeUp}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute inset-x-0 bottom-14 mx-auto w-[min(760px,calc(100%-32px))] rounded-lg border border-line bg-elevated/95 px-4 py-3 text-prose text-fg shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-caption text-fg-subtle">{tr('演讲者备注')}</p>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap">
              <NotesText slide={slide} deck={deck} />
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex h-12 shrink-0 items-center gap-3 px-4 text-small">
        <button
          type="button"
          aria-label={tr('上一页')}
          disabled={safeIndex === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          className="grid size-8 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100 disabled:cursor-default disabled:opacity-20"
        >
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="tabular-nums opacity-80" aria-live="polite">
          {safeIndex + 1} / {count}
        </span>
        <button
          type="button"
          aria-label={tr('下一页')}
          disabled={safeIndex >= count - 1}
          onClick={() => setIndex((i) => Math.min(count - 1, i + 1))}
          className="grid size-8 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100 disabled:cursor-default disabled:opacity-20"
        >
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
        </button>
        <div
          className="relative mx-2 h-0.5 flex-1 overflow-hidden rounded-full"
          style={{ background: 'color-mix(in oklab, currentColor 18%, transparent)' }}
        >
          <div
            className="absolute inset-0 origin-left rounded-full bg-accent transition-transform duration-(--dur-slow) ease-(--ease-out)"
            style={{ transform: `scaleX(${count ? (safeIndex + 1) / count : 0})` }}
          />
        </div>
        <button
          type="button"
          aria-pressed={showNotes}
          onClick={() => setShowNotes((v) => !v)}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 opacity-60 hover:opacity-100',
            showNotes && 'opacity-100',
          )}
        >
          <NotebookText size={16} strokeWidth={1.75} aria-hidden />
          {tr('备注 ')}
          <kbd className="font-mono text-caption opacity-70">N</kbd>
        </button>
        <span className="flex items-center gap-1">
          <span
            className="min-w-12 text-right tabular-nums opacity-80"
            aria-label={tr('已放映时间')}
            role="timer"
          >
            {formatElapsed(timer.elapsed)}
          </span>
          <button
            type="button"
            aria-label={timer.running ? tr('暂停计时') : tr('继续计时')}
            onClick={timer.toggle}
            className="grid size-8 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100"
          >
            {timer.running ? (
              <Pause size={16} strokeWidth={1.75} aria-hidden />
            ) : (
              <Play size={16} strokeWidth={1.75} aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label={tr('计时归零')}
            onClick={timer.reset}
            className="grid size-8 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100"
          >
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </span>
        <span className="hidden text-caption opacity-50 lg:inline">
          {tr('← → 翻页 · P 暂停计时 · Esc 退出')}
        </span>
      </div>
    </div>,
    document.body,
  );
}
