import { useId, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { Button, Dialog, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { paletteFromString, paletteVar } from '@/lib/palette';
import { useKnownLabels } from './thread-actions';
import { tr } from '@/lib/i18n';

const TITLE_MAX = 80;
const LABEL_MAX = 40;

// ---------------------------------------------------------------- 对话框

export function RenameDialog({
  initial,
  saving,
  onSave,
  onClose,
}: {
  initial: string;
  saving: boolean;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const title = value.trim();
  const invalid = title.length === 0 || title.length > TITLE_MAX;
  const submit = () => {
    if (invalid || saving) return;
    if (title === initial) onClose();
    else onSave(title);
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !saving && onClose()}
      size="sm"
      title={tr('重命名')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={saving} disabled={invalid} onClick={submit}>
            {tr('保存')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={id} className="sr-only">
          {tr('标题')}
        </label>
        <Input
          id={id}
          data-autofocus
          autoFocus
          value={value}
          maxLength={TITLE_MAX}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          error={title.length === 0 ? tr('标题不能为空') : undefined}
        />
      </form>
    </Dialog>
  );
}

export function LabelDialog({
  projectId,
  initial,
  saving,
  onSave,
  onClose,
}: {
  projectId: string;
  initial: string | null;
  saving: boolean;
  onSave: (label: string | null) => void;
  onClose: () => void;
}) {
  const id = useId();
  const known = useKnownLabels(projectId);
  const [value, setValue] = useState(initial ?? '');
  const label = value.trim();
  const q = label.toLowerCase();
  const suggestions = known.filter((l) => l !== label && (!q || l.toLowerCase().includes(q)));
  const submit = (next: string | null = label || null) => {
    if (saving) return;
    if (next === (initial ?? null)) onClose();
    else onSave(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !saving && onClose()}
      size="sm"
      title={initial ? tr('修改标签') : tr('加标签')}
      description={tr('同一个标签的线程会排在一组，也可以按标签筛选。')}
      footer={
        <>
          {initial && (
            <Button
              variant="ghost"
              className="mr-auto"
              leftIcon={<X strokeWidth={1.75} aria-hidden />}
              onClick={() => submit(null)}
              disabled={saving}
            >
              {tr('移除标签')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => submit()}>
            {tr('保存')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={id} className="sr-only">
          {tr('标签')}
        </label>
        <Input
          id={id}
          data-autofocus
          autoFocus
          value={value}
          maxLength={LABEL_MAX}
          placeholder={tr('例如：实验、文献、写作')}
          onChange={(e) => setValue(e.target.value)}
          leading={<Tag strokeWidth={1.75} aria-hidden />}
        />
        {suggestions.length > 0 && (
          <div>
            <p className="mb-1.5 text-caption text-fg-subtle">{tr('已有标签')}</p>
            <ul className="flex flex-wrap gap-1.5">
              {suggestions.slice(0, 12).map((l) => (
                <li key={l}>
                  <button
                    type="button"
                    onClick={() => submit(l)}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-small text-fg',
                      'transition-colors duration-(--dur-fast) ease-(--ease-standard) hover:bg-subtle',
                    )}
                  >
                    <LabelSwatch label={l} />
                    {l}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  );
}

function LabelSwatch({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="size-2 rounded-full"
      style={{ background: paletteVar(paletteFromString(label)) }}
    />
  );
}
