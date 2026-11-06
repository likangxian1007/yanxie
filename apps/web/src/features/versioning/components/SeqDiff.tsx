import { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { diffSeq, type DiffOp } from '@srh/shared';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

/**
 * 序列对比（段落或行）：新增 success-soft 底，删除 danger-soft 底 + 删除线；
 * 大段未改动的内容折叠，点开展开。和审阅里的 DiffView 一个样子。
 */
const ROW: Record<DiffOp['kind'], string> = {
  same: 'text-fg',
  add: 'bg-success-soft text-fg',
  del: 'bg-danger-soft text-fg-muted line-through decoration-danger/60',
};
const SIGN: Record<DiffOp['kind'], string> = { same: ' ', add: '+', del: '−' };
const SR: Record<DiffOp['kind'], string> = { same: '', add: tr('新增：'), del: tr('删除：') };

/** 改动前后各留几条上下文，更远的未改动内容折叠 */
const CONTEXT = 2;

type Segment = { type: 'ops'; ops: DiffOp[] } | { type: 'fold'; id: string; ops: DiffOp[] };

function segments(ops: DiffOp[]): Segment[] {
  const keep = ops.map((o) => o.kind !== 'same');
  const near = ops.map((_, i) => {
    for (let d = -CONTEXT; d <= CONTEXT; d += 1) if (keep[i + d]) return true;
    return false;
  });
  const out: Segment[] = [];
  let i = 0;
  while (i < ops.length) {
    const start = i;
    const visible = near[i];
    while (i < ops.length && near[i] === visible) i += 1;
    const run = ops.slice(start, i);
    if (visible || run.length <= 3) out.push({ type: 'ops', ops: run });
    else out.push({ type: 'fold', id: `f${start}`, ops: run });
  }
  return out;
}

export function SeqDiff({
  before,
  after,
  unit,
  mono,
  className,
}: {
  before: string[];
  after: string[];
  unit: 'block' | 'line';
  /** 等宽字体（源码） */
  mono?: boolean;
  className?: string;
}) {
  const ops = useMemo(() => diffSeq(before, after), [before, after]);
  const segs = useMemo(() => segments(ops), [ops]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const noun = unit === 'block' ? tr('段') : tr('行');

  const row = (o: DiffOp, i: number) => (
    <li key={i} className={cn('flex min-w-0', ROW[o.kind], unit === 'block' && 'py-1')}>
      <span
        aria-hidden
        className={cn(
          'w-6 shrink-0 text-center select-none',
          o.kind === 'add' && 'text-success',
          o.kind === 'del' && 'text-danger',
          o.kind === 'same' && 'text-fg-subtle',
        )}
      >
        {SIGN[o.kind]}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
        {SR[o.kind] && <span className="sr-only">{SR[o.kind]}</span>}
        {o.text || ' '}
      </span>
    </li>
  );

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-line bg-surface text-small leading-relaxed',
        mono && 'font-mono',
        className,
      )}
    >
      {segs.map((s, si) =>
        s.type === 'ops' || open.has(s.id) ? (
          <ol
            key={si}
            className={cn(
              'py-0.5',
              unit === 'block' && 'divide-y divide-line border-line not-first:border-t',
            )}
          >
            {s.ops.map(row)}
          </ol>
        ) : (
          <button
            key={si}
            type="button"
            onClick={() => setOpen((x) => new Set(x).add(s.id))}
            className="flex w-full cursor-pointer items-center gap-2 border-y border-line bg-subtle px-3 py-1 font-sans text-caption text-fg-muted first:border-t-0 last:border-b-0 hover:text-fg"
          >
            <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
            {tr('展开 ')}
            {s.ops.length} {noun}
            {tr('未改动的内容')}
          </button>
        ),
      )}
    </div>
  );
}
