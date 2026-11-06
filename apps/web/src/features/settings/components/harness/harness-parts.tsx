import type { ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import {
  EFFORT_LABEL,
  type HarnessScope,
  type ReasoningEffort,
  type WritableScope,
} from '@srh/shared';
import { Badge, Button, IconButton, Input, Switch, Tabs } from '@/components/ui';
import { EFFORT_ORDER } from '@/features/harness';
import { cn } from '@/lib/cn';
import { SCOPE_HINT, SCOPE_LABEL, type KeyValueRow } from './perm';
import { tr } from '@/lib/i18n';

export function ScopeBadge({ scope }: { scope: HarnessScope }) {
  const tone = scope === 'builtin' ? 'neutral' : scope === 'project' ? 'accent' : 'agent';
  return <Badge tone={tone}>{SCOPE_LABEL[scope]}</Badge>;
}

/** 新建时选作用域（项目 / 个人）；只有一种可选时只显示说明。 */
export function ScopeField({
  value,
  onChange,
  scopes,
  idPrefix,
}: {
  value: WritableScope;
  onChange: (v: WritableScope) => void;
  scopes: WritableScope[];
  idPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-fg">{tr('作用域')}</span>
      {scopes.length > 1 ? (
        <Tabs<WritableScope>
          variant="segmented"
          size="sm"
          aria-label={tr('作用域')}
          layoutId={`${idPrefix}-scope`}
          value={value}
          onValueChange={onChange}
          items={scopes.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))}
          className="self-start"
        />
      ) : (
        <span className="text-small text-fg-muted">{SCOPE_LABEL[value]}</span>
      )}
      <p className="text-caption font-normal text-fg-subtle">{SCOPE_HINT[value]}</p>
    </div>
  );
}

/** 带说明的开关行（同定时任务对话框里的「启用」）。 */
export function SwitchRow({
  title,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-small font-medium text-fg">{title}</p>
        {hint && <p className="text-caption font-normal text-fg-subtle">{hint}</p>}
      </div>
      <Switch
        label={title}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      />
    </div>
  );
}

/** 推理强度多选（小药丸开关）。 */
export function EffortToggles({
  value,
  onChange,
  allowed = EFFORT_ORDER,
  label,
}: {
  value: ReasoningEffort[];
  onChange: (v: ReasoningEffort[]) => void;
  allowed?: ReasoningEffort[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {EFFORT_ORDER.map((e) => {
        const on = value.includes(e);
        const can = allowed.includes(e);
        return (
          <button
            key={e}
            type="button"
            aria-pressed={on}
            disabled={!can}
            onClick={() =>
              onChange(
                on
                  ? value.filter((x) => x !== e)
                  : EFFORT_ORDER.filter((x) => x === e || value.includes(x)),
              )
            }
            className={cn(
              'press h-6 cursor-pointer rounded-full border px-2 text-caption transition-colors duration-(--dur-fast) ease-(--ease-standard)',
              'disabled:cursor-not-allowed disabled:opacity-40',
              on
                ? 'border-accent/40 bg-accent-soft text-accent-text'
                : 'border-line text-fg-muted hover:border-line-strong hover:text-fg',
            )}
          >
            {EFFORT_LABEL[e]}
          </button>
        );
      })}
    </div>
  );
}

/** 键值对编辑（MCP 的环境变量、请求头）：已保存的值不回显，留空 = 保留原值。 */
export function KeyValueEditor({
  rows,
  onChange,
  label,
  keyPlaceholder,
  valuePlaceholder = tr('值'),
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  label: string;
  keyPlaceholder: string;
  valuePlaceholder?: string;
}) {
  const update = (i: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            size="sm"
            aria-label={tr('{label}：第 {value} 个键', { label, value: i + 1 })}
            value={r.key}
            readOnly={r.existing}
            spellCheck={false}
            autoComplete="off"
            placeholder={keyPlaceholder}
            className={cn('font-mono', r.existing && 'text-fg-muted')}
            wrapperClassName="w-2/5 min-w-0"
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            size="sm"
            type="password"
            aria-label={tr('{label}：{value}的值', {
              label,
              value: r.key || tr('第 {value} 个', { value: i + 1 }),
            })}
            value={r.value}
            spellCheck={false}
            autoComplete="new-password"
            placeholder={r.existing ? tr('已设置，留空不改') : valuePlaceholder}
            className="font-mono"
            wrapperClassName="min-w-0 flex-1"
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <IconButton
            label={tr('删除这一项')}
            size="sm"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        leftIcon={<Plus strokeWidth={2} aria-hidden />}
        onClick={() => onChange([...rows, { key: '', value: '', existing: false }])}
      >
        {tr('添加')}
      </Button>
    </div>
  );
}

/** 只读的说明块（内置项的正文、模板） */
export function ReadOnlyBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-caption font-normal whitespace-pre-wrap text-fg-muted',
        className,
      )}
    >
      {children}
    </pre>
  );
}
