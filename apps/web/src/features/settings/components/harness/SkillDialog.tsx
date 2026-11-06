import { useId, useState } from 'react';
import { Copy, Paperclip } from 'lucide-react';
import type { Skill, WritableScope } from '@srh/shared';
import { Button, Dialog, Input, Textarea, toast } from '@/components/ui';
import { useCreateSkill, useImportSkill, useUpdateSkill } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { Field, InlineError } from '../parts';
import { ReadOnlyBlock, ScopeBadge, ScopeField, SwitchRow } from './harness-parts';
import { SLUG_HINT, useHarnessPerm, validateSlug } from './perm';
import { tr, trServer } from '@/lib/i18n';

export interface SkillDialogProps {
  pid: string;
  /** null = 新建 */
  skill: Skill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 只读查看时的「复制」 */
  onCopy?: (skill: Skill) => void;
  copyLabel?: string;
}

/** Skill 编辑器：内置或无权编辑的只读查看（可复制覆盖）；其余可编辑。 */
export function SkillDialog({
  pid,
  skill,
  open,
  onOpenChange,
  onCopy,
  copyLabel,
}: SkillDialogProps) {
  const ids = useId();
  const perm = useHarnessPerm(pid);
  const create = useCreateSkill(pid);
  const update = useUpdateSkill(pid);
  const save = skill ? update : create;
  const readOnly = skill !== null && !perm.canEdit(skill);

  const [scope, setScope] = useState<WritableScope>(perm.scopes[0] ?? 'personal');
  const [slug, setSlug] = useState(skill?.slug ?? '');
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [userInvocable, setUserInvocable] = useState(skill?.userInvocable ?? true);
  const [modelInvocable, setModelInvocable] = useState(skill?.modelInvocable ?? true);
  const [touched, setTouched] = useState(false);

  const slugError = skill ? null : validateSlug(slug);
  const nameError = name.trim() ? null : tr('请填写名称');
  const descError = description.trim()
    ? null
    : tr('请写清楚什么时候该用它，agent 靠这句话决定是否加载');

  const submit = () => {
    setTouched(true);
    if (slugError || nameError || descError) return;
    const fields = {
      name: name.trim(),
      description: description.trim(),
      body,
      enabled,
      userInvocable,
      modelInvocable,
    };
    const onSuccess = (s: Skill) => {
      toast.success(
        skill
          ? tr('已保存「{name}」', { name: s.name })
          : tr('已新建 Skill「{name}」', { name: s.name }),
      );
      onOpenChange(false);
    };
    if (skill) update.mutate({ id: skill.id, patch: fields }, { onSuccess });
    else create.mutate({ ...fields, scope, slug: slug.trim() }, { onSuccess });
  };

  if (readOnly && skill) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {trServer(skill.name)}
            <ScopeBadge scope={skill.scope} />
          </span>
        }
        description={trServer(skill.description)}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {tr('关闭')}
            </Button>
            {onCopy && (
              <Button
                variant="primary"
                leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
                onClick={() => onCopy(skill)}
              >
                {copyLabel ?? tr('复制到项目')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-small text-fg-muted">
            {tr('点名用 ')}
            <code className="font-mono text-fg">/{skill.slug}</code>
            {skill.scope === 'builtin' &&
              tr('。内置 Skill 只读，复制后可以修改，同名的会覆盖内置的。')}
          </p>
          <ReadOnlyBlock>{skill.body || tr('（正文为空）')}</ReadOnlyBlock>
          <Attachments skill={skill} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="lg"
      title={skill ? tr('编辑 Skill「{name}」', { name: trServer(skill.name) }) : tr('新建 Skill')}
      description={tr(
        'Skill 是一份可复用的做事说明。agent 平时只看到名字和描述，需要时才读正文；成员也可以用 /名字 直接点名。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {skill ? tr('保存更改') : tr('新建 Skill')}
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
        {!skill && (
          <ScopeField value={scope} onChange={setScope} scopes={perm.scopes} idPrefix={ids} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('名称')} htmlFor={`${ids}-name`}>
            <Input
              id={`${ids}-name`}
              data-autofocus
              value={name}
              maxLength={60}
              placeholder={tr('例如：文献综述')}
              error={touched && nameError ? nameError : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={tr('点名用的名字')}
            htmlFor={`${ids}-slug`}
            hint={skill ? tr('创建后不能修改') : SLUG_HINT}
          >
            <Input
              id={`${ids}-slug`}
              value={skill ? `/${skill.slug}` : slug}
              readOnly={Boolean(skill)}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder="lit-review"
              className="font-mono"
              error={touched && slugError ? slugError : undefined}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </Field>
        </div>
        <Field label={tr('什么时候用')} htmlFor={`${ids}-desc`}>
          <Textarea
            id={`${ids}-desc`}
            value={description}
            rows={2}
            autoGrow
            maxLength={500}
            placeholder={tr('例如：需要系统梳理某个方向的已有工作、写 related work 时使用')}
            error={touched && descError ? descError : undefined}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label={tr('正文（Markdown）')} htmlFor={`${ids}-body`}>
          <Textarea
            id={`${ids}-body`}
            value={body}
            rows={14}
            maxLength={60_000}
            spellCheck={false}
            placeholder={tr('## 步骤\n1. …\n2. …')}
            className="font-mono text-small"
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {skill && <Attachments skill={skill} />}
        <div className="grid gap-2 sm:grid-cols-3">
          <SwitchRow title={tr('启用')} checked={enabled} onCheckedChange={setEnabled} />
          <SwitchRow
            title={tr('成员可点名')}
            hint={tr('出现在 / 菜单里')}
            checked={userInvocable}
            onCheckedChange={setUserInvocable}
          />
          <SwitchRow
            title={tr('agent 可自选')}
            hint={tr('按描述自己加载')}
            checked={modelInvocable}
            onCheckedChange={setModelInvocable}
          />
        </div>
        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}

function Attachments({ skill }: { skill: Skill }) {
  if (skill.attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-fg-subtle">{tr('附带文件')}</span>
      <ul className="flex flex-wrap gap-1.5">
        {skill.attachments.map((a) => (
          <li
            key={a.path}
            className="inline-flex items-center gap-1 rounded-xs bg-muted px-1.5 font-mono text-caption text-fg-muted"
          >
            <Paperclip size={12} strokeWidth={1.75} aria-hidden />
            {a.path}
            <span className="text-fg-subtle tabular-nums">{Math.ceil(a.size / 1024)} KB</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const IMPORT_PLACEHOLDER = tr(
  '---\nname: lit-review\ndescription: 需要系统梳理某个方向的已有工作时使用\n---\n\n## 步骤\n1. …',
);

/** 导入 SKILL.md：粘贴带 YAML frontmatter 的文本。 */
export function SkillImportDialog({
  pid,
  open,
  onOpenChange,
}: {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const perm = useHarnessPerm(pid);
  const imp = useImportSkill(pid);
  const [scope, setScope] = useState<WritableScope>(perm.scopes[0] ?? 'personal');
  const [markdown, setMarkdown] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const mdError = markdown.trim() ? null : tr('请粘贴 SKILL.md 的内容');
  const slugError = slug.trim() ? validateSlug(slug) : null;

  const submit = () => {
    setTouched(true);
    if (mdError || slugError) return;
    imp.mutate(
      { scope, markdown, ...(slug.trim() ? { slug: slug.trim() } : {}) },
      {
        onSuccess: (s) => {
          toast.success(
            tr('已导入「{name}」', { name: s.name }),
            tr('成员可以用 /{slug} 点名。', { slug: s.slug }),
          );
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!imp.isPending) onOpenChange(v);
      }}
      size="lg"
      title={tr('导入 SKILL.md')}
      description={tr(
        '兼容 Claude Code / DSH 的格式：frontmatter 里的 name、description、disable-model-invocation、user-invocable 会被读取。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={imp.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={imp.isPending} onClick={submit}>
            {tr('导入')}
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
        <ScopeField value={scope} onChange={setScope} scopes={perm.scopes} idPrefix={ids} />
        <Field label="SKILL.md" htmlFor={`${ids}-md`}>
          <Textarea
            id={`${ids}-md`}
            data-autofocus
            value={markdown}
            rows={14}
            maxLength={60_000}
            spellCheck={false}
            placeholder={IMPORT_PLACEHOLDER}
            className="font-mono text-small"
            error={touched && mdError ? mdError : undefined}
            onChange={(e) => setMarkdown(e.target.value)}
          />
        </Field>
        <Field
          label={tr('点名用的名字（选填）')}
          htmlFor={`${ids}-slug`}
          hint={tr('不填则用 frontmatter 里的 name。{SLUG_HINT}', { SLUG_HINT })}
        >
          <Input
            id={`${ids}-slug`}
            value={slug}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            error={touched && slugError ? slugError : undefined}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </Field>
        {imp.isError && <InlineError>{errorMessage(imp.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
