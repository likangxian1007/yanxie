import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDownAZ, ArrowUpAZ, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button, IconButton, Input, Popover } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { tr } from '@/lib/i18n';

// ------------------------------------------------------------------ 查找和替换

export interface FindOptions {
  find: string;
  replace: string;
  matchCase: boolean;
  wholeCell: boolean;
  allSheets: boolean;
}

export interface FindPanelProps {
  opts: FindOptions;
  onChange: (next: FindOptions) => void;
  showReplace: boolean;
  onToggleReplace: () => void;
  editable: boolean;
  /** 第几个 / 共几个（0 起；没有结果时 total = 0） */
  index: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export function FindPanel(p: FindPanelProps) {
  const { variants } = useMotionPreset();
  const set = (patch: Partial<FindOptions>) => p.onChange({ ...p.opts, ...patch });
  return (
    <motion.div
      role="search"
      aria-label={tr('查找和替换')}
      variants={variants.scaleIn}
      initial="initial"
      animate="animate"
      exit="exit"
      className="absolute top-2 right-2 z-overlay w-[min(22rem,calc(100%-1rem))] origin-top-right rounded-lg border border-line bg-elevated p-2 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          p.onClose();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          size="sm"
          autoFocus
          aria-label={tr('查找内容')}
          placeholder={tr('查找')}
          value={p.opts.find}
          onChange={(e) => set({ find: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.shiftKey) p.onPrev();
              else p.onNext();
            }
          }}
          wrapperClassName="min-w-0 flex-1"
        />
        <span
          className="w-14 shrink-0 text-center text-caption text-fg-muted tabular-nums"
          aria-live="polite"
        >
          {p.opts.find ? (p.total ? `${p.index + 1}/${p.total}` : tr('无结果')) : ''}
        </span>
        <IconButton label={tr('上一个')} size="sm" disabled={!p.total} onClick={p.onPrev}>
          <ChevronUp strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={tr('下一个')} size="sm" disabled={!p.total} onClick={p.onNext}>
          <ChevronDown strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={tr('关闭')} size="sm" onClick={p.onClose}>
          <X strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
      {p.showReplace && p.editable && (
        <div className="mt-1 flex items-center gap-1">
          <Input
            size="sm"
            aria-label={tr('替换为')}
            placeholder={tr('替换为')}
            value={p.opts.replace}
            onChange={(e) => set({ replace: e.target.value })}
            wrapperClassName="min-w-0 flex-1"
          />
          <Button size="sm" variant="secondary" disabled={!p.total} onClick={p.onReplace}>
            {tr('替换')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!p.total} onClick={p.onReplaceAll}>
            {tr('全部替换')}
          </Button>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-caption text-fg-muted">
        <Check
          label={tr('区分大小写')}
          checked={p.opts.matchCase}
          onChange={(v) => set({ matchCase: v })}
        />
        <Check
          label={tr('单元格完全匹配')}
          checked={p.opts.wholeCell}
          onChange={(v) => set({ wholeCell: v })}
        />
        <Check
          label={tr('所有工作表')}
          checked={p.opts.allSheets}
          onChange={(v) => set({ allSheets: v })}
        />
        {p.editable && (
          <button
            type="button"
            className="ml-auto text-accent-text hover:underline"
            onClick={p.onToggleReplace}
          >
            {p.showReplace ? tr('只查找') : tr('替换…')}
          </button>
        )}
      </div>
    </motion.div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1 select-none">
      <input
        type="checkbox"
        className="size-3.5 accent-[var(--color-accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

// ------------------------------------------------------------------ 筛选

export interface FilterPopoverProps {
  anchor: DOMRect | null;
  title: string;
  /** 这一列（表头以下）的全部显示值 → 出现次数 */
  values: Array<{ text: string; count: number }>;
  /** 当前允许的值；null = 没有条件 */
  allowed: string[] | null;
  onApply: (allowed: string[] | null) => void;
  onSort: (asc: boolean) => void;
  onClose: () => void;
}

export function FilterPopover(p: FilterPopoverProps) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(p.allowed ?? p.values.map((v) => v.text)),
  );
  const shown = useMemo(
    () => p.values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase())),
    [p.values, q],
  );
  const allShown = shown.every((v) => picked.has(v.text));
  return (
    <Popover
      label={tr('筛选：{title}', { title: p.title })}
      open={p.anchor !== null}
      onOpenChange={(open) => !open && p.onClose()}
      align="end"
      trigger={
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={{
            left: p.anchor?.left ?? -10,
            top: p.anchor?.top ?? -10,
            width: p.anchor?.width ?? 1,
            height: p.anchor?.height ?? 1,
          }}
        />
      }
      className="w-64"
    >
      <div className="flex flex-col gap-1 p-1">
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-sm px-2 text-small text-fg hover:bg-subtle"
          onClick={() => p.onSort(true)}
        >
          <ArrowDownAZ className="size-4" strokeWidth={1.75} aria-hidden />
          {tr(' 升序排列')}
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-sm px-2 text-small text-fg hover:bg-subtle"
          onClick={() => p.onSort(false)}
        >
          <ArrowUpAZ className="size-4" strokeWidth={1.75} aria-hidden />
          {tr(' 降序排列')}
        </button>
        <div className="my-1 h-px bg-line" />
        <Input
          size="sm"
          aria-label={tr('搜索值')}
          placeholder={tr('搜索')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="flex h-7 items-center gap-2 px-2 text-small text-fg select-none">
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--color-accent)]"
            checked={allShown}
            onChange={() => {
              const next = new Set(picked);
              for (const v of shown) {
                if (allShown) next.delete(v.text);
                else next.add(v.text);
              }
              setPicked(next);
            }}
          />
          {tr('全选')}
        </label>
        <div className="max-h-56 overflow-y-auto">
          {shown.map((v) => (
            <label
              key={v.text}
              className="flex h-7 items-center gap-2 rounded-sm px-2 text-small text-fg select-none hover:bg-subtle"
            >
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--color-accent)]"
                checked={picked.has(v.text)}
                onChange={() => {
                  const next = new Set(picked);
                  if (next.has(v.text)) next.delete(v.text);
                  else next.add(v.text);
                  setPicked(next);
                }}
              />
              <span className="min-w-0 flex-1 truncate">
                {v.text === '' ? tr('（空白）') : v.text}
              </span>
              <span className="text-caption text-fg-subtle tabular-nums">{v.count}</span>
            </label>
          ))}
          {shown.length === 0 && (
            <p className="px-2 py-3 text-center text-caption text-fg-muted">{tr('没有匹配的值')}</p>
          )}
        </div>
        <div className="mt-1 flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => p.onApply(null)}>
            {tr('清除筛选')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => p.onApply(picked.size === p.values.length ? null : [...picked])}
          >
            {tr('确定')}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
