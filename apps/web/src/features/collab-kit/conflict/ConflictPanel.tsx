import { useId, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Info } from 'lucide-react';
import { Button, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { mergeText } from './merge';
import { tr } from '@/lib/i18n';

/**
 * 乐观并发冲突的合并视图（ARCHITECTURE §5.2「已被某人修改」+ 合并视图）：
 * 并排显示「你的版本」和「对方的版本」，三种处理：保留我的 / 用对方的 / 手动合并。
 * 手动合并的初稿是三方合并结果（两边都改到同一处时两段都保留），用户确认后再保存。
 */
export interface ConflictPanelProps {
  /** 字段名，如「假设」 */
  label: string;
  mine: string;
  theirs: string;
  /** 双方开始编辑前的共同版本（用于生成合并初稿） */
  base: string;
  /** 对方是谁；不知道就写「有人」 */
  who?: string | null;
  /** 文本字段才能手动合并；选择类字段只给两个选项 */
  allowManual?: boolean;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  onMerge?: (text: string) => void;
  className?: string;
}

export function ConflictPanel({
  label,
  mine,
  theirs,
  base,
  who,
  allowManual = true,
  onKeepMine,
  onTakeTheirs,
  onMerge,
  className,
}: ConflictPanelProps) {
  const id = useId();
  const { variants } = useMotionPreset();
  const [merged, setMerged] = useState<string | null>(null);
  const actor = who?.trim() || tr('有人');

  return (
    <motion.div
      role="alert"
      aria-labelledby={`${id}-title`}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0">
          <p id={`${id}-title`} className="text-small font-semibold text-fg">
            {tr('{actor}刚改了「{label}」，和你的修改冲突了', { actor, label })}
          </p>
          <p className="text-caption font-normal text-fg-muted">
            {tr('你的输入还在，没有被覆盖。看一下对方的版本，再选怎么处理。')}
          </p>
        </div>
      </div>

      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <VersionBox title={tr('你的版本')} text={mine} />
        <VersionBox title={`${actor === '有人' ? tr('对方') : actor}的版本`} text={theirs} />
      </div>

      {merged !== null ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-merge`} className="text-caption text-fg-muted">
            {tr('手动合并（已把两边的改动放在一起，删改成你想要的样子再保存）')}
          </label>
          <Textarea
            id={`${id}-merge`}
            autoFocus
            autoGrow
            rows={4}
            value={merged}
            onChange={(e) => setMerged(e.target.value)}
            className="bg-surface text-small"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onMerge?.(merged);
                setMerged(null);
              }}
            >
              {tr('保存合并结果')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMerged(null)}>
              {tr('返回')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onKeepMine}>
            {tr('保留我的')}
          </Button>
          <Button size="sm" variant="secondary" onClick={onTakeTheirs}>
            {tr('用对方的')}
          </Button>
          {allowManual && onMerge && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMerged(mergeText(base, mine, theirs).text)}
            >
              {tr('手动合并')}
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}

function VersionBox({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-fg-muted">{title}</span>
      <div className="max-h-48 min-h-9 overflow-auto rounded-md border border-line bg-surface px-2.5 py-1.5 text-small break-words whitespace-pre-wrap text-fg">
        {text.trim() ? text : <span className="text-fg-subtle">{tr('（空）')}</span>}
      </div>
    </div>
  );
}

/**
 * 编辑中对方改了同一个字段（还没保存、还没撞上冲突）：小提示，不打断输入。
 * 可以展开看对方现在的内容。
 */
export function RemoteChangedHint({
  who,
  theirs,
  className,
}: {
  who?: string | null;
  theirs?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const actor = who?.trim() || tr('对方');
  return (
    <div role="status" className={cn('flex flex-col gap-1.5', className)}>
      <p className="inline-flex flex-wrap items-center gap-1.5 text-caption font-normal text-warning">
        <Info size={14} strokeWidth={1.75} aria-hidden />
        {actor}
        {tr('刚更新了这个字段，你的输入不会被覆盖，保存时会让你对比')}
        {theirs !== undefined && (
          <button
            type="button"
            className="rounded-xs text-accent-text underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            aria-expanded={open}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? tr('收起') : tr('看看对方的版本')}
          </button>
        )}
      </p>
      {open && theirs !== undefined && (
        <div className="max-h-40 overflow-auto rounded-md border border-line bg-subtle px-2.5 py-1.5 text-small break-words whitespace-pre-wrap text-fg-muted">
          {theirs.trim() ? theirs : tr('（空）')}
        </div>
      )}
    </div>
  );
}
