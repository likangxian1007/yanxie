import { lazy, Suspense, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ChevronDown,
  Download,
  FileText,
  RefreshCw,
  ScrollText,
} from 'lucide-react';
import { Button, IconButton, Spinner, Tabs } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { LatexCompileState } from './useLatexCompile';
import { locale, tr } from '@/lib/i18n';

const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));

export type PreviewKind = 'pdf' | 'draft';

interface PreviewPaneProps {
  compile: LatexCompileState;
  kind: PreviewKind;
  onKindChange: (k: PreviewKind) => void;
  onDownloadPdf: () => void;
  /** 草稿预览（LatexPreview） */
  draft: ReactNode;
  className?: string;
}

function statusText(c: LatexCompileState): {
  text: string;
  title?: string;
  tone: 'muted' | 'danger' | 'warning';
} {
  if (c.compiling) return { text: tr('编译中…'), tone: 'muted' };
  if (c.error) return { text: c.error, tone: 'danger' };
  const r = c.result;
  if (!r) return { text: c.available ? tr('还没有编译') : '', tone: 'muted' };
  const secs = (r.durationMs / 1000).toFixed(1);
  const errorIssues = c.issues.filter((i) => i.severity === 'error');
  const errors = errorIssues.length;
  if (r.status === 'timeout') return { text: tr('编译超时'), tone: 'danger' };
  if (r.status === 'rejected') return { text: tr('没有编译：工程不合法'), tone: 'danger' };
  // 只有参考文献库缺失：正文照常排好了，只是引用是 [?]、没有参考文献列表——说清楚缺的是什么
  if (
    r.pdfId &&
    errors > 0 &&
    errorIssues.every((i) => i.kind === 'missing_bib' && /\.bib\b/u.test(i.raw))
  ) {
    return {
      text: tr('缺 .bib，引用显示为 [?]'),
      title: tr(
        '参考文献没有编进去：工程里找不到 \\bibliography 引用的 .bib 文件，正文照常排版，引用显示为 [?]',
      ),
      tone: 'danger',
    };
  }
  if (r.status === 'error' || errors > 0) {
    return {
      text: r.pdfId
        ? tr('{value} 个错误 · PDF 可能不完整', { value: errors || 1 })
        : tr('{value} 个错误 · 没有生成 PDF', { value: errors || 1 }),
      tone: 'danger',
    };
  }
  const time = new Date(r.compiledAt).toLocaleTimeString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    text: tr('{time} 编译 · {value}', {
      time,
      value: r.cached ? tr('内容没变') : tr('{secs} 秒', { secs }),
    }),
    tone: 'muted',
  };
}

/** 预览栏：PDF（真编译）/ 草稿预览（即时 HTML）切换，带编译状态和原始日志 */
export function PreviewPane({
  compile: c,
  kind,
  onKindChange,
  onDownloadPdf,
  draft,
  className,
}: PreviewPaneProps) {
  const [logOpen, setLogOpen] = useState(false);
  const reduce = useReducedMotion();
  const showPdf = kind === 'pdf' && c.available;
  const status = statusText(c);

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-col', className)}>
      {c.available && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
          <Tabs
            variant="segmented"
            size="sm"
            layoutId="latex-preview-kind"
            aria-label={tr('预览方式')}
            value={kind}
            onValueChange={(v) => onKindChange(v as PreviewKind)}
            items={[
              { value: 'pdf', label: 'PDF' },
              { value: 'draft', label: tr('草稿预览') },
            ]}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-caption',
              status.tone === 'danger' ? 'text-danger' : 'text-fg-subtle',
            )}
            aria-live="polite"
            title={status.title ?? status.text}
          >
            {c.compiling && <Spinner size={12} className="mr-1 inline-block align-[-2px]" />}
            {status.text}
            {!c.compiling && c.stale && c.result && status.tone === 'muted' && tr(' · 有新改动')}
          </span>
          {c.result && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={logOpen}
              aria-controls="ltx-raw-log"
              leftIcon={<ScrollText strokeWidth={1.75} aria-hidden />}
              rightIcon={
                <ChevronDown
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn('transition-transform duration-150', logOpen && 'rotate-180')}
                />
              }
              onClick={() => setLogOpen((v) => !v)}
            >
              <span className="hidden md:inline">{tr('日志')}</span>
            </Button>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {showPdf ? (
          c.pdf ? (
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center bg-subtle">
                  <Spinner label={tr('正在加载 PDF 阅读器')} />
                </div>
              }
            >
              <PdfViewer
                data={c.pdf}
                className="flex-1"
                actions={
                  <IconButton label={tr('下载 PDF')} size="sm" onClick={onDownloadPdf}>
                    <Download strokeWidth={1.75} aria-hidden />
                  </IconButton>
                }
              />
            </Suspense>
          ) : (
            <PdfPlaceholder
              c={c}
              onShowLog={() => setLogOpen(true)}
              onDraft={() => onKindChange('draft')}
            />
          )
        ) : null}
        {/* 草稿预览一直挂着（滚动位置、大纲跳转锚点都在它里面），显示 PDF 时只是隐藏 */}
        <div className={cn('flex min-h-0 flex-1 flex-col', showPdf && 'hidden')}>{draft}</div>

        <AnimatePresence>
          {logOpen && c.result && (
            <motion.section
              id="ltx-raw-log"
              key="log"
              aria-label={tr('原始编译日志')}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
              transition={{ duration: 0.16 }}
              className="absolute inset-x-0 bottom-0 z-overlay flex max-h-[55%] flex-col border-t border-line bg-surface shadow-lg"
            >
              <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
                <FileText size={14} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
                <span className="text-small text-fg">{tr('原始日志')}</span>
                <span className="text-caption text-fg-subtle">
                  {c.result.engine}
                  {c.result.logTruncated ? tr(' · 已截断') : ''}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setLogOpen(false)}
                >
                  {tr('收起')}
                </Button>
              </header>
              <pre className="ltx-log min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all text-fg-muted">
                {c.result.log || tr('（日志是空的）')}
              </pre>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PdfPlaceholder({
  c,
  onShowLog,
  onDraft,
}: {
  c: LatexCompileState;
  onShowLog: () => void;
  onDraft: () => void;
}) {
  if (c.compiling || (!c.result && !c.error)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-subtle px-6 text-center">
        <Spinner label={tr('正在编译')} />
        <p className="max-w-xs text-small text-fg-muted">
          {tr(
            '正在编译 PDF。第一次用到某些宏包（比如 ctex 中文字体）时服务器要先下载，可能需要一两分钟。',
          )}
        </p>
        <Button variant="ghost" size="sm" onClick={onDraft}>
          {tr('先看草稿预览')}
        </Button>
      </div>
    );
  }
  const errors = c.issues.filter((i) => i.severity === 'error').slice(0, 3);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-subtle px-6 text-center">
      <AlertTriangle size={24} strokeWidth={1.75} aria-hidden className="text-danger" />
      <p className="text-h3 text-fg">{c.error ? tr('编译请求失败') : tr('这次编译没有生成 PDF')}</p>
      {c.error ? (
        <p className="max-w-sm text-small text-fg-muted">{c.error}</p>
      ) : (
        <ul className="max-w-sm space-y-1 text-left text-small text-fg-muted">
          {errors.map((e, i) => (
            <li key={i}>
              {e.line !== null && (
                <span className="mr-1 font-mono text-caption text-fg-subtle">
                  {e.file && e.file !== 'main.tex' ? `${e.file}:` : tr('第 ')}
                  {e.line}
                  {e.file && e.file !== 'main.tex' ? '' : tr(' 行')}
                </span>
              )}
              {e.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {c.result && (
          <Button variant="secondary" size="sm" onClick={onShowLog}>
            {tr('查看日志')}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<RefreshCw strokeWidth={1.75} aria-hidden />}
          onClick={() => void c.compile({ force: true })}
        >
          {tr('重新编译')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDraft}>
          {tr('看草稿预览')}
        </Button>
      </div>
    </div>
  );
}
