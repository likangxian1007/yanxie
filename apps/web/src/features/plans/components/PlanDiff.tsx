import { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { diffStats, lineDiff, type LineDiffOp } from '@srh/shared';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

const ROW: Record<LineDiffOp['op'], string> = {
  eq: 'text-fg',
  add: 'bg-success-soft text-fg',
  del: 'bg-danger-soft text-fg-muted line-through decoration-danger/60',
};
const SIGN: Record<LineDiffOp['op'], string> = { eq: ' ', add: '+', del: '−' };
const SR: Record<LineDiffOp['op'], string> = { eq: '', add: tr('新增：'), del: tr('删除：') };

/** 前后各保留的上下文行数；更长的未改动片段折叠 */
const CONTEXT = 2;

type Segment =
  { type: 'lines'; ops: LineDiffOp[] } | { type: 'fold'; id: string; ops: LineDiffOp[] };

function toSegments(ops: LineDiffOp[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op !== 'eq') {
      const start = i;
      while (i < ops.length && ops[i]!.op !== 'eq') i++;
      out.push({ type: 'lines', ops: ops.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < ops.length && ops[i]!.op === 'eq') i++;
    const run = ops.slice(start, i);
    const head = start === 0 ? 0 : CONTEXT;
    const tail = i === ops.length ? 0 : CONTEXT;
    if (run.length <= head + tail + 2) {
      out.push({ type: 'lines', ops: run });
    } else {
      if (head) out.push({ type: 'lines', ops: run.slice(0, head) });
      out.push({ type: 'fold', id: `f${start}`, ops: run.slice(head, run.length - tail) });
      if (tail) out.push({ type: 'lines', ops: run.slice(run.length - tail) });
    }
  }
  return out;
}

export interface PlanDiffProps {
  before: string;
  after: string;
  /** 统计行后的说明，例如“相对第 3 版” */
  caption?: string;
  /** 没有改动时的提示 */
  emptyText?: string;
}

/** 方案行级对比：新增 success-soft 底，删除 danger-soft 底 + 删除线，长段未改动折叠。 */
export function PlanDiff({
  before,
  after,
  caption,
  emptyText = tr('两份内容一致，没有改动。'),
}: PlanDiffProps) {
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = useMemo(() => diffStats(ops), [ops]);
  const segments = useMemo(() => toSegments(ops), [ops]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (stats.added === 0 && stats.removed === 0) {
    return <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">{emptyText}</p>;
  }

  const renderLine = (l: LineDiffOp, i: number) => (
    <li key={i} className={cn('flex min-w-0', ROW[l.op])}>
      <span
        aria-hidden
        className={cn(
          'w-6 shrink-0 text-center select-none',
          l.op === 'add' && 'text-success',
          l.op === 'del' && 'text-danger',
          l.op === 'eq' && 'text-fg-subtle',
        )}
      >
        {SIGN[l.op]}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
        {SR[l.op] && <span className="sr-only">{SR[l.op]}</span>}
        {l.text || ' '}
      </span>
    </li>
  );

  return (
    <div className="min-w-0">
      <DiffStatsLine added={stats.added} removed={stats.removed} caption={caption} />
      <div className="overflow-hidden rounded-md border border-line bg-surface font-mono text-small leading-relaxed">
        {segments.map((seg, si) =>
          seg.type === 'lines' || expanded.has(seg.id) ? (
            <ol key={si} className="py-0.5">
              {seg.ops.map(renderLine)}
            </ol>
          ) : (
            <button
              key={si}
              type="button"
              onClick={() => setExpanded((s) => new Set(s).add(seg.id))}
              className="flex min-h-8 w-full cursor-pointer items-center gap-2 border-y border-line bg-subtle px-3 py-1 font-sans text-caption text-fg-muted first:border-t-0 last:border-b-0 hover:text-fg"
            >
              <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
              {tr('展开 ')}
              {seg.ops.length}
              {tr(' 行未改动的内容')}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function DiffStatsLine({
  added,
  removed,
  caption,
}: {
  added: number;
  removed: number;
  caption?: string | undefined;
}) {
  return (
    <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption tabular-nums">
      <span className="text-success">{tr('+{added} 行', { added })}</span>
      <span className="text-danger">{tr('−{removed} 行', { removed })}</span>
      {caption && <span className="font-normal text-fg-subtle">{caption}</span>}
    </p>
  );
}
