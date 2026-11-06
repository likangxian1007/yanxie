import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleX, Info, Sparkles } from 'lucide-react';
import { Badge, Button, Popover } from '@/components/ui';
import { cn } from '@/lib/cn';
import { isAiFixable, type LatexIssue } from '../compile/issues';
import { tr } from '@/lib/i18n';

interface IssuesPopoverProps {
  /** 真编译解析出的问题；null = 还没有编译结果（只有草稿检查） */
  compileIssues: LatexIssue[] | null;
  /** 草稿预览的检查结果 */
  draftIssues: LatexIssue[];
  /** 是否有还没刷新到预览 / 编译的改动 */
  pending: boolean;
  canFix: boolean;
  onJump: (issue: LatexIssue) => void;
  onFix: (issue: LatexIssue) => void;
}

const MAX_SHOWN = 200;

function where(i: LatexIssue): string {
  const file = i.file && i.file !== 'main.tex' ? i.file : null;
  if (i.line === null) return file ?? '';
  return file ? `${file}:${i.line}` : tr('第 {line} 行', { line: i.line });
}

function SeverityIcon({ severity }: { severity: LatexIssue['severity'] }) {
  if (severity === 'error')
    return <CircleX size={14} strokeWidth={1.75} aria-label={tr('错误')} className="text-danger" />;
  if (severity === 'info')
    return <Info size={14} strokeWidth={1.75} aria-label={tr('提示')} className="text-fg-subtle" />;
  return (
    <AlertTriangle size={14} strokeWidth={1.75} aria-label={tr('警告')} className="text-warning" />
  );
}

/** 工具栏上的“编译问题”计数徽标，点开列出问题；点击跳到对应文件和行，或交给 AI 修复。 */
export function IssuesPopover({
  compileIssues,
  draftIssues,
  pending,
  canFix,
  onJump,
  onFix,
}: IssuesPopoverProps) {
  const [open, setOpen] = useState(false);
  const compiled = compileIssues ?? [];
  // 编译已经报出的同一位置，草稿检查就不再重复
  const seen = new Set(compiled.map((i) => `${i.file ?? 'main.tex'}:${i.line}`));
  const draft = draftIssues.filter((i) => !seen.has(`${i.file ?? 'main.tex'}:${i.line}`));
  const errors = compiled.filter((i) => i.severity === 'error').length;
  const counted = compiled.filter((i) => i.severity !== 'info').length + draft.length;
  const total = compiled.length + draft.length;

  const renderItem = (w: LatexIssue, i: number) => {
    const loc = where(w);
    return (
      <li key={`${w.source}-${i}`} className="group flex items-start gap-2 px-2 py-0.5">
        <button
          type="button"
          disabled={w.line === null && !w.file}
          className={cn(
            'press flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left',
            'hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            'disabled:cursor-default disabled:hover:bg-transparent',
          )}
          onClick={() => {
            setOpen(false);
            onJump(w);
          }}
        >
          <span className="mt-0.5 shrink-0">
            <SeverityIcon severity={w.severity} />
          </span>
          <span className="min-w-0 flex-1">
            {loc && (
              <span className="mr-2 font-mono text-caption text-fg-subtle tabular-nums">{loc}</span>
            )}
            <span className="text-small break-words text-fg">{w.message}</span>
          </span>
        </button>
        {canFix && isAiFixable(w) && w.line !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-0.5 shrink-0 text-agent-text"
            leftIcon={<Sparkles strokeWidth={1.75} aria-hidden className="text-agent" />}
            onClick={() => {
              setOpen(false);
              onFix(w);
            }}
          >
            <span className="hidden sm:inline">{tr('让 AI 修复')}</span>
            <span className="sm:hidden">{tr('修复')}</span>
          </Button>
        )}
      </li>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={tr('编译问题')}
      align="end"
      className="w-[min(460px,calc(100vw-24px))] p-0"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            counted > 0
              ? tr('{counted} 个编译问题{value}', {
                  counted,
                  value: errors > 0 ? tr('，其中 {errors} 个错误', { errors }) : '',
                })
              : tr('没有编译问题')
          }
          leftIcon={
            errors > 0 ? (
              <CircleX strokeWidth={1.75} aria-hidden className="text-danger" />
            ) : counted > 0 ? (
              <AlertTriangle strokeWidth={1.75} aria-hidden className="text-warning" />
            ) : (
              <CheckCircle2 strokeWidth={1.75} aria-hidden className="text-success" />
            )
          }
        >
          <span className="hidden sm:inline">{counted > 0 ? tr('问题') : tr('无问题')}</span>
          {counted > 0 && (
            <Badge tone={errors > 0 ? 'danger' : 'warning'} animateKey={counted}>
              {counted > 99 ? '99+' : counted}
            </Badge>
          )}
        </Button>
      }
    >
      <div className="flex max-h-[min(60vh,520px)] flex-col">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h3 className="text-h3 text-fg">{tr('编译问题')}</h3>
          <span className="text-caption text-fg-subtle">
            {pending
              ? tr('有新的改动还没检查')
              : compileIssues
                ? tr('编译 {errors} 个错误 · 共 {counted} 个', { errors, counted })
                : tr('共 {counted} 个', { counted })}
          </span>
        </header>
        {total === 0 ? (
          <p className="px-3 py-6 text-center text-small text-fg-muted">
            {compileIssues
              ? tr('编译和草稿检查都没有发现问题。')
              : tr('草稿检查没有发现问题。编译后这里会列出 LaTeX 报出的错误和警告。')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {compiled.length > 0 && (
              <section aria-label={tr('编译结果')}>
                <h4 className="px-4 pt-1 pb-0.5 text-caption text-fg-subtle">{tr('编译日志')}</h4>
                <ul aria-label={tr('编译日志里的问题')}>
                  {compiled.slice(0, MAX_SHOWN).map(renderItem)}
                </ul>
              </section>
            )}
            {draft.length > 0 && (
              <section aria-label={tr('草稿检查')}>
                <h4 className="px-4 pt-2 pb-0.5 text-caption text-fg-subtle">
                  {tr('草稿检查（只查常见错误，以编译结果为准）')}
                </h4>
                <ul aria-label={tr('问题列表')}>{draft.slice(0, MAX_SHOWN).map(renderItem)}</ul>
              </section>
            )}
            {total > MAX_SHOWN * 2 && (
              <p className="px-4 py-2 text-caption text-fg-subtle">
                {tr('问题太多，只列出了一部分，先修复上面的吧。')}
              </p>
            )}
          </div>
        )}
      </div>
    </Popover>
  );
}
