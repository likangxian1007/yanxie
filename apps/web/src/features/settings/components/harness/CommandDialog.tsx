import { useId, useState } from 'react';
import type { SlashCommand, WritableScope } from '@srh/shared';
import { Button, Dialog, Input, Textarea, toast } from '@/components/ui';
import { isBuiltinName } from '@/features/harness/slash';
import { useCreateCommand, useUpdateCommand } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { Field, InlineError } from '../parts';
import { ScopeField } from './harness-parts';
import { SLUG_HINT, useHarnessPerm, validateSlug } from './perm';
import { tr } from '@/lib/i18n';

export interface CommandDialogProps {
  pid: string;
  command: SlashCommand | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 新建 / 编辑自定义指令：模板里的 $ARGUMENTS 会换成指令后面的参数。 */
export function CommandDialog({ pid, command, open, onOpenChange }: CommandDialogProps) {
  const ids = useId();
  const perm = useHarnessPerm(pid);
  const create = useCreateCommand(pid);
  const update = useUpdateCommand(pid);
  const save = command ? update : create;
  const [scope, setScope] = useState<WritableScope>(perm.scopes[0] ?? 'personal');
  const [name, setName] = useState(command?.name ?? '');
  const [description, setDescription] = useState(command?.description ?? '');
  const [argumentHint, setArgumentHint] = useState(command?.argumentHint ?? '');
  const [template, setTemplate] = useState(command?.template ?? '');
  const [touched, setTouched] = useState(false);

  const nameError = command
    ? null
    : (validateSlug(name) ??
      (isBuiltinName(name.trim())
        ? tr('/{name} 是内置指令，换个名字', { name: name.trim() })
        : null));
  const descError = description.trim() ? null : tr('请用一句话说明这个指令做什么');
  const templateError = template.trim() ? null : tr('请填写模板');

  const submit = () => {
    setTouched(true);
    if (nameError || descError || templateError) return;
    const fields = { description: description.trim(), argumentHint: argumentHint.trim(), template };
    const onSuccess = (c: SlashCommand) => {
      toast.success(
        command ? tr('已保存 /{name}', { name: c.name }) : tr('已新建 /{name}', { name: c.name }),
      );
      onOpenChange(false);
    };
    if (command) update.mutate({ id: command.id, patch: fields }, { onSuccess });
    else create.mutate({ ...fields, scope, name: name.trim() }, { onSuccess });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="md"
      title={command ? tr('编辑 /{name}', { name: command.name }) : tr('新建指令')}
      description={tr('在输入框里输入 /名字 参数，发出去的是把参数代入模板后的完整指令。')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {command ? tr('保存更改') : tr('新建指令')}
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
        {!command && (
          <ScopeField value={scope} onChange={setScope} scopes={perm.scopes} idPrefix={ids} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={tr('名字')}
            htmlFor={`${ids}-name`}
            hint={command ? tr('创建后不能修改') : SLUG_HINT}
          >
            <Input
              id={`${ids}-name`}
              data-autofocus={command ? undefined : true}
              value={command ? `/${command.name}` : name}
              readOnly={Boolean(command)}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder="weekly"
              className="font-mono"
              error={touched && nameError ? nameError : undefined}
              onChange={(e) => setName(e.target.value.toLowerCase())}
            />
          </Field>
          <Field label={tr('参数提示（选填）')} htmlFor={`${ids}-hint`}>
            <Input
              id={`${ids}-hint`}
              value={argumentHint}
              maxLength={60}
              placeholder={tr('<本周重点>')}
              onChange={(e) => setArgumentHint(e.target.value)}
            />
          </Field>
        </div>
        <Field label={tr('说明')} htmlFor={`${ids}-desc`}>
          <Input
            id={`${ids}-desc`}
            data-autofocus={command ? true : undefined}
            value={description}
            maxLength={200}
            placeholder={tr('例如：整理本周进展，起草组会汇报')}
            error={touched && descError ? descError : undefined}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label={tr('模板')}
          htmlFor={`${ids}-tpl`}
          hint={
            <>
              {tr('用 ')}
              <code className="font-mono">$ARGUMENTS</code>{' '}
              {tr('表示指令后面的参数；没写的话参数会接在模板末尾。')}
            </>
          }
        >
          <Textarea
            id={`${ids}-tpl`}
            value={template}
            rows={8}
            maxLength={20_000}
            spellCheck={false}
            placeholder={tr(
              '汇总本周所有线程的进展，重点关注：$ARGUMENTS\n按「完成 / 进行中 / 风险」三段写。',
            )}
            className="font-mono text-small"
            error={touched && templateError ? templateError : undefined}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </Field>
        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
