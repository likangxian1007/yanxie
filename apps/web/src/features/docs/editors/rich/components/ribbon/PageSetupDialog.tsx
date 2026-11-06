import { useState } from 'react';
import { Button, Dialog, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  MARGIN_PRESETS,
  PAPER_SIZES,
  paperMm,
  type Orientation,
  type PageSetup,
  type PaperSize,
} from '../../word/page';
import { tr } from '@/lib/i18n';

/**
 * 页面设置：纸张大小、方向、页边距（毫米）。存在文档的 Y.Map `page` 里，所有协作者共用，导出 Word / PDF 时照此排版。
 */
export function PageSetupDialog({
  open,
  onOpenChange,
  value,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: PageSetup;
  onSave: (next: PageSetup) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={tr('页面设置')} size="sm">
      {open && <PageSetupForm value={value} onCancel={() => onOpenChange(false)} onSave={onSave} />}
    </Dialog>
  );
}

const MARGIN_FIELDS = [
  ['marginTop', tr('上')],
  ['marginBottom', tr('下')],
  ['marginLeft', tr('左')],
  ['marginRight', tr('右')],
] as const;

function PageSetupForm({
  value,
  onCancel,
  onSave,
}: {
  value: PageSetup;
  onCancel: () => void;
  onSave: (next: PageSetup) => void;
}) {
  const [draft, setDraft] = useState<PageSetup>(value);
  const { width, height } = paperMm(draft);
  const invalid =
    draft.marginLeft + draft.marginRight > width - 20 ||
    draft.marginTop + draft.marginBottom > height - 20;
  const set = (patch: Partial<PageSetup>) => setDraft((d) => ({ ...d, ...patch }));
  // 预览：纸张按比例缩小，灰框是版心
  const scale = 120 / Math.max(width, height);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) onSave(draft);
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium text-fg">{tr('纸张')}</span>
            <Select
              value={draft.size}
              onChange={(e) => set({ size: e.target.value as PaperSize })}
              options={(Object.keys(PAPER_SIZES) as PaperSize[]).map((k) => ({
                value: k,
                label: tr('{label}（{width} × {height} 毫米）', {
                  label: PAPER_SIZES[k].label,
                  width: PAPER_SIZES[k].width,
                  height: PAPER_SIZES[k].height,
                }),
              }))}
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-small font-medium text-fg">{tr('方向')}</legend>
            <div className="flex gap-2" role="radiogroup" aria-label={tr('方向')}>
              {(
                [
                  ['portrait', tr('纵向')],
                  ['landscape', tr('横向')],
                ] as [Orientation, string][]
              ).map(([o, label]) => (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={draft.orientation === o}
                  onClick={() => set({ orientation: o })}
                  className={cn(
                    'h-8 flex-1 rounded-sm border text-small transition-colors duration-(--dur-fast)',
                    draft.orientation === o
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-line-strong text-fg hover:bg-subtle',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-small font-medium text-fg">{tr('页边距预设')}</span>
            <Select
              value={
                MARGIN_PRESETS.find((p) => MARGIN_FIELDS.every(([k]) => p.value[k] === draft[k]))
                  ?.label ?? ''
              }
              onChange={(e) => {
                const preset = MARGIN_PRESETS.find((p) => p.label === e.target.value);
                if (preset) set(preset.value);
              }}
              options={[
                { value: '', label: tr('自定义'), disabled: true },
                ...MARGIN_PRESETS.map((p) => ({ value: p.label, label: p.label })),
              ]}
            />
          </label>
        </div>
        <div
          aria-hidden
          className="flex size-32 items-center justify-center self-center rounded-md bg-subtle"
        >
          <div
            className="relative bg-surface shadow-sm transition-[width,height] duration-(--dur-base)"
            style={{ width: width * scale, height: height * scale }}
          >
            <div
              className="absolute border border-dashed border-line-strong"
              style={{
                top: draft.marginTop * scale,
                bottom: draft.marginBottom * scale,
                left: draft.marginLeft * scale,
                right: draft.marginRight * scale,
              }}
            />
          </div>
        </div>
      </div>
      <fieldset>
        <legend className="mb-2 text-small font-medium text-fg">{tr('页边距（毫米）')}</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {MARGIN_FIELDS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <span className="w-4 text-small text-fg-muted">{label}</span>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                inputMode="decimal"
                aria-label={tr('{label}边距（毫米）', { label })}
                value={draft[k]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) set({ [k]: Math.max(0, Math.min(100, n)) });
                }}
                className="h-8 min-w-0 flex-1 rounded-sm border border-line-strong bg-surface px-2 text-small text-fg tabular-nums outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
        {invalid && (
          <p role="alert" className="mt-2 text-caption text-danger">
            {tr('页边距太大，正文区域放不下了')}
          </p>
        )}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tr('取消')}
        </Button>
        <Button type="submit" variant="primary" disabled={invalid}>
          {tr('应用到文档')}
        </Button>
      </div>
    </form>
  );
}
