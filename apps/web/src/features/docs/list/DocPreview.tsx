import type { DocumentKind } from '@srh/shared';
import { cn } from '@/lib/cn';
import { paletteSoft } from '@/lib/palette';
import { DOC_KIND_META } from '../kinds';
import { excerptCells, excerptLines } from './excerpt';
import { tr } from '@/lib/i18n';

const GRID_TEXTURE =
  'bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] bg-[size:25%_20%]';

/** 网格视图卡片上半部分的内容预览（按类型不同） */
export function DocPreview({ kind, excerpt }: { kind: DocumentKind; excerpt: string }) {
  const tone = DOC_KIND_META[kind].tone;

  if (kind === 'sheet') {
    const cells = excerptCells(excerpt, 5, 4);
    return (
      <div className={cn('relative h-full overflow-hidden rounded-sm bg-surface', GRID_TEXTURE)}>
        <div className="grid grid-cols-4 grid-rows-5 text-[0.6875rem] leading-none text-fg-muted">
          {Array.from({ length: 20 }, (_, i) => {
            const text = cells[Math.floor(i / 4)]?.[i % 4] ?? '';
            return (
              <span
                key={i}
                className={cn(
                  'truncate px-1 py-[5px] tabular-nums',
                  i < 4 && 'font-medium text-fg',
                )}
                style={i < 4 ? { backgroundColor: paletteSoft(tone) } : undefined}
              >
                {text}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  if (kind === 'slides') {
    const [title, ...rest] = excerptLines(excerpt, 3);
    return (
      <div className="grid h-full place-items-center">
        <div className="flex aspect-video h-full max-w-full flex-col justify-center gap-1 overflow-hidden rounded-xs border border-line bg-surface px-3 shadow-xs">
          <span className="truncate text-caption text-fg">{title || tr('标题')}</span>
          {rest.length > 0 ? (
            rest.map((l, i) => (
              <span key={i} className="truncate text-[0.6875rem] text-fg-muted">
                {l}
              </span>
            ))
          ) : (
            <>
              <span aria-hidden className="h-1 w-3/4 rounded-full bg-muted" />
              <span aria-hidden className="h-1 w-1/2 rounded-full bg-muted" />
            </>
          )}
        </div>
      </div>
    );
  }

  if (kind === 'latex') {
    const lines = excerptLines(excerpt, 5);
    return (
      <pre className="h-full overflow-hidden rounded-sm bg-subtle px-2.5 py-2 font-mono text-[0.6875rem] leading-[1.45] whitespace-pre-wrap text-fg-muted">
        {lines.length ? lines.join('\n') : '\\documentclass{article}\n\\begin{document}\n…'}
      </pre>
    );
  }

  const lines = excerptLines(excerpt, 5);
  return (
    <div className="flex h-full flex-col gap-1 overflow-hidden px-1 pt-0.5">
      {lines.length ? (
        lines.map((l, i) => (
          <span
            key={i}
            className={cn(
              'truncate text-[0.6875rem] leading-[1.45]',
              i === 0 ? 'font-medium text-fg' : 'text-fg-muted',
            )}
          >
            {l}
          </span>
        ))
      ) : (
        <span className="text-caption font-normal text-fg-subtle">{tr('空白文档')}</span>
      )}
    </div>
  );
}
