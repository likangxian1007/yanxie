import { useMemo } from 'react';
import { FileQuestion } from 'lucide-react';
import {
  compareCellRefs,
  notebookCellChanges,
  sheetCellChanges,
  splitSegments,
  type NotebookCellSnapshot,
  type SheetSnapshot,
  type VersionContent,
} from '@srh/shared';
import { Badge, Markdown } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatBytes } from '../lib';
import { SeqDiff } from './SeqDiff';
import { tr } from '@/lib/i18n';

/** 两份版本内容的对比：文本逐段 / 逐行，表格逐单元格，notebook 逐单元格 */
export function ContentDiff({ before, after }: { before: VersionContent; after: VersionContent }) {
  if (before.format === 'text' && after.format === 'text') {
    const unit = after.unit;
    const a = splitSegments(before.text, unit);
    const b = splitSegments(after.text, unit);
    if (before.text === after.text) return <Same />;
    return <SeqDiff before={a} after={b} unit={unit} mono={after.language !== 'markdown'} />;
  }
  if (before.format === 'sheet' && after.format === 'sheet') {
    return <SheetDiff before={before.sheets} after={after.sheets} />;
  }
  if (before.format === 'notebook' && after.format === 'notebook') {
    return <NotebookDiff before={before.cells} after={after.cells} />;
  }
  if (before.format === 'binary' || after.format === 'binary') {
    const size = (c: VersionContent) => (c.format === 'binary' ? c.size : 0);
    return (
      <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
        {tr('二进制文件不逐行对比。大小：{value} → {value2}。', {
          value: formatBytes(size(before)),
          value2: formatBytes(size(after)),
        })}
      </p>
    );
  }
  return (
    <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
      {tr('两个版本的格式不同，无法逐项对比。')}
    </p>
  );
}

function Same() {
  return (
    <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
      {tr('两个版本内容完全一致。')}
    </p>
  );
}

function SheetDiff({ before, after }: { before: SheetSnapshot[]; after: SheetSnapshot[] }) {
  const changes = useMemo(() => sheetCellChanges(before, after), [before, after]);
  if (!changes.length) return <Same />;
  const multi = new Set(changes.map((c) => c.sheet)).size > 1 || after.length > 1;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <p className="border-b border-line bg-subtle px-3 py-1.5 text-caption text-fg-muted tabular-nums">
        {tr('{count} 个单元格有变化', { count: changes.length })}
      </p>
      <ul className="divide-y divide-line text-small">
        {changes.map((c) => (
          <li
            key={`${c.sheet}!${c.ref}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
          >
            <span className="w-20 shrink-0 font-mono text-caption text-fg-muted">
              {multi ? `${c.sheet}!` : ''}
              {c.ref}
            </span>
            <CellChange old={c.old} next={c.new} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CellChange({ old, next }: { old: string; next: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
      {old ? (
        <span className="rounded-sm bg-danger-soft px-1.5 font-mono text-caption break-all text-fg-muted line-through decoration-danger/60">
          <span className="sr-only">{tr('原值：')}</span>
          {old}
        </span>
      ) : (
        <span className="text-caption text-fg-subtle">{tr('空')}</span>
      )}
      <span aria-hidden className="text-fg-subtle">
        →
      </span>
      {next ? (
        <span className="rounded-sm bg-success-soft px-1.5 font-mono text-caption break-all text-fg">
          <span className="sr-only">{tr('新值：')}</span>
          {next}
        </span>
      ) : (
        <span className="text-caption text-fg-subtle">{tr('清空')}</span>
      )}
    </span>
  );
}

const NB_STATUS = {
  add: { label: tr('新增'), tone: 'success' },
  remove: { label: tr('删除'), tone: 'danger' },
  modify: { label: tr('修改'), tone: 'warning' },
} as const;

function NotebookDiff({
  before,
  after,
}: {
  before: NotebookCellSnapshot[];
  after: NotebookCellSnapshot[];
}) {
  const changes = useMemo(() => notebookCellChanges(before, after), [before, after]);
  const changed = changes.filter((c) => c.status !== 'same');
  if (!changed.length) return <Same />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-muted tabular-nums">
        {tr('{count} 个单元格有变化，{value} 个未变', {
          count: changed.length,
          value: changes.length - changed.length,
        })}
      </p>
      {changed.map((c) => (
        <NotebookCellDiff
          key={`${c.status}:${c.cellId}`}
          status={c.status as 'add' | 'remove' | 'modify'}
          cellType={c.cellType}
          old={c.old}
          next={c.new}
        />
      ))}
    </div>
  );
}

export function NotebookCellDiff({
  status,
  cellType,
  old,
  next,
  className,
}: {
  status: 'add' | 'remove' | 'modify';
  cellType: string;
  old: string;
  next: string;
  className?: string;
}) {
  const s = NB_STATUS[status];
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex items-center gap-2 text-caption text-fg-muted">
        <Badge tone={s.tone}>{s.label}</Badge>
        <span>{cellType === 'markdown' ? tr('Markdown 单元格') : tr('代码单元格')}</span>
      </div>
      <SeqDiff
        before={status === 'add' ? [] : old.split('\n')}
        after={status === 'remove' ? [] : next.split('\n')}
        unit="line"
        mono
      />
    </div>
  );
}

// ---------------------------------------------------------------- 单个版本的预览

export function ContentPreview({ content }: { content: VersionContent }) {
  switch (content.format) {
    case 'text':
      if (!content.text.trim()) return <EmptyContent />;
      return content.language === 'markdown' ? (
        <Markdown size="compact">{content.text}</Markdown>
      ) : (
        <pre className="overflow-x-auto rounded-md border border-line bg-surface p-3 font-mono text-caption whitespace-pre-wrap text-fg">
          {content.text}
        </pre>
      );
    case 'sheet':
      return <SheetPreview sheets={content.sheets} />;
    case 'notebook':
      return content.cells.length ? (
        <ol className="flex flex-col gap-2">
          {content.cells.map((c, i) => (
            <li key={c.id} className="min-w-0">
              <p className="mb-1 text-caption text-fg-subtle">
                [{i + 1}] {c.type === 'markdown' ? 'Markdown' : tr('代码')}
              </p>
              <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2.5 font-mono text-caption whitespace-pre-wrap text-fg">
                {c.source || ' '}
              </pre>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyContent />
      );
    case 'binary':
      return (
        <div className="flex items-center gap-3 rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
          <FileQuestion size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
          {tr('二进制文件（')}
          {content.mime}
          {tr('，')}
          {formatBytes(content.size)}
          {tr('），不在这里预览。')}
        </div>
      );
  }
}

function EmptyContent() {
  return <p className="text-small text-fg-subtle">{tr('这个版本的内容是空的。')}</p>;
}

const PREVIEW_ROWS = 40;
const PREVIEW_COLS = 12;

function SheetPreview({ sheets }: { sheets: SheetSnapshot[] }) {
  if (!sheets.some((s) => Object.keys(s.cells).length)) return <EmptyContent />;
  return (
    <div className="flex flex-col gap-4">
      {sheets.map((s) => {
        const refs = Object.keys(s.cells).sort(compareCellRefs);
        let maxR = 0;
        let maxC = 0;
        const grid = new Map<string, string>();
        for (const ref of refs) {
          const m = /^([A-Z]+)(\d+)$/u.exec(ref);
          if (!m) continue;
          let c = 0;
          for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64);
          const r = Number(m[2]);
          maxR = Math.max(maxR, r);
          maxC = Math.max(maxC, c);
          grid.set(`${r}:${c}`, s.cells[ref]!);
        }
        const rows = Math.min(maxR, PREVIEW_ROWS);
        const cols = Math.min(maxC, PREVIEW_COLS);
        return (
          <div key={s.name} className="min-w-0">
            {sheets.length > 1 && <p className="mb-1 text-caption text-fg-muted">{s.name}</p>}
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="text-caption tabular-nums">
                <tbody>
                  {Array.from({ length: rows }, (_, r) => (
                    <tr key={r} className="border-b border-line last:border-b-0">
                      <th className="bg-subtle px-2 py-1 text-right font-normal text-fg-subtle">
                        {r + 1}
                      </th>
                      {Array.from({ length: cols }, (_, c) => (
                        <td
                          key={c}
                          className="max-w-40 truncate border-l border-line px-2 py-1 text-fg"
                        >
                          {grid.get(`${r + 1}:${c + 1}`) ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(maxR > rows || maxC > cols) && (
              <p className="mt-1 text-caption text-fg-subtle">
                {tr('只显示前 {rows} 行、{cols} 列。', { rows, cols })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
