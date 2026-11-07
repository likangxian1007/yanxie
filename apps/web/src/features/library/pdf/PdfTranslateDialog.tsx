import { useState } from 'react';
import { Cloud, Cpu, Download, Languages, ShieldCheck } from 'lucide-react';
import type { PdfTranslateJob, PdfTranslateKind } from '@srh/shared';
import { Button, Dialog, Input, Switch, Tabs } from '@/components/ui';
import { useHybridStatus } from '@/features/hybrid/queries';
import { cn } from '@/lib/cn';
import { tr, trServer } from '@/lib/i18n';
import type { LibraryScope } from '../lib/scope';
import {
  pdfTranslateFileUrl,
  usePdfTranslateBytes,
  usePdfTranslateJob,
  useStartPdfTranslate,
} from '../pdf-translate-api';
import { PaperPdfViewer } from './PaperPdfViewer';
import { usePdfDocument } from './usePdfDocument';

/** 「翻译 PDF」按钮：服务端配置了 PDF_TRANSLATE_URL 才显示 */
export function PdfTranslateButton({
  scope,
  paperId,
  hasPdf,
}: {
  scope: LibraryScope;
  paperId: string;
  hasPdf: boolean;
}) {
  const status = useHybridStatus();
  const [open, setOpen] = useState(false);
  if (!status.data?.pdfTranslate || !hasPdf) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Languages className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        {tr('翻译 PDF')}
      </Button>
      {open && (
        <PdfTranslateDialog scope={scope} paperId={paperId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function RouteBadge({ job }: { job: PdfTranslateJob }) {
  if (!job.target) return null;
  const local = job.target === 'local';
  const Icon = local ? Cpu : Cloud;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption',
        local
          ? 'border-success/40 bg-success-soft text-success'
          : 'border-line bg-subtle text-fg-muted',
      )}
      title={local ? tr('这次由本机上的模型处理，内容没有离开这台电脑') : tr('这次由云端模型处理')}
    >
      <Icon className="size-3" aria-hidden />
      {local ? tr('本地') : job.fallback ? tr('云端（本地不可用，已回退）') : tr('云端')}
    </span>
  );
}

const ACTIVE = new Set(['queued', 'running']);

export function PdfTranslateDialog({
  scope,
  paperId,
  onClose,
}: {
  scope: LibraryScope;
  paperId: string;
  onClose: () => void;
}) {
  const job = usePdfTranslateJob(scope, paperId, true);
  const start = useStartPdfTranslate(scope, paperId);
  const [pages, setPages] = useState('');
  const [mode, setMode] = useState<'both' | 'mono'>('both');
  const [localOnly, setLocalOnly] = useState(false);
  const [view, setView] = useState<PdfTranslateKind>('dual');
  const data = job.data;
  const running = data ? ACTIVE.has(data.status) : false;
  const done = data?.status === 'done';
  const shown: PdfTranslateKind | null = done
    ? data.files.includes(view)
      ? view
      : (data.files[0] ?? null)
    : null;
  const bytes = usePdfTranslateBytes(scope, paperId, shown, done ? data.finishedAt : null);
  const pdf = usePdfDocument(bytes.data);
  const pagesOk = !pages.trim() || /^\d+(-\d+)?(,\d+(-\d+)?)*$/u.test(pages.replace(/\s+/gu, ''));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={tr('翻译 PDF')}
      description={tr(
        '整篇译成中文并保留原版式（公式、图表、排版不变）。本地模型优先，失败时整篇交给云端。',
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('关闭')}
          </Button>
          <Button
            variant="primary"
            loading={start.isPending}
            disabled={running || !pagesOk}
            onClick={() =>
              start.mutate({
                pages: pages.replace(/\s+/gu, '') || undefined,
                mode,
                localOnly,
              })
            }
          >
            {done ? tr('按新设置重新翻译') : tr('开始翻译')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <label className="block text-caption text-fg-muted">
            {tr('页码范围（留空 = 全文）')}
            <Input
              className="mt-1"
              value={pages}
              placeholder={tr('例如 1-4,7')}
              onChange={(e) => setPages(e.target.value)}
              error={pagesOk ? undefined : tr('格式：1-4,7')}
            />
          </label>
          <Tabs
            variant="segmented"
            size="sm"
            aria-label={tr('输出')}
            value={mode}
            onValueChange={setMode}
            items={[
              { value: 'both', label: tr('双语对照') },
              { value: 'mono', label: tr('仅译文') },
            ]}
          />
          <span className="inline-flex items-center gap-2 text-caption text-fg-muted">
            <ShieldCheck className="size-4" aria-hidden />
            <Switch checked={localOnly} onCheckedChange={setLocalOnly} label={tr('仅本地')} />
            {tr('仅本地')}
          </span>
        </div>

        {start.error && <p className="text-caption text-danger">{start.error.message}</p>}

        {data && data.status !== 'idle' && (
          <div className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2 text-caption text-fg-muted">
              <span>
                {data.status === 'done'
                  ? data.cached
                    ? tr('已完成（缓存）')
                    : tr('已完成')
                  : data.status === 'failed'
                    ? tr('翻译失败')
                    : tr('翻译中 {n}%', { n: Math.round(data.progress) })}
              </span>
              {running && data.stage && <span className="truncate">· {data.stage}</span>}
              <span className="ml-auto" />
              <RouteBadge job={data} />
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-subtle"
              role="progressbar"
              aria-valuenow={Math.round(data.progress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  data.status === 'failed' ? 'bg-danger' : 'bg-accent',
                )}
                style={{ width: `${data.status === 'done' ? 100 : data.progress}%` }}
              />
            </div>
            {data.error && <p className="text-caption text-danger">{trServer(data.error)}</p>}
            {done && (
              <div className="flex flex-wrap items-center gap-2">
                {data.files.includes('dual') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Download className="size-4" aria-hidden />}
                    onClick={() => window.open(pdfTranslateFileUrl(scope, paperId, 'dual', true))}
                  >
                    {tr('下载双语对照')}
                  </Button>
                )}
                {data.files.includes('mono') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Download className="size-4" aria-hidden />}
                    onClick={() => window.open(pdfTranslateFileUrl(scope, paperId, 'mono', true))}
                  >
                    {tr('下载译文')}
                  </Button>
                )}
                {data.files.length > 1 && (
                  <Tabs
                    className="ml-auto"
                    variant="segmented"
                    size="sm"
                    aria-label={tr('预览')}
                    value={shown ?? 'dual'}
                    onValueChange={setView}
                    items={[
                      { value: 'dual', label: tr('双语对照') },
                      { value: 'mono', label: tr('仅译文') },
                    ]}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {done && shown && (
          <PaperPdfViewer
            className="h-[60vh] rounded-lg border border-line"
            doc={pdf.doc}
            sizes={pdf.sizes}
            error={bytes.error ? bytes.error.message : pdf.error}
            marks={[]}
          />
        )}

        <p className="text-caption text-fg-subtle">
          {tr('翻译由独立运行的 PDFMathTranslate-next（pdf2zh-next，AGPL-3.0）服务完成。')}
        </p>
      </div>
    </Dialog>
  );
}
