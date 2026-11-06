import { useRef, useState, type MouseEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, MessageSquareQuote } from 'lucide-react';
import type { Review } from '@srh/shared';
import { Button, Markdown, Skeleton, Tabs } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { useCurrentTargetContent, usePreviousRound } from '../api';

type ContentMode = 'snapshot' | 'previous' | 'current';
import { normalizeQuote } from '../lib/review-state';
import { hasCurrentContent, TARGET_KIND_LABEL } from '../lib/target';
import { DiffView } from './DiffView';
import { tr } from '@/lib/i18n';

export interface ReviewContentProps {
  pid: string;
  review: Review;
  /** 选中文字后点“引用评论” */
  onQuote?: (quote: string) => void;
}

/**
 * “内容”页签：渲染发起时的快照；文档 / 实验 / 汇报可切到“对比当前版本”看行级 diff。
 * 选中一段文字会浮出“引用评论”。
 */
export function ReviewContent({ pid, review, onQuote }: ReviewContentProps) {
  const { variants } = useMotionPreset();
  const boxRef = useRef<HTMLDivElement>(null);
  const previous = usePreviousRound(pid, review);
  const prevSnapshot = previous.data?.snapshot ?? null;
  // 有上一轮快照时默认就看「这一轮改了什么」，导师不用从头重读
  const [chosen, setMode] = useState<ContentMode | null>(null);
  const mode: ContentMode = chosen ?? (prevSnapshot && review.snapshot ? 'previous' : 'snapshot');
  const compare = mode === 'current';
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const comparable = hasCurrentContent(review.targetKind, review.targetId);
  const snapshot = review.snapshot;
  // 没有快照时直接显示当前内容
  const needCurrent = comparable && (compare || !snapshot);
  const current = useCurrentTargetContent(pid, review.targetKind, review.targetId, needCurrent);

  const updateSelection = (e?: MouseEvent) => {
    if (!onQuote) return;
    const box = boxRef.current;
    const sel = window.getSelection();
    if (!box || !sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const text = normalizeQuote(sel.toString());
    if (!text) {
      setSelection(null);
      return;
    }
    const r = range.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const rawX = r.width > 0 ? r.left - b.left + r.width / 2 : (e?.clientX ?? b.left) - b.left;
    const x = Math.min(Math.max(rawX, 56), Math.max(56, b.width - 56));
    const y = Math.max(r.top - b.top, 0);
    setSelection({ text, x, y });
  };

  let body;
  if (mode === 'previous' && snapshot && prevSnapshot) {
    body = <DiffView before={prevSnapshot} after={snapshot} />;
  } else if (compare && snapshot) {
    body = current.isPending ? (
      <ContentSkeleton />
    ) : current.isError ? (
      <LoadError
        onRetry={() => void current.refetch()}
        kind={TARGET_KIND_LABEL[review.targetKind]}
      />
    ) : (
      <DiffView before={snapshot} after={current.data ?? ''} />
    );
  } else if (snapshot) {
    body = <Markdown>{snapshot}</Markdown>;
  } else if (comparable) {
    body = (
      <>
        <p className="mb-3 rounded-md bg-subtle px-3 py-2 text-small text-fg-muted">
          {tr('发起时没有保存快照，下面是{value}的当前内容。', {
            value: TARGET_KIND_LABEL[review.targetKind],
          })}
        </p>
        {current.isPending ? (
          <ContentSkeleton />
        ) : current.isError ? (
          <LoadError
            onRetry={() => void current.refetch()}
            kind={TARGET_KIND_LABEL[review.targetKind]}
          />
        ) : current.data?.trim() ? (
          <Markdown>{current.data}</Markdown>
        ) : (
          <p className="text-small text-fg-subtle">{tr('内容是空的。')}</p>
        )}
      </>
    );
  } else {
    body = (
      <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
        {tr('这个审阅没有内容快照，请通过上方链接查看{value}本身。', {
          value: TARGET_KIND_LABEL[review.targetKind],
        })}
      </p>
    );
  }

  return (
    <div>
      {snapshot && (comparable || prevSnapshot) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-caption font-normal text-fg-subtle">
            {mode === 'current'
              ? tr('对比：发起审阅时 → 当前版本')
              : mode === 'previous'
                ? tr('对比：上一轮审阅时 → 这一轮发起时')
                : tr('发起审阅时的快照')}
          </p>
          <Tabs
            variant="segmented"
            size="sm"
            aria-label={tr('内容视图')}
            layoutId="review-content-mode"
            value={mode}
            onValueChange={(v) => {
              setMode(v);
              setSelection(null);
            }}
            items={[
              { value: 'snapshot' as const, label: tr('快照') },
              ...(prevSnapshot ? [{ value: 'previous' as const, label: tr('对比上一轮') }] : []),
              ...(comparable ? [{ value: 'current' as const, label: tr('对比当前版本') }] : []),
            ]}
          />
        </div>
      )}
      <div
        ref={boxRef}
        className="relative"
        onMouseUp={updateSelection}
        onKeyUp={() => updateSelection()}
      >
        {body}
        <AnimatePresence>
          {selection && onQuote && (
            <motion.div
              key="quote"
              variants={variants.scaleIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="absolute z-popover -translate-x-1/2 -translate-y-full pb-1.5"
              style={{ left: selection.x, top: selection.y }}
            >
              <Button
                size="sm"
                variant="primary"
                className="shadow-md"
                leftIcon={<MessageSquareQuote strokeWidth={1.75} aria-hidden />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onQuote(selection.text);
                  setSelection(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                {tr('引用评论')}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ContentSkeleton() {
  return (
    <div role="status" aria-label={tr('正在加载内容')} className="flex flex-col gap-2">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function LoadError({ kind, onRetry }: { kind: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-danger-soft px-3 py-2.5 text-small text-danger">
      <AlertTriangle size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">
        {tr('{kind}的当前版本没有加载出来，可能已被删除或你没有权限。', { kind })}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {tr('重试')}
      </Button>
    </div>
  );
}
