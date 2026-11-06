import { useId } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  MATERIAL_LABEL,
  PALETTE_LABEL,
  useThemeStore,
  type ThemeMaterial,
  type ThemePalette,
} from '@/lib/theme';
import { SettingsCard } from './parts';
import { ThemeSegmented } from './ThemeSegmented';
import { LanguageSegmented } from '@/components/layout/LanguageToggle';
import { tr } from '@/lib/i18n';

export function AppearanceSettings() {
  const { palette, material, setPalette, setMaterial, reset, resolved } = useThemeStore();
  const name = useId();
  return (
    <SettingsCard
      title={tr('外观')}
      description={tr('偏好保存在当前浏览器。')}
      actions={
        <Button size="sm" variant="ghost" leftIcon={<RotateCcw size={14} />} onClick={reset}>
          {tr('重置默认')}
        </Button>
      }
    >
      <div className="space-y-6">
        <fieldset>
          <legend className="mb-3 text-small font-medium text-fg">{tr('配色')}</legend>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {(Object.keys(PALETTE_LABEL) as ThemePalette[]).map((value) => (
              <label key={value} className="min-w-0 cursor-pointer">
                <input
                  type="radio"
                  name={`${name}-palette`}
                  value={value}
                  checked={palette === value}
                  onChange={() => setPalette(value)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'block rounded-md border p-1 peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas',
                    palette === value ? 'border-accent' : 'border-line hover:border-line-strong',
                  )}
                >
                  <span
                    data-palette={value}
                    data-theme={resolved}
                    className={`appearance-preview appearance-${value} flex h-16 gap-1 overflow-hidden rounded-sm border border-line bg-surface`}
                    aria-hidden
                  >
                    <span className="flex w-1/3 flex-col gap-1 bg-subtle p-1.5">
                      <span className="size-2 rounded-xs bg-accent" />
                      <span className="mt-1 h-1 w-full rounded-full bg-muted" />
                      <span className="h-1 w-3/4 rounded-full bg-muted" />
                    </span>
                    <span className="flex flex-1 flex-col gap-1.5 p-1.5">
                      <span className="h-1 w-2/3 rounded-full bg-fg-subtle/40" />
                      <span className="mt-1 h-1 w-full rounded-full bg-muted" />
                      <span className="h-1 w-4/5 rounded-full bg-muted" />
                      <span className="mt-auto h-3 w-5 rounded-xs bg-accent-soft" />
                    </span>
                  </span>
                  <span className="flex min-h-9 items-center justify-between gap-1 px-1 text-caption font-medium text-fg sm:px-2 sm:text-small">
                    {PALETTE_LABEL[value]}
                    {palette === value && (
                      <Check size={13} className="shrink-0 text-accent" aria-hidden />
                    )}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <legend className="sr-only">{tr('材质')}</legend>
          <span className="text-small font-medium text-fg" aria-hidden>
            {tr('材质')}
          </span>
          <div className="inline-flex rounded-md bg-subtle p-0.5 ring-1 ring-line">
            {(Object.keys(MATERIAL_LABEL) as ThemeMaterial[]).map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name={`${name}-material`}
                  value={value}
                  checked={material === value}
                  onChange={() => setMaterial(value)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'inline-flex h-8 items-center rounded-sm px-3 text-small peer-focus-visible:outline-2 peer-focus-visible:outline-accent max-md:h-11',
                    material === value ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted',
                  )}
                >
                  {MATERIAL_LABEL[value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <h3 className="text-small font-medium text-fg">{tr('明暗')}</h3>
          <ThemeSegmented />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <h3 className="text-small font-medium text-fg">{tr('界面语言')}</h3>
          <LanguageSegmented />
        </div>
      </div>
    </SettingsCard>
  );
}
