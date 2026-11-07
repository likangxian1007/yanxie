import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { motion } from 'motion/react';
import katex from 'katex';
import type { Editor } from '@tiptap/core';
import type { DocumentAiAction } from '@srh/shared';
import {
  ArrowUp,
  FileText,
  Languages,
  ListTree,
  PenLine,
  RotateCcw,
  Scissors,
  Sparkles,
  Square,
  WandSparkles,
  GraduationCap,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import { AgentThinking, Button, IconButton, Kbd } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { AI_ACTION_LABEL } from '../../../ai/useDocAi';
import type { AiBridge } from '../ext/ai-session';
import type { RichAi } from '../ai/useRichAi';
import { AiRouteBadge, LocalOnlyToggle } from '@/features/docs/ai/AiRouteBadge';
import { markdownToHtml } from '../lib/markdown';
import { ICON_STROKE } from './icons';
import { tr } from '@/lib/i18n';

interface Chip {
  key: string;
  label: string;
  action: DocumentAiAction;
  prompt?: string;
  icon: LucideIcon;
}

/** 没有选中文字时的建议 */
const WRITE_CHIPS: Chip[] = [
  { key: 'continue', label: tr('续写'), action: 'continue', icon: PenLine },
  { key: 'outline', label: tr('生成大纲'), action: 'outline', icon: ListTree },
  { key: 'summarize', label: tr('总结'), action: 'summarize', icon: FileText },
  {
    key: 'related',
    label: tr('写一段相关工作'),
    action: 'custom',
    prompt: tr(
      '结合本文主题，写一段“相关工作”（Related Work）：按研究脉络归纳已有方法，指出与本文的区别。',
    ),
    icon: BookOpen,
  },
];

/** 选中了文字时的建议（改写） */
const REWRITE_CHIPS: Chip[] = [
  { key: 'polish', label: tr('润色'), action: 'polish', icon: WandSparkles },
  { key: 'shorten', label: tr('精简'), action: 'shorten', icon: Scissors },
  { key: 'expand', label: tr('扩写'), action: 'expand', icon: PenLine },
  { key: 'academic', label: tr('改成学术语气'), action: 'academic', icon: GraduationCap },
  { key: 'en', label: tr('译成英文'), action: 'translate_en', icon: Languages },
  { key: 'zh', label: tr('译成中文'), action: 'translate_zh', icon: Languages },
];

const CARET_CONTAINERS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'CODE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
]);

/** 面板和后文之间留的空隙（px） */
const GAP = 12;

export interface AiPanelProps {
  editor: Editor;
  bridge: AiBridge;
  ai: RichAi;
  /** 面板的定位容器（position: relative，包住 EditorContent） */
  hostRef: RefObject<HTMLElement | null>;
}

/**
 * 内嵌 AI 面板：浮在编辑器里的占位 widget 上（占位高度 = 面板高度，把后文往下推）。
 * 输入条：agent 渐变 1px 描边 + shadow-glow + 建议 chips；
 * 结果块：agent 渐变左边框，流式逐字出现，末尾 agent 色闪烁光标；替换 / 插入 / 重试 / 丢弃。
 */
export function AiPanel(props: AiPanelProps) {
  // 会话打开时才挂载面板（定位 effect 需要面板元素已存在）
  return props.ai.session ? <AiPanelBody {...props} /> : null;
}

function AiPanelBody({ editor, bridge, ai, hostRef }: AiPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { variants } = useMotionPreset();
  const session = ai.session;

  // 定位：跟着占位元素走；把面板高度写回占位元素
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const host = hostRef.current;
    if (!panel || !host) return;
    let raf = 0;
    const place = () => {
      const spacer = bridge.spacer.get();
      if (!spacer || !spacer.isConnected) return;
      spacer.style.height = `${panel.offsetHeight + GAP * 2}px`;
      const top = spacer.getBoundingClientRect().top - host.getBoundingClientRect().top + GAP;
      panel.style.top = `${Math.round(top)}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(panel);
    editor.on('transaction', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      editor.off('transaction', schedule);
      window.removeEventListener('resize', schedule);
      const spacer = bridge.spacer.get();
      if (spacer) spacer.style.height = '0px';
    };
  }, [bridge, editor, hostRef]);

  // 打开时滚到可见
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ block: 'nearest' });
    }
  }, [session?.phase]);

  if (!session) return null;

  return (
    <motion.div
      ref={panelRef}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      className="absolute inset-x-0 top-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          ai.discard();
        }
      }}
    >
      {session.phase === 'prompt' ? (
        <PromptBar
          hasTarget={session.hasTarget}
          onSubmit={(prompt) => ai.submit('custom', prompt)}
          onChip={(chip) => ai.submit(chip.action, chip.prompt ?? '')}
          onCancel={ai.discard}
        />
      ) : (
        <ResultBlock ai={ai} />
      )}
    </motion.div>
  );
}

function PromptBar({
  hasTarget,
  onSubmit,
  onChip,
  onCancel,
}: {
  hasTarget: boolean;
  onSubmit: (prompt: string) => void;
  onChip: (chip: Chip) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const chips = hasTarget ? REWRITE_CHIPS : WRITE_CHIPS;
  const canSend = value.trim().length > 0;
  return (
    <div className="rounded-xl bg-agent-gradient p-px shadow-glow">
      <div className="rounded-[15px] bg-elevated">
        <form
          className="flex items-center gap-2 py-1.5 pr-1.5 pl-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) onSubmit(value.trim());
          }}
        >
          <Sparkles className="size-4 shrink-0 text-agent" strokeWidth={ICON_STROKE} aria-hidden />
          <input
            autoFocus
            value={value}
            aria-label={tr('给 AI 的指令')}
            placeholder={
              hasTarget ? tr('告诉 AI 怎么改选中的文字…') : tr('告诉 AI 你想写什么，回车发送')
            }
            className="h-8 min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-fg-subtle focus-visible:outline-none"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
            }}
          />
          <IconButton
            type="submit"
            size="sm"
            variant={canSend ? 'primary' : 'subtle'}
            label={tr('发送')}
            shortcut="Enter"
            disabled={!canSend}
          >
            <ArrowUp strokeWidth={ICON_STROKE} />
          </IconButton>
        </form>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
          {chips.map((chip) => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => onChip(chip)}
                className={cn(
                  'press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-small text-fg-muted',
                  'hover:border-line-strong hover:bg-subtle hover:text-fg',
                )}
              >
                <Icon className="size-3.5 text-agent" strokeWidth={ICON_STROKE} aria-hidden />
                {chip.label}
              </button>
            );
          })}
          <span className="flex-1" />
          <LocalOnlyToggle />
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex cursor-pointer items-center gap-1 text-caption text-fg-subtle hover:text-fg-muted"
          >
            <Kbd>Esc</Kbd>
            {tr(' 退出')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultBlock({ ai }: { ai: RichAi }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const { session, status, text, error } = ai;
  const streaming = status === 'streaming';
  const action = session?.request?.action ?? 'custom';
  const label = AI_ACTION_LABEL[action];
  const hasTarget = Boolean(session?.hasTarget);
  const hasText = text.trim().length > 0;

  // 预览：markdown → 清洗后的 HTML，公式用 KaTeX 渲染，末尾放流式光标
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    el.innerHTML = markdownToHtml(text).html;
    el.querySelectorAll<HTMLElement>('[data-type="inline-math"], [data-type="block-math"]').forEach(
      (node) => {
        const latex = node.getAttribute('data-latex') ?? '';
        try {
          katex.render(latex, node, {
            displayMode: node.getAttribute('data-type') === 'block-math',
            throwOnError: false,
          });
        } catch {
          node.textContent = latex;
        }
      },
    );
    const caret = document.createElement('span');
    caret.className = cn('stream-caret rich-ai-caret', !streaming && 'is-done');
    caret.setAttribute('aria-hidden', 'true');
    // 光标放进最后一个块级元素的末尾（跟在最后一个字后面）
    let target: Element = el;
    for (;;) {
      const last: Element | null = target.lastElementChild;
      if (!last || last.hasAttribute('data-type') || !CARET_CONTAINERS.has(last.tagName)) break;
      target = last;
    }
    target.appendChild(caret);
    if (streaming) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-line bg-elevated shadow-glow"
      aria-busy={streaming || undefined}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-agent-gradient" />
      <div className="flex min-h-9 items-center gap-2 px-4 pt-2.5">
        {streaming ? (
          <AgentThinking label={tr('AI 正在{label}', { label })} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-small font-medium text-agent-text">
            <Sparkles className="size-3.5" strokeWidth={ICON_STROKE} aria-hidden />
            AI · {label}
          </span>
        )}
        <AiRouteBadge route={ai.route} />
      </div>
      <div
        ref={previewRef}
        aria-live="polite"
        className="rich-prose rich-ai-preview max-h-[50vh] overflow-y-auto px-4 pt-1 pb-2"
      />
      {error && (
        <div
          role="alert"
          className="mx-4 mb-2 rounded-md bg-danger-soft px-3 py-2 text-small text-danger"
        >
          {error}
        </div>
      )}
      {!streaming && !error && !hasText && (
        <div className="mx-4 mb-2 text-small text-fg-subtle">
          {tr('AI 没有返回内容，可以重试一次。')}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        {streaming ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Square strokeWidth={ICON_STROKE} />}
            onClick={ai.stop}
          >
            {tr('停止')}
          </Button>
        ) : (
          <>
            {hasTarget && (
              <Button
                size="sm"
                variant="primary"
                disabled={!hasText}
                onClick={() => ai.accept('replace')}
              >
                {tr('替换选区')}
              </Button>
            )}
            <Button
              size="sm"
              variant={hasTarget ? 'secondary' : 'primary'}
              disabled={!hasText}
              onClick={() => ai.accept('below')}
            >
              {tr('插入到下方')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<RotateCcw strokeWidth={ICON_STROKE} />}
              onClick={ai.retry}
            >
              {tr('重试')}
            </Button>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={ai.discard}>
          {tr('丢弃')}
          <Kbd className="ml-1.5">Esc</Kbd>
        </Button>
      </div>
    </div>
  );
}
