import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Sparkles } from 'lucide-react';
import { Button, Dialog, Input, Switch, Textarea, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useCreateReport } from '../api';
import {
  defaultReportTitle,
  formatPeriod,
  PERIOD_PRESETS,
  presetRange,
  rangeDays,
  validateRange,
  type DateRange,
  type PeriodPreset,
} from '../lib/period';
import { tr } from '@/lib/i18n';

export interface GenerateReportDialogProps {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** “生成汇报”对话框。父组件每次打开时用新的 key 挂载，表单自然重置。 */
export function GenerateReportDialog({ pid, open, onOpenChange }: GenerateReportDialogProps) {
  const navigate = useNavigate();
  const create = useCreateReport(pid);
  const [now] = useState(() => new Date());
  const [preset, setPreset] = useState<PeriodPreset>('this_week');
  const [custom, setCustom] = useState<DateRange>(() => presetRange('this_week', now));
  const [titleInput, setTitleInput] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [generate, setGenerate] = useState(true);

  const range = preset === 'custom' ? custom : presetRange(preset, now);
  const rangeError = preset === 'custom' ? validateRange(custom) : null;
  const title = titleInput ?? defaultReportTitle(range);
  const days = rangeDays(range);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (rangeError) return;
    create.mutate(
      {
        title: title.trim() || defaultReportTitle(range),
        periodStart: range.start,
        periodEnd: range.end,
        generate,
        instructions: instructions.trim(),
      },
      {
        onSuccess: (report) => {
          onOpenChange(false);
          navigate(`/p/${pid}/reports/${report.id}`);
        },
        onError: (err) =>
          toast.error(generate ? tr('没能开始生成') : tr('没能创建汇报'), err.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={tr('生成汇报')}
      description={tr(
        '选一个时间段，协调者会整理这期间的线程、研究空间、审阅和文档改动，写成汇报草稿。',
      )}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="generate-report-form"
            loading={create.isPending}
            disabled={Boolean(rangeError)}
            leftIcon={generate ? <Sparkles strokeWidth={1.75} aria-hidden /> : undefined}
          >
            {generate ? tr('开始生成') : tr('创建草稿')}
          </Button>
        </>
      }
    >
      <form id="generate-report-form" onSubmit={submit} className="flex flex-col gap-5">
        <fieldset>
          <legend className="mb-2 text-small font-medium text-fg">{tr('时间段')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {PERIOD_PRESETS.map((p) => {
              const active = p.value === preset;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPreset(p.value)}
                  className={cn(
                    'h-7 cursor-pointer rounded-full border px-3 text-small transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                    active
                      ? 'border-accent bg-accent-soft font-medium text-accent-text'
                      : 'border-line-strong bg-surface text-fg-muted hover:bg-subtle hover:text-fg',
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {preset === 'custom' && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-caption text-fg-muted">
                <span className="mb-1 block">{tr('开始日期')}</span>
                <Input
                  type="date"
                  value={custom.start}
                  max={custom.end || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
                />
              </label>
              <label className="text-caption text-fg-muted">
                <span className="mb-1 block">{tr('结束日期')}</span>
                <Input
                  type="date"
                  value={custom.end}
                  min={custom.start || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
                />
              </label>
            </div>
          )}
          <p
            className={cn('mt-2 text-caption', rangeError ? 'text-danger' : 'text-fg-subtle')}
            aria-live="polite"
          >
            {rangeError ??
              tr('{value} · 共 {days} 天', {
                value: formatPeriod(range.start, range.end, now),
                days,
              })}
          </p>
        </fieldset>

        <div>
          <label htmlFor="report-title" className="mb-1.5 block text-small font-medium text-fg">
            {tr('标题')}
          </label>
          <Input
            id="report-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitleInput(e.target.value)}
          />
        </div>

        <div className={cn(!generate && 'opacity-60')}>
          <label
            htmlFor="report-instructions"
            className="mb-1.5 block text-small font-medium text-fg"
          >
            {tr('额外要求 ')}
            <span className="font-normal text-fg-subtle">{tr('（可选）')}</span>
          </label>
          <Textarea
            id="report-instructions"
            value={instructions}
            maxLength={2000}
            rows={3}
            disabled={!generate}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={tr('例如：重点讲消融实验，给导师看的版本要简洁')}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-subtle/60 p-3">
          <div className="min-w-0">
            <p className="text-small font-medium text-fg">{tr('自动生成草稿')}</p>
            <p className="text-caption font-normal text-fg-muted">
              {generate
                ? tr('协调者读取这期间的项目上下文写初稿，通常一两分钟。')
                : tr('只创建一份空白汇报，你自己来写。')}
            </p>
          </div>
          <Switch checked={generate} onCheckedChange={setGenerate} label={tr('自动生成草稿')} />
        </div>
      </form>
    </Dialog>
  );
}
