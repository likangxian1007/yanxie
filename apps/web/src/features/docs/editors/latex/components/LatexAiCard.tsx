import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ClipboardPaste,
  Copy,
  Replace,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { AgentThinking, Button, IconButton, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import type { ReplaceCheck } from '../ai/fixGuard';
import { copyText } from '../../shared/dom';
import { AiDiff } from './AiDiff';
import { tr } from '@/lib/i18n';

/** 这次生成的状态：生成中 / 正常结束 / 用户停止（可能不完整）/ 出错 */
export type LatexAiPhase = 'streaming' | 'done' | 'stopped' | 'error';

export interface LatexAiTask {
  /** 卡片标题，如“润色”“修复第 12 行” */
  title: string;
  /** 补充说明（选区行号范围、主题等） */
  detail: string;
  /** 能否替换原文（有选区 / 修复片段） */
  canReplace: boolean;
  replaceLabel: string;
  /** 生成完默认显示差异而不是全文（修复） */
  preferDiff?: boolean;
}

interface LatexAiCardProps {
  phase: LatexAiPhase;
  error: string | null;
  task: LatexAiTask;
  /** 去掉代码围栏后的结果 */
  text: string;
  editable: boolean;
  /** 要被替换的原文与它第一行的行号（有替换范围时） */
  original?: { text: string; startLine: number } | null;
  /** 应用前的结构校验；不通过时不能一键替换 */
  check?: ReplaceCheck | null;
  onStop: () => void;
  onReplace: () => void;
  onInsert: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}

/**
 * AI 结果卡片（Prism 式）：流式显示 AI 写出的 LaTeX，确认后才一次性写进源码。
 * 生成中、结果为空、生成被停止时都不能替换；有替换范围时可以看修改前后的差异；
 * 校验发现会删掉 \documentclass 等结构时拒绝一键替换，看过差异后才能「仍然替换」。
 */
export function LatexAiCard({
  phase,
  error,
  task,
  text,
  editable,
  original = null,
  check = null,
  onStop,
  onReplace,
  onInsert,
  onRetry,
  onDiscard,
}: LatexAiCardProps) {
  const { variants } = useMotionPreset();
  const streaming = phase === 'streaming';
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const hasText = text.trim().length > 0;
  const ready = phase === 'done' && hasText;
  const blocked = ready && task.canReplace && !!check && !check.ok;
  const canDiff = ready && task.canReplace && !!original;
  const [view, setView] = useState<'text' | 'diff'>(task.preferDiff ? 'diff' : 'text');
  const [reviewed, setReviewed] = useState(false);
  // 每次生成由父组件用 key 重新挂载，视图和「已查看差异」状态随之重置
  const showDiff = canDiff && view === 'diff';

  // 流式输出时跟随到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  const forced = blocked && reviewed && showDiff;
  const replaceDisabled = !ready || !editable || (blocked && !forced);
  const replaceLabel = streaming ? tr('正在生成…') : forced ? tr('仍然替换') : task.replaceLabel;

  return (
    <motion.section
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      exit="exit"
      aria-label={`AI ${task.title}`}
      aria-busy={streaming}
      className={cn(
        'relative flex max-h-[min(52vh,480px)] flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-lg',
        streaming && 'shadow-glow',
      )}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-agent-gradient" />
      <header className="flex min-w-0 items-center gap-2 border-b border-line py-2 pr-2 pl-4">
        <Sparkles size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-agent" />
        <h3 className="shrink-0 text-h3 text-fg">{task.title}</h3>
        <span className="min-w-0 truncate text-caption text-fg-subtle">{task.detail}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canDiff && (
            <div
              role="group"
              aria-label={tr('显示方式')}
              className="mr-1 flex rounded-md bg-subtle p-0.5"
            >
              {(['diff', 'text'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'press rounded-sm px-2 py-0.5 text-caption text-fg-muted',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    view === v && 'bg-surface text-fg shadow-xs',
                  )}
                >
                  {v === 'diff' ? tr('差异') : tr('全文')}
                </button>
              ))}
            </div>
          )}
          {streaming ? (
            <IconButton label={tr('停止生成')} size="sm" onClick={onStop}>
              <Square strokeWidth={1.75} aria-hidden />
            </IconButton>
          ) : (
            <IconButton label={tr('重新生成')} size="sm" onClick={onRetry}>
              <RotateCcw strokeWidth={1.75} aria-hidden />
            </IconButton>
          )}
          <IconButton label={tr('丢弃')} size="sm" onClick={onDiscard}>
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      </header>

      {blocked && check && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-danger-soft px-4 py-2 text-small text-fg"
        >
          <AlertTriangle
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className="mt-0.5 shrink-0 text-danger"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{check.title}</p>
            {check.problems.length > 1 && (
              <p className="text-caption text-fg-muted">
                {tr('另外还')}
                {check.problems.slice(1).join(tr('；'))}
                {tr('。')}
              </p>
            )}
            <p className="text-caption text-fg-muted">
              {tr('可以重新生成，或者看过差异后自己决定。')}
            </p>
          </div>
          {!reviewed ? (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() => {
                setReviewed(true);
                setView('diff');
              }}
            >
              {tr('仍然查看差异')}
            </Button>
          ) : null}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="px-4 py-3 text-small text-danger" role="alert">
            {error}
          </p>
        ) : showDiff && original ? (
          <AiDiff before={original.text} after={text} startLine={original.startLine} />
        ) : hasText ? (
          <pre
            ref={bodyRef}
            className="max-h-full overflow-auto px-4 py-3 font-mono text-small leading-relaxed break-words whitespace-pre-wrap text-fg"
          >
            {text}
            {streaming && <span aria-hidden className="stream-caret ml-0.5 align-middle" />}
          </pre>
        ) : streaming ? (
          <div className="px-4 py-3">
            <AgentThinking size="sm" label={tr('正在读这段 LaTeX')} />
          </div>
        ) : (
          <p className="px-4 py-3 text-small text-fg-muted">
            {tr('AI 没有生成内容，可以重新生成一次。')}
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2">
        {!editable ? (
          <span className="mr-auto text-caption text-fg-subtle">{tr('只读模式下只能复制')}</span>
        ) : phase === 'stopped' && hasText ? (
          <span className="mr-auto text-caption text-fg-subtle">
            {tr('已停止生成，结果可能不完整')}
          </span>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {tr('丢弃')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
          disabled={streaming || !hasText}
          onClick={() => {
            void copyText(text).then((ok) =>
              ok
                ? toast.success(tr('已复制 AI 结果'))
                : toast.error(tr('复制失败'), tr('浏览器没有给剪贴板权限，可以手动选中复制。')),
            );
          }}
        >
          {tr('复制')}
        </Button>
        <Button
          size="sm"
          variant={task.canReplace ? 'secondary' : 'primary'}
          leftIcon={<ClipboardPaste strokeWidth={1.75} aria-hidden />}
          disabled={!ready || !editable}
          onClick={onInsert}
        >
          {tr('插入到光标处')}
        </Button>
        {task.canReplace && (
          <Button
            size="sm"
            variant={forced ? 'danger' : 'primary'}
            leftIcon={<Replace strokeWidth={1.75} aria-hidden />}
            loading={streaming}
            disabled={replaceDisabled}
            onClick={onReplace}
          >
            {replaceLabel}
          </Button>
        )}
      </footer>
    </motion.section>
  );
}
