import { useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Link2, Unlink } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';
import { applyLink, removeLink } from '../commands';
import { ICON_STROKE } from './icons';
import { tr } from '@/lib/i18n';

export interface LinkFormProps {
  editor: Editor;
  onDone: () => void;
  /** 紧凑模式（气泡菜单里一行显示） */
  compact?: boolean;
}

export function LinkForm({ editor, onDone, compact }: LinkFormProps) {
  const initial = (editor.getAttributes('link').href as string | undefined) ?? '';
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = () => {
    if (!value.trim()) {
      if (initial) removeLink(editor);
      onDone();
      return;
    }
    if (applyLink(editor, value)) onDone();
    else setError(tr('链接地址不可用，请检查后再试'));
  };

  return (
    <form
      className={compact ? 'flex items-center gap-1' : 'flex w-72 flex-col gap-2 p-2'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        size="sm"
        value={value}
        placeholder={tr('粘贴或输入链接')}
        aria-label={tr('链接地址')}
        leading={<Link2 strokeWidth={ICON_STROKE} />}
        error={compact ? undefined : error}
        aria-invalid={Boolean(error) || undefined}
        wrapperClassName={compact ? 'w-56' : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
            editor.commands.focus();
          }
        }}
      />
      {compact ? (
        <>
          {initial && (
            <IconButton
              size="sm"
              label={tr('移除链接')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                removeLink(editor);
                onDone();
              }}
            >
              <Unlink strokeWidth={ICON_STROKE} />
            </IconButton>
          )}
          <Button size="sm" variant="primary" type="submit">
            {tr('确定')}
          </Button>
        </>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {initial && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                removeLink(editor);
                onDone();
              }}
            >
              {tr('移除链接')}
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit">
            {tr('确定')}
          </Button>
        </div>
      )}
    </form>
  );
}
