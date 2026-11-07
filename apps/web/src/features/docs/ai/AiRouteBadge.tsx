import { useState } from 'react';
import { Cloud, Cpu, ShieldCheck } from 'lucide-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { readLocalOnly, routeLabel, writeLocalOnly, type DocAiRoute } from './useDocAi';

/** 混合 AI：这次 AI 走的是本机模型还是云端（含回退、脱敏信息） */
export function AiRouteBadge({
  route,
  className,
}: {
  route: DocAiRoute | null;
  className?: string;
}) {
  const label = routeLabel(route);
  if (!route || !label) return null;
  const local = route.target === 'local';
  const Icon = local ? Cpu : Cloud;
  return (
    <span
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption',
        local
          ? 'border-success/40 bg-success-soft text-success'
          : 'border-line bg-subtle text-fg-muted',
        className,
      )}
      title={
        local
          ? tr('这次由本机上的模型处理，内容没有离开这台电脑')
          : route.redacted > 0
            ? tr('发往云端前已在本地把敏感内容换成占位符，结果回来后在本地还原')
            : tr('这次由云端模型处理')
      }
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/** 「仅本地」开关：打开后文档 AI 只用本机模型，内容不出本机（存在浏览器里） */
export function LocalOnlyToggle({ className }: { className?: string }) {
  const [on, setOn] = useState(readLocalOnly);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        writeLocalOnly(!on);
        setOn(!on);
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-caption transition-colors',
        on
          ? 'border-success/40 bg-success-soft text-success'
          : 'border-line text-fg-subtle hover:text-fg',
        className,
      )}
      title={tr('打开后，文档 AI 只交给本机模型处理，内容不会发往云端')}
    >
      <ShieldCheck className="size-3" aria-hidden />
      {on ? tr('仅本地：开') : tr('仅本地')}
    </button>
  );
}
