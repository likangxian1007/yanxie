import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MemoryFile, MemoryType } from '@srh/shared';
import { Button, Dialog, Input, Select, Textarea, toast } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { upsertMemoryCaches } from '../cache';
import {
  errorMessage,
  MEMORY_MAX,
  MEMORY_TYPE_OPTIONS,
  parseMemoryType,
  validateMemoryPath,
} from '../lib';
import { Field, InlineError } from './parts';
import { tr } from '@/lib/i18n';

export interface NewMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: string;
  existingPaths: string[];
  onCreated: (file: MemoryFile) => void;
}

export function NewMemoryDialog({
  open,
  onOpenChange,
  pid,
  existingPaths,
  onCreated,
}: NewMemoryDialogProps) {
  const qc = useQueryClient();
  const ids = useId();
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<MemoryType | null>(null);
  const [content, setContent] = useState('');
  const [touched, setTouched] = useState(false);
  const resetFields = () => {
    setPath('');
    setDescription('');
    setType(null);
    setContent('');
    setTouched(false);
  };

  const p = path.trim();
  const pathError =
    validateMemoryPath(p) ??
    (existingPaths.includes(p) ? tr('已经有同名文件，换个路径或直接编辑它') : null);
  const contentError =
    content.length > MEMORY_MAX ? tr('内容最多 {MEMORY_MAX} 个字符', { MEMORY_MAX }) : null;

  const create = useMutation({
    mutationFn: () =>
      api.put<MemoryFile>(`/projects/${pid}/memory`, {
        path: p,
        content,
        description: description.trim(),
        type,
        baseVersion: 0,
      }),
    onSuccess: (file) => {
      upsertMemoryCaches(qc, pid, file);
      toast.success(tr('已新建记忆 {path}', { path: file.path }));
      resetFields();
      onOpenChange(false);
      onCreated(file);
    },
  });

  const close = () => {
    resetFields();
    create.reset();
    onOpenChange(false);
  };

  const submit = () => {
    setTouched(true);
    if (pathError || contentError) return;
    create.mutate();
  };

  const conflict = create.error instanceof ApiRequestError && create.error.status === 409;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !create.isPending) close();
      }}
      size="md"
      title={tr('新建记忆')}
      description={tr(
        '项目记忆是协调者和所有 agent 都能读到的长期笔记，适合记下约定、术语、成员偏好和参考资料。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            {tr('新建记忆')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <Field
            label={tr('文件路径')}
            htmlFor={`${ids}-path`}
            hint={tr('以 .md 结尾，可以带子目录，例如 notes/datasets.md')}
          >
            <Input
              id={`${ids}-path`}
              data-autofocus
              value={path}
              placeholder="conventions.md"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              error={touched && pathError ? pathError : undefined}
              onChange={(e) => setPath(e.target.value)}
              onBlur={() => setTouched(true)}
            />
          </Field>
          <Field label={tr('类型')} htmlFor={`${ids}-type`}>
            <Select
              id={`${ids}-type`}
              value={type ?? ''}
              options={MEMORY_TYPE_OPTIONS}
              onChange={(e) => setType(parseMemoryType(e.target.value))}
            />
          </Field>
        </div>
        <Field
          label={tr('一句话说明')}
          htmlFor={`${ids}-desc`}
          hint={tr('agent 会先看说明再决定要不要读全文')}
        >
          <Input
            id={`${ids}-desc`}
            value={description}
            maxLength={200}
            placeholder={tr('例如：数据集划分与评测口径')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label={tr('内容（Markdown）')} htmlFor={`${ids}-content`}>
          <Textarea
            id={`${ids}-content`}
            value={content}
            rows={8}
            autoGrow
            spellCheck={false}
            className="font-mono text-small leading-relaxed"
            error={contentError ?? undefined}
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>
        {create.isError && (
          <InlineError>
            {conflict ? tr('已经有同名文件，换个路径或直接编辑它。') : errorMessage(create.error)}
          </InlineError>
        )}
      </form>
    </Dialog>
  );
}
