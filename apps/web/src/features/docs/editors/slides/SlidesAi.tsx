import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Sparkles, Square, Wand2 } from 'lucide-react';
import { AgentThinking, Button, Dialog, Popover, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useDocAi } from '../../ai/useDocAi';
import { parseSlidesMarkdown, type SlideDraft } from './lib/markdown';
import { DraftPreview } from './render/DeckPreview';
import { tr } from '@/lib/i18n';

const REPORT_PRESET = tr(
  '根据项目上下文（最近的线程、实验记录、审阅和待办）写一份组会汇报：本期目标、主要进展、关键实验结果（给出数字）、遇到的问题与风险、下期计划。',
);

const PAGE_OPTIONS = [
  { value: '', label: tr('页数：自动') },
  { value: '5', label: tr('约 5 页') },
  { value: '8', label: tr('约 8 页') },
  { value: '10', label: tr('约 10 页') },
  { value: '12', label: tr('约 12 页') },
  { value: '15', label: tr('约 15 页') },
];

interface SlidesAiDialogProps {
  projectId: string;
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasSlides: boolean;
  onApply: (slides: SlideDraft[], mode: 'replace' | 'append') => void;
}

/** “AI 生成幻灯片”：主题/要点 → 流式出页（逐页出现）→ 替换全部 / 追加到末尾。 */
export function SlidesAiDialog({
  projectId,
  docId,
  open,
  onOpenChange,
  hasSlides,
  onApply,
}: SlidesAiDialogProps) {
  const ai = useDocAi(projectId, docId);
  const { variants } = useMotionPreset();
  const [prompt, setPrompt] = useState('');
  const [pages, setPages] = useState('');
  const drafts = useMemo(() => parseSlidesMarkdown(ai.text), [ai.text]);
  const streaming = ai.status === 'streaming';

  const generate = () => {
    const topic = prompt.trim();
    if (!topic) return;
    const full = pages ? tr('{topic}\n\n页数：约 {pages} 页。', { topic, pages }) : topic;
    void ai.run({ action: 'slides', prompt: full });
  };

  const close = (v: boolean) => {
    if (!v) {
      ai.stop();
    }
    onOpenChange(v);
  };

  const apply = (mode: 'replace' | 'append') => {
    if (drafts.length === 0) return;
    onApply(drafts, mode);
    ai.reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title={tr('AI 生成幻灯片')}
      description={tr('说说主题和要点，AI 会按页写好标题、要点和演讲者备注。')}
      footer={
        streaming ? (
          <Button
            variant="secondary"
            leftIcon={<Square strokeWidth={1.75} aria-hidden />}
            onClick={ai.stop}
          >
            {tr('停止')}
          </Button>
        ) : drafts.length > 0 ? (
          <>
            <Button variant="ghost" onClick={generate} disabled={!prompt.trim()}>
              {tr('重新生成')}
            </Button>
            {hasSlides && (
              <Button variant="secondary" onClick={() => apply('replace')}>
                {tr('替换全部')}
              </Button>
            )}
            <Button
              variant="primary"
              leftIcon={<Check strokeWidth={1.75} aria-hidden />}
              onClick={() => apply(hasSlides ? 'append' : 'replace')}
            >
              {hasSlides ? tr('追加到末尾') : tr('插入 {count} 页', { count: drafts.length })}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Sparkles strokeWidth={1.75} aria-hidden />}
              disabled={!prompt.trim()}
              onClick={generate}
            >
              {tr('生成')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Textarea
          data-autofocus
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={tr('例如：介绍我们在长尾分类上的重加权方法，动机、方法、三组实验结果和局限')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              generate();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="subtle"
            leftIcon={<Wand2 strokeWidth={1.75} aria-hidden className="text-agent" />}
            onClick={() => setPrompt(REPORT_PRESET)}
          >
            {tr('根据项目上下文写一份组会汇报')}
          </Button>
          <Select
            size="sm"
            aria-label={tr('页数建议')}
            wrapperClassName="w-32"
            value={pages}
            options={PAGE_OPTIONS}
            onChange={(e) => setPages(e.target.value)}
          />
        </div>

        {(ai.status !== 'idle' || drafts.length > 0) && (
          <div
            className={cn(
              'rounded-lg border border-line bg-subtle p-3',
              streaming && 'shadow-glow',
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              {streaming ? (
                <AgentThinking
                  size="sm"
                  label={
                    drafts.length
                      ? tr('正在写第 {count} 页', { count: drafts.length })
                      : tr('正在构思')
                  }
                />
              ) : (
                <span className="text-caption text-fg-muted">
                  {drafts.length > 0
                    ? tr('预览 · {count} 页', { count: drafts.length })
                    : tr('没有生成内容')}
                </span>
              )}
            </div>
            {ai.error && <p className="mb-2 text-small text-danger">{ai.error}</p>}
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <AnimatePresence initial={false}>
                {drafts.map((d, i) => (
                  <motion.li
                    key={i}
                    variants={variants.fadeUp}
                    initial="hidden"
                    animate="visible"
                    className="min-w-0"
                  >
                    <DraftPreview draft={d} className="rounded-md ring-1 ring-line" />
                    <p className="mt-1 truncate text-caption text-fg-muted">
                      {i + 1}. {d.title || tr('未命名页面')}
                    </p>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>
        )}
      </div>
    </Dialog>
  );
}

interface PolishProps {
  projectId: string;
  docId: string;
  body: string;
  disabled?: boolean;
  onReplace: (text: string) => void;
}

/** 当前页正文的 AI 润色 / 精简：流式预览 → 替换正文。 */
export function SlidePolishButton({ projectId, docId, body, disabled, onReplace }: PolishProps) {
  const ai = useDocAi(projectId, docId);
  const [open, setOpen] = useState(false);
  const streaming = ai.status === 'streaming';
  const run = (action: 'polish' | 'shorten') => {
    void ai.run({
      action,
      selection: body,
      prompt: tr(
        '这是幻灯片的正文（markdown 列表或段落），保持原有的 markdown 结构，只输出改写后的正文。',
      ),
    });
  };
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          ai.stop();
          ai.reset();
        }
      }}
      label={tr('AI 改写正文')}
      align="end"
      className="w-[min(420px,calc(100vw-24px))] p-0"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !body.trim()}
          leftIcon={<Wand2 strokeWidth={1.75} aria-hidden className="text-agent" />}
        >
          {tr('AI 润色')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-autofocus
            disabled={streaming}
            onClick={() => run('polish')}
          >
            {tr('润色正文')}
          </Button>
          <Button size="sm" variant="secondary" disabled={streaming} onClick={() => run('shorten')}>
            {tr('精简正文')}
          </Button>
        </div>
        {ai.status !== 'idle' && (
          <div className="max-h-64 overflow-y-auto rounded-md border border-line bg-surface px-3 py-2">
            {ai.error ? (
              <p className="text-small text-danger">{ai.error}</p>
            ) : ai.text ? (
              <p className="text-small whitespace-pre-wrap text-fg">
                {ai.text}
                {streaming && <span aria-hidden className="stream-caret ml-0.5" />}
              </p>
            ) : (
              <AgentThinking size="sm" />
            )}
          </div>
        )}
        {ai.status === 'done' && ai.text.trim() && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => ai.reset()}>
              {tr('放弃')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onReplace(ai.text.trim());
                setOpen(false);
                ai.reset();
              }}
            >
              {tr('替换正文')}
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}
