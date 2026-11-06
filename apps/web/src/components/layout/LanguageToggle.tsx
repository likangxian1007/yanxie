import { Languages } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getLang, switchLang, type UiLang } from '@/lib/i18n';

/** 语言名用各自的语言写，任何界面语言下都认得出来 */
// i18n-ignore
const OPTIONS: { value: UiLang; label: string }[] = [
  { value: 'zh', label: '中文' }, // i18n-ignore
  { value: 'en', label: 'English' },
];

/** 顶栏语言按钮：在中文与英文之间切换（记住选择并刷新页面） */
export function LanguageToggle({ className }: { className?: string }) {
  const lang = getLang();
  const next: UiLang = lang === 'en' ? 'zh' : 'en';
  // i18n-ignore
  const label = lang === 'en' ? '切换到中文 (Switch to Chinese)' : 'Switch to English (切换到英文)';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => switchLang(next)}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-muted transition-colors hover:bg-subtle hover:text-fg',
        className,
      )}
    >
      <Languages size={15} strokeWidth={1.75} aria-hidden />
      {/* i18n-ignore */}
      <span>{lang === 'en' ? '中' : 'EN'}</span>
    </button>
  );
}

/** 设置页 / 登录页用的分段选择 */
export function LanguageSegmented({ className }: { className?: string }) {
  const lang = getLang();
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex rounded-lg border border-line p-0.5', className)}
    >
      {OPTIONS.map((o) => (
        <label
          key={o.value}
          className={cn(
            'cursor-pointer rounded-md px-3 py-1 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
            lang === o.value ? 'bg-subtle font-medium text-fg' : 'text-fg-muted hover:text-fg',
          )}
        >
          <input
            type="radio"
            name="srh-ui-lang"
            value={o.value}
            checked={lang === o.value}
            onChange={() => switchLang(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
