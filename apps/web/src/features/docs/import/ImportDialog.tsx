import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertCircle, CheckCircle2, FileQuestion, RotateCcw, Upload, X } from 'lucide-react';
import type { DocumentKind } from '@srh/shared';
import { Button, Dialog, IconButton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DOC_KIND_META, DocKindIcon } from '../kinds';
import { IMPORT_HINT, importAccept } from './registry';
import { formatSize } from './text';
import { useFileDrop } from './useFileDrop';
import type { ImportItem, ImportQueue } from './useImportQueue';
import './import.css';
import { tr } from '@/lib/i18n';

/** 拖入时盖在列表上的提示层 */
export function DropOverlay({ show, label }: { show: boolean; label: string }) {
  return (
    <div
      aria-hidden={!show}
      className={cn(
        'pointer-events-none absolute inset-0 z-overlay flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80 transition-opacity duration-(--dur-fast)',
        show ? 'opacity-100' : 'opacity-0',
      )}
    >
      <span className="flex items-center gap-2 rounded-md bg-elevated px-3 py-2 text-small text-fg shadow-md">
        <Upload size={16} strokeWidth={1.75} aria-hidden />
        {label}
      </span>
    </div>
  );
}

function stageText(item: ImportItem): string {
  const p = item.progress;
  if (item.status === 'queued') return tr('排队中');
  if (!p || p.stage === 'parsing') return tr('正在解析');
  if (p.stage === 'uploading')
    return tr('正在上传图片{value}', {
      value: p.uploaded ? tr('（已传 {uploaded} 个）', { uploaded: p.uploaded }) : '',
    });
  return tr('正在保存');
}

/** 0–1，未知返回 null（显示不定进度） */
function itemFraction(item: ImportItem): number | null {
  const p = item.progress;
  if (!p || p.stage !== 'saving' || p.fraction === undefined) return null;
  return 0.6 + 0.4 * p.fraction;
}

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div
      className="relative h-1 w-full overflow-hidden rounded-full bg-subtle"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(value === null ? {} : { 'aria-valuenow': Math.round(value * 100) })}
    >
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-full origin-left rounded-full bg-accent transition-transform duration-(--dur-base)',
          value === null && 'import-indeterminate',
        )}
        style={{ transform: `scaleX(${value === null ? 0.35 : Math.max(0.04, value)})` }}
      />
    </div>
  );
}

function ItemRow({
  item,
  hrefOf,
  onRetry,
  onRemove,
}: {
  item: ImportItem;
  hrefOf: (id: string) => string;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const busy = item.status === 'queued' || item.status === 'running';
  return (
    <li
      className="flex items-start gap-3 py-2.5"
      data-status={item.status}
      aria-label={item.file.name}
    >
      {item.kind ? (
        <DocKindIcon kind={item.kind} size="md" label={DOC_KIND_META[item.kind].label} />
      ) : (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-subtle text-fg-subtle">
          <FileQuestion size={16} strokeWidth={1.75} aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-small text-fg" title={item.file.name}>
            {item.file.name}
          </span>
          <span className="shrink-0 text-caption text-fg-subtle">{formatSize(item.file.size)}</span>
        </div>
        {busy && (
          <>
            <span className="flex items-center gap-1.5 text-caption text-fg-muted">
              {item.status === 'running' && <Spinner className="size-3" />}
              {stageText(item)}
            </span>
            {item.status === 'running' && <ProgressBar value={itemFraction(item)} />}
          </>
        )}
        {item.status === 'error' && (
          <span className="flex items-start gap-1.5 text-caption text-danger" role="alert">
            <AlertCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            {item.error}
          </span>
        )}
        {item.status === 'done' && item.meta && (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-success">
            <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden />
            {tr('已导入为{value}{label}', {
              value: /^[A-Za-z]/u.test(DOC_KIND_META[item.meta.kind].label) ? ' ' : '',
              label: DOC_KIND_META[item.meta.kind].label,
            })}
            <Link
              to={hrefOf(item.meta.id)}
              className="text-accent underline-offset-2 hover:underline"
            >
              {tr('打开')}
            </Link>
          </span>
        )}
        {item.status === 'done' && item.warnings.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-caption text-warning">
            {item.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.status === 'error' && item.retryable && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<RotateCcw strokeWidth={1.75} aria-hidden />}
            onClick={onRetry}
          >
            {tr('重试')}
          </Button>
        )}
        <IconButton
          size="sm"
          label={
            busy
              ? tr('取消导入 {name}', { name: item.file.name })
              : tr('移除 {name}', { name: item.file.name })
          }
          onClick={onRemove}
        >
          <X strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
    </li>
  );
}

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: ImportQueue;
  hrefOf: (id: string) => string;
  /** 只接受某一类（文档页里导入） */
  onlyKind?: DocumentKind;
  title?: ReactNode;
  description?: ReactNode;
  /** 只能选一个文件（替换当前文档时） */
  single?: boolean;
  /** 选好 / 拖入文件后（默认直接加进队列） */
  onFiles?: (files: File[]) => void;
}

/** 上传文件对话框：选择 / 拖入文件，逐个显示进度、失败原因和重试 */
export function ImportDialog({
  open,
  onOpenChange,
  queue,
  hrefOf,
  onlyKind,
  title = tr('上传文件'),
  description,
  single = false,
  onFiles,
}: ImportDialogProps) {
  const addFiles = onFiles ?? queue.add;
  const input = useRef<HTMLInputElement | null>(null);
  const drop = useFileDrop((files) => addFiles(single ? files.slice(0, 1) : files));
  const { items } = queue;
  const doneCount = items.filter((i) => i.status === 'done').length;
  const failCount = items.filter((i) => i.status === 'error').length;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      description={
        description ??
        tr('支持 {IMPORT_HINT}。每个文件会新建一份文档，大家可以马上一起编辑。', { IMPORT_HINT })
      }
      footer={
        <>
          {items.length > 0 && !queue.busy && (
            <Button variant="ghost" onClick={queue.clearFinished}>
              {tr('清空列表')}
            </Button>
          )}
          <Button
            variant={queue.busy ? 'secondary' : 'primary'}
            onClick={() => onOpenChange(false)}
          >
            {queue.busy ? tr('后台继续') : tr('完成')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          {...drop.props}
          className={cn(
            'relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-(--dur-fast)',
            drop.dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface',
          )}
        >
          <Upload size={20} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
          <p className="text-small text-fg-muted">
            {tr('把文件拖到这里，或者')}
            <button
              type="button"
              className="mx-1 text-accent underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => input.current?.click()}
            >
              {tr('选择文件')}
            </button>
            {single ? '' : tr('（可以一次选多个）')}
          </p>
          <input
            ref={input}
            type="file"
            multiple={!single}
            accept={importAccept(onlyKind)}
            className="hidden"
            data-testid="import-file-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) addFiles(single ? files.slice(0, 1) : files);
            }}
          />
        </div>
        {items.length > 0 && (
          <>
            <p className="text-caption text-fg-subtle" aria-live="polite">
              {tr('共 ')}
              {items.length}
              {tr(' 个文件')}
              {doneCount > 0 && tr('，已导入 {doneCount} 个', { doneCount })}
              {failCount > 0 && tr('，{failCount} 个没有导入', { failCount })}
            </p>
            <ul className="flex max-h-[min(50dvh,420px)] flex-col divide-y divide-line overflow-y-auto">
              {items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  hrefOf={hrefOf}
                  onRetry={() => queue.retry(item.id)}
                  onRemove={() => queue.remove(item.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
