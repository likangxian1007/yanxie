import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, Sparkles, Square, Table2, X } from 'lucide-react';
import {
  AgentThinking,
  Button,
  IconButton,
  Markdown,
  Popover,
  Tabs,
  Textarea,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import type { useDocAi } from '../../ai/useDocAi';
import { copyText } from '../shared/dom';
import { parseCsv } from './lib/csv';
import { tr } from '@/lib/i18n';

type DocAi = ReturnType<typeof useDocAi>;

interface SheetAiButtonProps {
  ai: DocAi;
  editable: boolean;
  /** 当前单元格地址（如 B3）与选区地址（如 A1:C5） */
  activeLabel: string;
  rangeLabel: string;
  rangeCells: number;
  onInsert: (grid: string[][], at: 'origin' | 'active') => void;
  onAnalyze: () => void;
}

const EXAMPLE = tr('对比 ResNet-50 / ViT-B/16 / ConvNeXt-T 在 ImageNet 上的 Top-1、参数量、FLOPs');

/** 工具栏“AI”按钮：生成表格（CSV 流式预览 → 插入）/ 分析选区（结果进侧边卡片）。 */
export function SheetAiButton({
  ai,
  editable,
  activeLabel,
  rangeLabel,
  rangeCells,
  onInsert,
  onAnalyze,
}: SheetAiButtonProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'table' | 'analyze'>(editable ? 'table' : 'analyze');
  const [prompt, setPrompt] = useState('');
  const grid = useMemo(() => (ai.text ? parseCsv(ai.text) : []), [ai.text]);
  const streaming = ai.status === 'streaming';
  const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);

  const generate = () => {
    const topic = prompt.trim();
    if (!topic) return;
    void ai.run({ action: 'table', prompt: topic });
  };

  const insert = (at: 'origin' | 'active') => {
    if (grid.length === 0) return;
    onInsert(grid, at);
    setOpen(false);
    ai.reset();
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={tr('表格 AI')}
      align="end"
      className="w-[min(440px,calc(100vw-24px))] p-0"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Sparkles strokeWidth={1.75} aria-hidden className="text-agent" />}
        >
          AI
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <Tabs
          variant="segmented"
          size="sm"
          layoutId="sheet-ai-tab"
          aria-label={tr('AI 功能')}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'table', label: tr('生成表格'), disabled: !editable },
            { value: 'analyze', label: tr('分析选区') },
          ]}
        />
        {tab === 'table' ? (
          <>
            <Textarea
              data-autofocus
              rows={3}
              value={prompt}
              placeholder={tr('想要什么表格？例如：{EXAMPLE}', { EXAMPLE })}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  generate();
                }
              }}
            />
            {(ai.status !== 'idle' || grid.length > 0) && (
              <div className="rounded-md border border-line bg-surface">
                <div className="flex h-8 items-center gap-2 border-b border-line px-2.5">
                  {streaming ? (
                    <AgentThinking size="sm" label={tr('正在生成表格')} />
                  ) : (
                    <span className="text-caption text-fg-muted">
                      {grid.length > 0
                        ? tr('预览 · {count} 行 × {cols} 列', { count: grid.length, cols })
                        : tr('没有生成内容')}
                    </span>
                  )}
                </div>
                {ai.error && <p className="px-2.5 py-2 text-small text-danger">{ai.error}</p>}
                {grid.length > 0 && (
                  <div className="max-h-56 overflow-auto">
                    <table className="w-full border-collapse text-small">
                      <tbody>
                        {grid.slice(0, 40).map((row, r) => (
                          <tr key={r} className={cn(r === 0 && 'bg-subtle font-medium')}>
                            {Array.from({ length: cols }, (_, c) => (
                              <td
                                key={c}
                                className="max-w-40 truncate border-b border-line px-2 py-1 whitespace-nowrap"
                              >
                                {row[c] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {streaming ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Square strokeWidth={1.75} aria-hidden />}
                  onClick={ai.stop}
                >
                  {tr('停止')}
                </Button>
              ) : grid.length > 0 ? (
                <>
                  <Button size="sm" variant="ghost" onClick={generate} disabled={!prompt.trim()}>
                    {tr('重新生成')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => insert('active')}>
                    {tr('插入到 {activeLabel}', { activeLabel })}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => insert('origin')}>
                    {tr('插入到 A1')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<Table2 strokeWidth={1.75} aria-hidden />}
                  disabled={!prompt.trim()}
                  onClick={generate}
                >
                  {tr('生成表格')}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-small text-fg-muted">
              {tr('把选区 ')}
              <span className="font-mono text-fg">{rangeLabel}</span>
              {tr('（')}
              {rangeCells}{' '}
              {tr('个单元格）交给 AI，找出关键发现、趋势和异常值。结果显示在表格右侧。')}
            </p>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="primary"
                data-autofocus
                leftIcon={<Sparkles strokeWidth={1.75} aria-hidden />}
                disabled={rangeCells < 2}
                onClick={() => {
                  setOpen(false);
                  onAnalyze();
                }}
              >
                {tr('分析选区')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}

interface AnalysisCardProps {
  ai: DocAi;
  label: string;
  onClose: () => void;
}

/** “分析选区”的结果卡片（覆盖在表格右侧）。 */
export function SheetAnalysisCard({ ai, label, onClose }: AnalysisCardProps) {
  const { variants } = useMotionPreset();
  const streaming = ai.status === 'streaming';
  return (
    <motion.aside
      variants={variants.slideInRight}
      initial="hidden"
      animate="visible"
      exit="exit"
      aria-label={tr('选区分析')}
      className={cn(
        'absolute top-3 right-3 bottom-3 z-overlay flex w-[min(360px,calc(100%-24px))] flex-col rounded-lg border border-line bg-elevated shadow-lg',
        streaming && 'shadow-glow',
      )}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles size={16} strokeWidth={1.75} aria-hidden className="text-agent" />
        <h3 className="text-h3 text-fg">{tr('选区分析')}</h3>
        <span className="font-mono text-caption text-fg-subtle">{label}</span>
        <div className="ml-auto flex items-center">
          {streaming ? (
            <IconButton label={tr('停止')} size="sm" onClick={ai.stop}>
              <Square strokeWidth={1.75} aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label={tr('复制结果')}
              size="sm"
              disabled={!ai.text}
              onClick={() => {
                void copyText(ai.text).then((ok) =>
                  ok
                    ? toast.success(tr('已复制分析结果'))
                    : toast.error(tr('复制失败'), tr('浏览器没有给剪贴板权限，可以手动选中复制。')),
                );
              }}
            >
              <Copy strokeWidth={1.75} aria-hidden />
            </IconButton>
          )}
          <IconButton label={tr('关闭')} size="sm" onClick={onClose}>
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {ai.error ? (
          <p className="text-small text-danger">{ai.error}</p>
        ) : ai.text ? (
          <div>
            <Markdown size="compact">{ai.text}</Markdown>
            {streaming && <span aria-hidden className="stream-caret ml-0.5" />}
          </div>
        ) : (
          <AgentThinking size="sm" label={tr('正在读选区')} />
        )}
      </div>
    </motion.aside>
  );
}
