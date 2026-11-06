import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Report } from '@srh/shared';
import {
  BadgeCheck,
  ChevronDown,
  FileText,
  ListTodo,
  ListTree,
  MessagesSquare,
  PenLine,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { AgentThinking, Button, Popover, RelativeTime, Skeleton, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { formatPeriod } from '../lib/period';
import { tr } from '@/lib/i18n';

// ---------------------------------------------------------------- 生成中

const SKELETON_ROWS = [
  'w-1/3 h-5',
  'w-full',
  'w-11/12',
  'w-4/5',
  'w-1/4 h-5 mt-3',
  'w-full',
  'w-5/6',
];

/** generating：agent 渐变光带 + 扫光骨架，shadow-glow 边框 */
export function GeneratingPanel({ report }: { report: Report }) {
  return (
    <div
      className="rounded-xl border border-agent/30 bg-surface p-5 shadow-glow sm:p-6"
      aria-busy="true"
    >
      <AgentThinking label={tr('正在整理这一期的上下文')} size="md" />
      <p className="mt-1 text-small text-fg-muted">
        {tr(
          '协调者正在读取 {value}{value2}的线程、实验、审阅和文档改动，写好后会自动出现在这里，不用刷新。',
          { value: formatPeriod(report.periodStart, report.periodEnd), value2: ' ' },
        )}
      </p>
      <div className="mt-6 flex flex-col gap-3">
        {SKELETON_ROWS.map((cls, i) => (
          <Skeleton key={i} className={cn('h-3.5', cls)} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 生成失败

export function GenerateErrorCard({
  error,
  onRetry,
  retrying,
  canRetry,
}: {
  error: string;
  onRetry: () => void;
  retrying: boolean;
  canRetry: boolean;
}) {
  return (
    <div
      role="alert"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning-soft p-4 sm:flex-row sm:items-center"
    >
      <TriangleAlert size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{tr('生成失败：{error}', { error })}</p>
        <p className="text-small text-fg-muted">
          {canRetry
            ? tr('可以直接重试，也可以在下面手动编辑。')
            : tr('请联系有编辑权限的成员重试。')}
        </p>
      </div>
      {canRetry && (
        <Button
          variant="secondary"
          size="sm"
          loading={retrying}
          leftIcon={<RotateCcw strokeWidth={1.75} aria-hidden />}
          onClick={onRetry}
        >
          {tr('重试')}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 重新生成

/** 重新生成（带额外要求的 Popover） */
export function RegeneratePopover({
  onConfirm,
  loading,
  disabled,
  compact = false,
}: {
  onConfirm: (instructions: string) => void;
  loading: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      label={tr('重新生成')}
      className="w-[min(20rem,calc(100vw-2rem))] p-3"
      trigger={
        <Button
          variant="secondary"
          loading={loading}
          disabled={disabled}
          aria-label={tr('重新生成')}
          leftIcon={<RotateCcw strokeWidth={1.75} aria-hidden />}
        >
          <span className={compact ? 'sr-only' : undefined}>{tr('重新生成')}</span>
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(instructions.trim());
          setOpen(false);
        }}
      >
        <label htmlFor="regen-instructions" className="mb-1.5 block text-small font-medium text-fg">
          {tr('额外要求 ')}
          <span className="font-normal text-fg-subtle">{tr('（可选）')}</span>
        </label>
        <Textarea
          id="regen-instructions"
          rows={3}
          maxLength={2000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={tr('例如：重点讲消融实验，给导师看的版本要简洁')}
          data-autofocus
        />
        <p className="mt-2 text-caption font-normal text-warning">
          {tr('重新生成会覆盖当前正文。')}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {tr('取消')}
          </Button>
          <Button size="sm" variant="primary" type="submit">
            {tr('重新生成')}
          </Button>
        </div>
      </form>
    </Popover>
  );
}

// ---------------------------------------------------------------- 行内标题

export function InlineTitle({
  title,
  canEdit,
  onSave,
}: {
  title: string;
  canEdit: boolean;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = title || tr('组会汇报');

  if (!canEdit) return <span className="block truncate text-fg">{shown}</span>;

  if (draft !== null) {
    const commit = () => {
      const t = draft.trim();
      setDraft(null);
      if (t && t !== title) onSave(t);
    };
    return (
      <span className="block min-w-0">
        <span className="sr-only">{shown}</span>
        <input
          aria-label={tr('汇报标题')}
          value={draft}
          maxLength={120}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(null);
            }
          }}
          className="h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 text-small font-semibold text-fg focus-visible:outline-accent"
        />
      </span>
    );
  }

  return (
    <span className="block min-w-0 text-fg">
      <button
        type="button"
        onClick={() => setDraft(title)}
        className="group -mx-1.5 inline-flex max-w-full cursor-text items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-(--dur-fast) hover:bg-subtle"
        aria-label={tr('标题：{shown}（点击修改）', { shown })}
      >
        <span className="min-w-0 truncate">{shown}</span>
        <PenLine
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="shrink-0 text-fg-subtle opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------- 来源说明

function StatTile({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-subtle px-3 py-2.5">
      <span className="text-fg-muted [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-small text-fg-muted">{label}</span>
      <span className="text-h3 text-fg tabular-nums">{value}</span>
    </div>
  );
}

/** 页底折叠区：这份汇报参考了什么 */
export function ReportSources({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const { variants } = useMotionPreset();
  const s = report.stats;
  const i = (Icon: typeof ListTree) => <Icon strokeWidth={1.75} aria-hidden />;
  return (
    <section className="mt-10 border-t border-line pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="report-sources"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-sm py-1 text-left text-small font-medium text-fg-muted hover:text-fg"
      >
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={cn(
            'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
            !open && '-rotate-90',
          )}
        />
        {tr('这份汇报参考了什么')}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="report-sources"
            key="sources"
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="pt-3"
          >
            <p className="mb-3 text-small text-fg-muted">
              {tr('时间段：')}
              {formatPeriod(report.periodStart, report.periodEnd)}
              {tr(' · 最近更新')} <RelativeTime iso={report.updatedAt} />
            </p>
            {s ? (
              <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-3">
                <StatTile icon={i(ListTree)} label={tr('线程')} value={s.threads} />
                <StatTile icon={i(MessagesSquare)} label={tr('讨论消息')} value={s.messages} />
                <StatTile icon={i(BadgeCheck)} label={tr('审阅')} value={s.reviews} />
                <StatTile icon={i(ListTodo)} label={tr('待办')} value={s.todos} />
                <StatTile icon={i(FileText)} label={tr('文档改动')} value={s.documents} />
              </div>
            ) : (
              <p className="text-small text-fg-subtle">
                {report.status === 'generating'
                  ? tr('生成完成后会列出用到的线程、实验和审阅数量。')
                  : tr('这份汇报是手动编写的，没有自动收集项目上下文。')}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
