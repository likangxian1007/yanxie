import { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { diffLines, diffStats, toSegments, type DiffLine } from '../lib/diff';
import { tr } from '@/lib/i18n';

export interface DiffViewProps {
  /** 发起审阅时的快照 */
  before: string;
  /** 当前版本 */
  after: string;
}

const ROW: Record<DiffLine['kind'], string> = {
  same: 'text-fg',
  add: 'bg-success-soft text-fg',
  del: 'bg-danger-soft text-fg-muted line-through decoration-danger/60',
};

const SIGN: Record<DiffLine['kind'], string> = { same: ' ', add: '+', del: '−' };
const SR: Record<DiffLine['kind'], string> = { same: '', add: tr('新增：'), del: tr('删除：') };

/** 行级对比（像 PR 的 Files changed）：新增行 success-soft 底，删除行 danger-soft 底 + 删除线；大段未改动折叠。 */
export function DiffView({ before, after }: DiffViewProps) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const segments = useMemo(() => toSegments(lines), [lines]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (stats.added === 0 && stats.removed === 0) {
    return (
      <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
        {tr('当前版本与发起审阅时完全一致，没有新的改动。')}
      </p>
    );
  }

  const renderLine = (l: DiffLine, i: number) => (
    <li key={i} className={cn('flex min-w-0', ROW[l.kind])}>
      <span
        aria-hidden
        className={cn(
          'w-6 shrink-0 text-center select-none',
          l.kind === 'add' && 'text-success',
          l.kind === 'del' && 'text-danger',
          l.kind === 'same' && 'text-fg-subtle',
        )}
      >
        {SIGN[l.kind]}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
        {SR[l.kind] && <span className="sr-only">{SR[l.kind]}</span>}
        {l.text || ' '}
      </span>
    </li>
  );

  return (
    <div>
      <p className="mb-2 flex items-center gap-3 text-caption tabular-nums">
        <span className="text-success">{tr('+{added} 行', { added: stats.added })}</span>
        <span className="text-danger">{tr('−{removed} 行', { removed: stats.removed })}</span>
        <span className="font-normal text-fg-subtle">{tr('相对发起审阅时的快照')}</span>
      </p>
      <div className="overflow-hidden rounded-md border border-line bg-surface font-mono text-small leading-relaxed">
        {segments.map((seg, si) => {
          if (seg.type === 'lines' || expanded.has(seg.id)) {
            return (
              <ol key={si} className="py-0.5">
                {seg.lines.map(renderLine)}
              </ol>
            );
          }
          return (
            <button
              key={si}
              type="button"
              onClick={() => setExpanded((s) => new Set(s).add(seg.id))}
              className="flex w-full cursor-pointer items-center gap-2 border-y border-line bg-subtle px-3 py-1 font-sans text-caption text-fg-muted first:border-t-0 last:border-b-0 hover:text-fg"
            >
              <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
              {tr('展开 ')}
              {seg.lines.length}
              {tr(' 行未改动的内容')}
            </button>
          );
        })}
      </div>
    </div>
  );
}
