import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { paletteFromString } from '@/lib/palette';
import { normalizeLabel } from '../lib/filter';
import { tr } from '@/lib/i18n';

export const MAX_LABELS = 10;

export interface LabelEditorProps {
  labels: string[];
  /** 看板上已有的标签，输入时提示 */
  suggestions: string[];
  disabled?: boolean;
  onChange: (labels: string[]) => void;
}

/** 标签编辑：彩色药丸 + 删除按钮；输入框回车添加（最多 10 个，每个 20 字以内） */
export function LabelEditor({ labels, suggestions, disabled, onChange }: LabelEditorProps) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const full = labels.length >= MAX_LABELS;

  const add = () => {
    const label = normalizeLabel(draft);
    setDraft('');
    if (!label || labels.includes(label) || full) return;
    onChange([...labels, label]);
  };

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5">
      {labels.map((label) => (
        <Badge key={label} color={paletteFromString(label)} className={cn(!disabled && 'pr-1')}>
          <span className="max-w-40 truncate">{label}</span>
          {!disabled && (
            <button
              type="button"
              aria-label={tr('移除标签 {label}', { label })}
              onClick={() => onChange(labels.filter((l) => l !== label))}
              className="grid size-4 cursor-pointer place-items-center rounded-full opacity-70 transition-opacity duration-(--dur-fast) hover:opacity-100"
            >
              <X size={11} strokeWidth={2} aria-hidden />
            </button>
          )}
        </Badge>
      ))}
      {labels.length === 0 && disabled && (
        <span className="text-small text-fg-subtle">{tr('无')}</span>
      )}
      {!disabled && !full && (
        <>
          <input
            value={draft}
            list={listId}
            maxLength={20}
            aria-label={tr('添加标签')}
            placeholder={labels.length ? tr('添加') : tr('添加标签，回车确认')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              } else if (e.key === 'Backspace' && !draft && labels.length) {
                onChange(labels.slice(0, -1));
              }
            }}
            className="h-6 min-w-24 flex-1 rounded-sm bg-transparent px-1 text-small text-fg placeholder:text-fg-subtle focus:bg-subtle"
          />
          <datalist id={listId}>
            {suggestions
              .filter((s) => !labels.includes(s))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
        </>
      )}
    </div>
  );
}
