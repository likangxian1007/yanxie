import { useEffect, useId, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Lock, RotateCw } from 'lucide-react';
import { Button, Card, Dialog, Input, RelativeTime, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PALETTE_NAMES, paletteVar } from '@/lib/palette';
import { formatFullTimeZh } from '@/lib/time';
import { errorMessage, READ_ONLY_HINT, relativeFutureZh } from '../lib';
import { tr } from '@/lib/i18n';

// ---------------------------------------------------------------- 分组卡片

export interface SettingsCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** 标题右侧（按钮等） */
  actions?: ReactNode;
  /** 底部操作条（保存按钮、错误文案） */
  footer?: ReactNode;
  tone?: 'default' | 'danger';
  children?: ReactNode;
  className?: string;
}

/** 设置分组：H3 标题 + small 描述 + 内容 + 底部操作条。 */
export function SettingsCard({
  title,
  description,
  actions,
  footer,
  tone = 'default',
  children,
  className,
}: SettingsCardProps) {
  return (
    <section
      className={cn(
        'min-w-0 border-b border-line pb-7 last:border-b-0',
        tone === 'danger' && 'border-danger/30',
        className,
      )}
    >
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className={cn('text-h3', tone === 'danger' ? 'text-danger' : 'text-fg')}>{title}</h2>
          {description && (
            <p className="mt-1 max-w-[60ch] text-small text-pretty text-fg-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && <div>{children}</div>}
      {footer && (
        <div className="mt-5 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">{footer}</div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 表单字段

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, children, className }: FieldProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-small font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && <p className="text-caption font-normal text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** 没有编辑权限时的小字说明。 */
export function ReadOnlyNote({ children = READ_ONLY_HINT }: { children?: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-1.5 text-caption font-normal text-fg-subtle">
      <Lock size={12} strokeWidth={1.75} aria-hidden />
      {children}
    </p>
  );
}

/** 保存失败等行内错误。 */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mr-auto inline-flex items-start gap-1.5 text-caption font-normal text-danger"
    >
      <AlertCircle size={14} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------- 时间

/**
 * 过去时间用 RelativeTime（刚刚 / 3 分钟前）；未来时间显示“3 小时后 / 明天 09:00”。
 * 悬停都显示完整时间。
 */
export function When({ iso, className }: { iso: string; className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const future = relativeFutureZh(iso, now);
  if (future === null) return <RelativeTime iso={iso} className={className} />;
  return (
    <time dateTime={iso} title={formatFullTimeZh(iso)} className={cn('tabular-nums', className)}>
      {future}
    </time>
  );
}

// ---------------------------------------------------------------- 加载 / 错误

export function ErrorCard({
  error,
  onRetry,
  title = tr('加载失败'),
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
        <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-h3 text-fg">{title}</p>
        <p className="mt-0.5 text-small text-fg-muted">{errorMessage(error)}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
        onClick={onRetry}
      >
        {tr('重试')}
      </Button>
    </Card>
  );
}

/** 通用的列表/表单骨架。 */
export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label={tr('正在加载')} className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
      <Card className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 色板选择

export interface PaletteSwatchesProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}

/** 8 色色板单选（原生 radio，方向键可切换）。 */
export function PaletteSwatches({ value, onChange, label, disabled }: PaletteSwatchesProps) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {PALETTE_NAMES.map((colorName, i) => {
        const checked = value === i;
        return (
          <label
            key={colorName}
            className={cn(
              'relative grid size-8 place-items-center rounded-full',
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            <input
              type="radio"
              name={name}
              value={i}
              checked={checked}
              disabled={disabled}
              aria-label={colorName}
              onChange={() => onChange(i)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className={cn(
                'grid size-7 place-items-center rounded-full text-accent-fg ring-offset-2 ring-offset-surface',
                'transition-shadow duration-(--dur-fast) ease-(--ease-standard)',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                checked && 'ring-2 ring-line-strong',
              )}
              style={{ backgroundColor: paletteVar(i) }}
            >
              {checked && <Check size={14} strokeWidth={2.25} />}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 确认对话框

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  loading?: boolean;
  /** 需要输入这段文字才能确认（例如项目名） */
  requireText?: string;
  error?: ReactNode;
  children?: ReactNode;
}

/** 危险操作确认：次要按钮在左、危险按钮在右；可要求输入名称。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  loading = false,
  requireText,
  error,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [wasOpen, setWasOpen] = useState(open);
  // 每次重新打开都清空输入（渲染期派生状态，不用 effect）
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped('');
  }
  const inputId = useId();
  const matched = requireText === undefined || typed.trim() === requireText.trim();
  const confirm = () => {
    if (matched && !loading) onConfirm();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!loading) onOpenChange(v);
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            {tr('取消')}
          </Button>
          <Button variant="danger" onClick={confirm} loading={loading} disabled={!matched}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        {requireText !== undefined && (
          <Field
            htmlFor={inputId}
            label={
              <>
                {tr('输入 ')}
                <span className="font-semibold break-all">{requireText}</span>
                {tr(' 以确认')}
              </>
            }
          >
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm();
              }}
            />
          </Field>
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Dialog>
  );
}
