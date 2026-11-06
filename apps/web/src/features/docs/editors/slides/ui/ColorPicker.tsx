import type { ReactNode } from 'react';
import { Popover } from '@/components/ui';
import { cn } from '@/lib/cn';
import { BLACK, SWATCHES } from '../model/themes';
import type { Theme } from '../model/types';
import { tr } from '@/lib/i18n';

interface Props {
  label: string;
  value: string | null;
  theme: Theme;
  onChange: (color: string | null) => void;
  /** 允许“无”（无填充 / 无边框） */
  allowNone?: string;
  trigger: ReactNode;
  disabled?: boolean;
}

export function ColorPicker({
  label,
  value,
  theme,
  onChange,
  allowNone,
  trigger,
  disabled,
}: Props) {
  const themeColors = [theme.fg, theme.muted, theme.bg, ...theme.colors];
  const sw = (c: string, close: () => void) => (
    <button
      key={c}
      type="button"
      aria-label={c}
      aria-pressed={value?.toUpperCase() === c.toUpperCase()}
      className={cn(
        'size-6 rounded-xs border border-line-strong outline-offset-1 aria-pressed:outline-2 aria-pressed:outline-accent',
      )}
      style={{ backgroundColor: c }}
      onClick={() => {
        onChange(c);
        close();
      }}
    />
  );
  return (
    <Popover
      label={label}
      trigger={
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-fg-muted hover:bg-subtle hover:text-fg disabled:opacity-50 aria-expanded:bg-subtle"
        >
          {trigger}
        </button>
      }
    >
      {(close) => (
        <div className="flex w-56 flex-col gap-2 p-2">
          <span className="text-caption text-fg-subtle">{tr('主题色')}</span>
          <div className="flex flex-wrap gap-1.5">{themeColors.map((c) => sw(c, close))}</div>
          <span className="text-caption text-fg-subtle">{tr('标准色')}</span>
          <div className="flex flex-wrap gap-1.5">{SWATCHES.map((c) => sw(c, close))}</div>
          <div className="flex items-center gap-2 pt-1">
            <label className="flex flex-1 items-center gap-2 text-small text-fg-muted">
              {tr('自定义')}
              <input
                type="color"
                aria-label={tr('自定义颜色')}
                className="h-7 w-10 cursor-pointer rounded-xs border border-line-strong bg-surface"
                value={value && /^#[0-9a-f]{6}$/iu.test(value) ? value : BLACK}
                onChange={(e) => onChange(e.target.value.toUpperCase())}
              />
            </label>
            {allowNone && (
              <button
                type="button"
                className="rounded-sm px-2 py-1 text-small text-fg-muted hover:bg-subtle hover:text-fg"
                onClick={() => {
                  onChange(null);
                  close();
                }}
              >
                {allowNone}
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** 按钮里的颜色条 */
export function ColorBar({ color, children }: { color: string | null; children: ReactNode }) {
  return (
    <span className="flex flex-col items-center">
      {children}
      <span
        aria-hidden
        className="mt-0.5 h-1 w-4 rounded-full border border-line"
        style={{ backgroundColor: color ?? 'transparent' }}
      />
    </span>
  );
}
