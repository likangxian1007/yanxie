import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { diffLines, diffStats, toSegments, type DiffLine } from '@/features/reviews/lib/diff';
import { tr } from '@/lib/i18n';

interface AiDiffProps {
  /** 被替换的原文 */
  before: string;
  /** AI 给的新内容 */
  after: string;
  /** 原文第一行在文件里的行号 */
  startLine: number;
}

const ROW: Record<DiffLine['kind'], string> = {
  same: 'text-fg',
  add: 'bg-success-soft text-fg',
  del: 'bg-danger-soft text-fg-muted line-through decoration-danger/60',
};
const SIGN: Record<DiffLine['kind'], string> = { same: ' ', add: '+', del: '−' };
const SR: Record<DiffLine['kind'], string> = { same: '', add: tr('新增：'), del: tr('删除：') };

/** AI 修改前后的行级差异：删除行 danger-soft 底 + 删除线，新增行 success-soft 底；行号是文件里的行号。 */
export function AiDiff({ before, after, startLine }: AiDiffProps) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const segments = useMemo(() => toSegments(lines, 2, 4), [lines]);

  if (stats.added === 0 && stats.removed === 0) {
    return (
      <p className="px-4 py-3 text-small text-fg-muted">
        {tr('AI 给的内容和原文完全一样，没有改动。')}
      </p>
    );
  }

  return (
    <div aria-label={tr('修改前后的差异')}>
      <p className="flex items-center gap-3 px-4 pt-2 pb-1 text-caption tabular-nums">
        <span className="text-success">{tr('+{added} 行', { added: stats.added })}</span>
        <span className="text-danger">{tr('−{removed} 行', { removed: stats.removed })}</span>
      </p>
      <div className="font-mono text-small leading-relaxed">
        {segments.map((seg, si) =>
          seg.type === 'collapsed' ? (
            <p
              key={si}
              className="border-y border-line bg-subtle px-4 py-0.5 font-sans text-caption text-fg-subtle"
            >
              {tr('{count} 行没有改动', { count: seg.lines.length })}
            </p>
          ) : (
            <ol key={si} className="py-0.5">
              {seg.lines.map((l, i) => (
                <li key={i} data-kind={l.kind} className={cn('flex min-w-0', ROW[l.kind])}>
                  <span
                    aria-hidden
                    className="w-10 shrink-0 pr-1 text-right text-fg-subtle tabular-nums select-none"
                  >
                    {l.oldNo !== null ? startLine + l.oldNo - 1 : ''}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'w-5 shrink-0 text-center select-none',
                      l.kind === 'add' && 'text-success',
                      l.kind === 'del' && 'text-danger',
                    )}
                  >
                    {SIGN[l.kind]}
                  </span>
                  <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
                    {SR[l.kind] && <span className="sr-only">{SR[l.kind]}</span>}
                    {l.text || ' '}
                  </span>
                </li>
              ))}
            </ol>
          ),
        )}
      </div>
    </div>
  );
}
