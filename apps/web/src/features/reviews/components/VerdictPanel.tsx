import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { MessageSquare, PencilLine } from 'lucide-react';
import type { ReviewParticipant } from '@srh/shared';
import { Button, Card, Textarea, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useMotionPreset } from '@/lib/motion';
import { useSubmitVerdict, type VerdictSubmit } from '../api';
import { VERDICT_LABEL } from '../lib/review-state';
import { useSoftKeyboardOpen } from '../lib/use-soft-keyboard-open';
import { LgtmButton } from './LgtmButton';
import { tr } from '@/lib/i18n';

export interface VerdictPanelProps {
  pid: string;
  reviewId: string;
  me: ReviewParticipant;
}

const DONE_TOAST: Record<VerdictSubmit['verdict'], string> = {
  lgtm: tr('已 LGTM'),
  changes_requested: tr('已要求修改'),
  commented: tr('意见已发出'),
};

/**
 * 结论按钮那一行滚出屏幕了吗（手机上看内容时用来显示吸底操作条）。
 * 元素本身没显示（桌面和手机各渲染一份面板，其中一份是 display:none）时一律算“没滚出去”。
 */
function useScrolledAway(ref: React.RefObject<HTMLElement | null>): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const shown = entry.target.getClientRects().length > 0;
        // 露出不到一半（大半被顶栏盖住或已滚走）就算看不见了
        setAway(shown && entry.intersectionRatio < 0.5);
      },
      // 顶栏 52px 挡住的部分不算看得见
      { rootMargin: '-52px 0px 0px 0px', threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return away;
}

/** 审阅人给结论：LGTM / 要求修改 / 仅评论，可附一句说明 */
export function VerdictPanel({ pid, reviewId, me }: VerdictPanelProps) {
  const noteId = useId();
  const hintId = useId();
  const submit = useSubmitVerdict(pid, reviewId);
  const { variants } = useMotionPreset();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<VerdictSubmit['verdict'] | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const away = useScrolledAway(actionsRef);
  // 正在写评论 / 说明（软键盘弹起、底部标签栏收起）时吸底条也让位，不压在输入框上
  const keyboardOpen = useSoftKeyboardOpen();
  // 点了「要求修改」但还没写原因：提示必填，不提交
  const [needReason, setNeedReason] = useState(false);
  const missingReason = needReason && !note.trim();

  /** 回到结论卡片，把光标放进说明框 */
  const focusNote = () => {
    cardRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => noteRef.current?.focus({ preventScroll: true }), 350);
  };

  const send = (verdict: VerdictSubmit['verdict']) => {
    if (verdict === 'commented' && !note.trim()) {
      toast({
        tone: 'warning',
        title: tr('先写下你的意见'),
        description: tr('“仅评论”需要附一段说明。'),
      });
      return;
    }
    // 「要求修改」必须写一句原因，否则对方不知道要改什么
    if (verdict === 'changes_requested' && !note.trim()) {
      setNeedReason(true);
      focusNote();
      return;
    }
    setPending(verdict);
    submit.mutate(
      { verdict, ...(note.trim() ? { comment: note.trim() } : {}) },
      {
        onSuccess: () => {
          setNote('');
          setNeedReason(false);
          toast.success(DONE_TOAST[verdict]);
        },
        onError: (err) =>
          toast.error(
            tr('结论没有提交成功'),
            err instanceof ApiRequestError ? err.message : tr('请稍后再试。'),
          ),
        onSettled: () => setPending(null),
      },
    );
  };

  // 手机：看内容、翻评论时结论按钮滚出了屏幕，就在底部标签栏上方吸一条操作栏（lg 以上结论卡片常驻右栏）
  const bar =
    typeof document === 'undefined'
      ? null
      : createPortal(
          <AnimatePresence>
            {away && !keyboardOpen && (
              <motion.div
                key="verdict-bar"
                role="region"
                aria-label={tr('审阅结论快捷操作')}
                data-sticky-actions=""
                variants={variants.fadeUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="fixed inset-x-0 bottom-(--tabbar-h) z-sticky border-t border-line bg-elevated/95 px-4 pt-2.5 pb-[max(var(--safe-bottom),0.625rem)] shadow-lg backdrop-blur-md lg:hidden"
              >
                <div className="mx-auto flex max-w-(--feed-max) items-center gap-2">
                  <LgtmButton
                    approved={me.verdict === 'lgtm'}
                    loading={pending === 'lgtm'}
                    disabled={submit.isPending}
                    onApprove={() => send('lgtm')}
                    className="h-11 flex-1 text-body"
                  />
                  <Button
                    variant="danger"
                    leftIcon={<PencilLine strokeWidth={1.75} aria-hidden />}
                    loading={pending === 'changes_requested'}
                    disabled={submit.isPending}
                    onClick={() => send('changes_requested')}
                    className="h-11 flex-1"
                  >
                    {tr('要求修改')}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        );

  return (
    <Card ref={cardRef} padding="md" className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-h3 text-fg">{tr('你的结论')}</h2>
        <span className="text-caption font-normal text-fg-subtle">
          {tr('当前：{value}', { value: VERDICT_LABEL[me.verdict] })}
        </span>
      </div>
      <label htmlFor={noteId} className="sr-only">
        {tr('附一句说明（LGTM 时可选，要求修改时必填）')}
      </label>
      <Textarea
        ref={noteRef}
        id={noteId}
        value={note}
        autoGrow
        rows={2}
        maxLength={20_000}
        aria-invalid={missingReason || undefined}
        aria-describedby={missingReason ? hintId : undefined}
        placeholder={
          needReason
            ? tr('写一句要改什么，例如：样本量不够，再补 3 个随机种子')
            : tr('附一句说明：哪里写得好、哪里要改（要求修改时必填）')
        }
        onChange={(e) => setNote(e.target.value)}
      />
      {missingReason && (
        <p id={hintId} role="alert" className="-mt-1 text-caption text-danger">
          {tr('写一句要改什么，再点「要求修改」。')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <div ref={actionsRef} className="flex gap-2">
          <LgtmButton
            approved={me.verdict === 'lgtm'}
            loading={pending === 'lgtm'}
            disabled={submit.isPending}
            onApprove={() => send('lgtm')}
            className="flex-1 max-lg:h-11"
          />
          <Button
            variant="danger"
            leftIcon={<PencilLine strokeWidth={1.75} aria-hidden />}
            loading={pending === 'changes_requested'}
            disabled={submit.isPending}
            onClick={() => send('changes_requested')}
            className="flex-1 max-lg:h-11"
          >
            {tr('要求修改')}
          </Button>
        </div>
        <Button
          variant="ghost"
          leftIcon={<MessageSquare strokeWidth={1.75} aria-hidden />}
          loading={pending === 'commented'}
          disabled={submit.isPending}
          onClick={() => send('commented')}
          fullWidth
          className="max-lg:h-10"
        >
          {tr('仅评论')}
        </Button>
      </div>
      {bar}
    </Card>
  );
}
