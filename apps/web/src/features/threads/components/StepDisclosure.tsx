import { useId, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { rawText, type ToolCall } from '../step-summary';
import { tr } from '@/lib/i18n';

/** 可折叠块：标题行是按钮（aria-expanded），展开后显示内容；折叠时可给一行预览。 */
export function Disclosure({
  summary,
  preview,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  preview?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const { variants } = useMotionPreset();
  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="group/disc flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-xs text-left"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-(--dur-fast) ease-(--ease-standard)',
            open && 'rotate-90',
          )}
        />
        <span className="flex min-w-0 flex-1 items-center gap-2">{summary}</span>
      </button>
      {!open && preview}
      {open && (
        <motion.div
          id={id}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          className="mt-1.5 min-w-0"
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}

const PRE =
  'max-h-64 overflow-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-caption font-normal whitespace-pre-wrap break-all text-fg-muted';

/** 「原始数据」：工具调用的参数和结果，等宽、可滚动，默认收起（给想对照日志的人看）。 */
export function RawData({ call, className }: { call: ToolCall; className?: string }) {
  const args = rawText(call.call);
  const result = rawText(call.result);
  return (
    <Disclosure
      className={className}
      summary={<span className="text-caption font-normal text-fg-subtle">{tr('原始数据')}</span>}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-caption font-normal text-fg-subtle">
          {tr('工具 ')}
          <span className="font-mono">{call.name || tr('未知')}</span>
        </p>
        {args && (
          <div className="min-w-0">
            <p className="mb-1 text-caption font-normal text-fg-subtle">{tr('参数')}</p>
            <pre className={PRE}>{args}</pre>
          </div>
        )}
        {result && (
          <div className="min-w-0">
            <p className="mb-1 text-caption font-normal text-fg-subtle">{tr('结果')}</p>
            <pre
              className={cn(
                PRE,
                call.ok === false && 'border-danger/30 bg-danger-soft/60 text-danger',
              )}
            >
              {result}
            </pre>
          </div>
        )}
        {!args && !result && (
          <p className="text-caption text-fg-subtle">{tr('没有记录到数据。')}</p>
        )}
      </div>
    </Disclosure>
  );
}
