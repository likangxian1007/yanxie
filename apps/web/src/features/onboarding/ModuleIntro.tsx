import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { Link, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ChevronUp, X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { duration, ease, useMotionPreset } from '@/lib/motion';
import { useCoarsePointer, useIsMobile } from '@/lib/use-media-query';
import { introForPath, introHow, type ModuleIntro } from './module-intros';
import { moduleIntroEnabled, readIntroRecord, shouldShowIntro, writeIntroRecord } from './storage';
import { tr } from '@/lib/i18n';

interface Visit {
  /** 这次进入的标识（路径 + 序号） */
  key: string;
  intro: ModuleIntro | null;
  show: boolean;
}

/** 同一次进入只计一次（StrictMode 会把 effect 跑两遍） */
const counted = new Set<string>();
let visitSeq = 0;

function computeVisit(pathname: string, userId: string): Visit {
  const intro = introForPath(pathname);
  const show =
    intro !== null &&
    moduleIntroEnabled() &&
    shouldShowIntro(readIntroRecord(userId, intro.module));
  visitSeq += 1;
  return { key: `${pathname}#${visitSeq}`, intro, show };
}

export interface ModuleIntroFrameProps {
  projectId: string;
  userId: string;
  children: ReactNode;
}

/**
 * 模块页顶部的“这是什么、怎么用”。在外壳里挂一次，按当前路径的第一段决定内容；
 * 每个模块对每个用户自动出现 3 次，点“不再显示”后不再出现。
 * 收起时介绍条淡出并脱离文档流，下面的页面用 layout 动画平滑上移（只动 transform）。
 */
export function ModuleIntroFrame({ projectId, userId, children }: ModuleIntroFrameProps) {
  const { pathname } = useLocation();
  const { spring } = useMotionPreset();
  const [visit, setVisit] = useState<Visit>(() => computeVisit(pathname, userId));
  const [visitPath, setVisitPath] = useState(pathname);
  const [collapseTick, setCollapseTick] = useState(0);

  // 换了页面：重新决定这一次要不要展示（渲染期间按 props 调整 state，不会先闪一帧旧内容）
  if (visitPath !== pathname) {
    setVisitPath(pathname);
    setVisit(computeVisit(pathname, userId));
  }

  // 记一次展示
  useEffect(() => {
    if (!visit.show || !visit.intro) return;
    const id = `${userId}:${visit.key}`;
    if (counted.has(id)) return;
    counted.add(id);
    const record = readIntroRecord(userId, visit.intro.module);
    writeIntroRecord(userId, visit.intro.module, { ...record, views: record.views + 1 });
  }, [visit, userId]);

  const dismiss = () => {
    const intro = visit.intro;
    if (!intro) return;
    const record = readIntroRecord(userId, intro.module);
    writeIntroRecord(userId, intro.module, { ...record, dismissed: true });
    setVisit((v) => ({ ...v, show: false }));
    setCollapseTick((n) => n + 1);
  };

  return (
    <>
      {/* 每次进入页面一个新的 AnimatePresence：换页时旧的介绍条随页面直接离开，只有“不再显示”时才播收起动画 */}
      <AnimatePresence key={visit.key} mode="popLayout">
        {visit.show && visit.intro && (
          <IntroStrip
            key={visit.intro.module}
            intro={visit.intro}
            projectId={projectId}
            onDismiss={dismiss}
          />
        )}
      </AnimatePresence>
      <motion.div
        layout="position"
        layoutDependency={collapseTick}
        transition={spring.gentle}
        className="flex flex-1 flex-col"
      >
        {children}
      </motion.div>
    </>
  );
}

/** AnimatePresence 的 popLayout 需要拿到 DOM ref（React 19 里 ref 是普通 prop） */
function IntroStrip({
  intro,
  projectId,
  onDismiss,
  ref,
}: {
  intro: ModuleIntro;
  projectId: string;
  onDismiss: () => void;
  ref?: Ref<HTMLElement> | undefined;
}) {
  const { variants, reduced } = useMotionPreset();
  const mobile = useIsMobile();
  const touch = useCoarsePointer();
  // 手机上默认只占一行（标题 + 一句话 +「了解」），点「了解」才展开成完整卡片
  const [expanded, setExpanded] = useState(false);
  const Icon = intro.icon;
  const headingId = `module-intro-${intro.module || 'home'}`;
  const how = introHow(intro, touch);
  return (
    <motion.section
      ref={ref}
      aria-labelledby={headingId}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      exit={{
        opacity: 0,
        ...(reduced ? {} : { y: -4 }),
        transition: { duration: duration.fast, ease: ease.in },
      }}
      className="w-full px-4 pt-3 md:px-6 md:pt-6 lg:px-8"
      data-module-intro={intro.module || 'home'}
    >
      {mobile && !expanded ? (
        <div
          data-module-intro-compact=""
          className="mx-auto flex w-full items-center gap-2 rounded-lg border border-line bg-surface py-1 pr-1 pl-3 shadow-xs"
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-text" />
          <p className="min-w-0 flex-1 truncate text-small text-fg-muted">
            <span id={headingId} className="font-medium text-fg">
              {intro.label}
            </span>
            {tr('：')}
            {intro.what}
          </p>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
            className="shrink-0 px-2 text-accent-text"
          >
            {tr('了解')}
          </Button>
          <IconButton label={tr('知道了，不再显示')} size="sm" onClick={onDismiss}>
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      ) : (
        <div
          className={cn(
            'mx-auto w-full rounded-lg border border-line bg-surface py-3.5 pr-2 pl-4 shadow-xs sm:py-4',
            intro.width,
          )}
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 hidden size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text sm:grid"
            >
              <Icon size={16} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h2 id={headingId} className="text-h3 text-fg">
                  {tr('{label}是什么', { label: intro.label })}
                </h2>
                <Link
                  to={`${projectPath(projectId, 'help')}#${intro.anchor}`}
                  className="group inline-flex items-center gap-1 rounded-xs text-small text-accent-text hover:underline"
                >
                  {tr('了解更多')}
                  <ArrowRight
                    size={13}
                    strokeWidth={1.75}
                    aria-hidden
                    className="transition-transform duration-(--dur-fast) ease-(--ease-standard) group-hover:translate-x-0.5"
                  />
                </Link>
              </div>
              <p className="mt-0.5 text-small text-pretty text-fg-muted">{intro.what}</p>
              <ol
                aria-label={tr('怎么用')}
                className={cn(
                  'mt-3 grid gap-x-5 gap-y-1.5',
                  how.length === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2',
                )}
              >
                {how.map((line, i) => (
                  <li key={line} className="flex items-start gap-2 text-small text-fg-muted">
                    <span
                      aria-hidden
                      className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-subtle text-caption text-fg-subtle tabular-nums ring-1 ring-line"
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 text-pretty">{line}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="-mt-1 flex shrink-0 flex-col items-center gap-1">
              <IconButton label={tr('知道了，不再显示')} size="md" onClick={onDismiss}>
                <X strokeWidth={1.75} aria-hidden />
              </IconButton>
              {mobile && (
                <IconButton
                  label={tr('收起介绍')}
                  size="md"
                  aria-expanded
                  onClick={() => setExpanded(false)}
                >
                  <ChevronUp strokeWidth={1.75} aria-hidden />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.section>
  );
}
