import { useId, useState } from 'react';
import { Copy } from 'lucide-react';
import {
  EFFORT_LABEL,
  type AgentProfile,
  type ReasoningEffort,
  type WritableScope,
} from '@srh/shared';
import { Button, Dialog, Input, Select, Textarea, toast } from '@/components/ui';
import { EFFORT_ORDER, PROFILE_ICON_NAMES, ProfileGlyph } from '@/features/harness';
import { useCreateProfile, useUpdateProfile } from '@/lib/harness';
import { cn } from '@/lib/cn';
import { errorMessage } from '../../lib';
import { Field, InlineError } from '../parts';
import { ReadOnlyBlock, ScopeBadge, ScopeField } from './harness-parts';
import { SLUG_HINT, splitLines, splitList, useHarnessPerm, validateSlug } from './perm';
import { tr, trServer } from '@/lib/i18n';

export interface ProfileDialogProps {
  pid: string;
  profile: AgentProfile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopy?: (profile: AgentProfile) => void;
  copyLabel?: string;
}

const EFFORT_OPTIONS = [
  { value: '', label: tr('跟随模型默认') },
  ...EFFORT_ORDER.map((e) => ({ value: e, label: EFFORT_LABEL[e] })),
];

/** 科研 profile：一段角色设定 + 默认加载的 Skill + 开场引导 + 建议的推理强度。 */
export function ProfileDialog({
  pid,
  profile,
  open,
  onOpenChange,
  onCopy,
  copyLabel,
}: ProfileDialogProps) {
  const ids = useId();
  const perm = useHarnessPerm(pid);
  const create = useCreateProfile(pid);
  const update = useUpdateProfile(pid);
  const save = profile ? update : create;
  const readOnly = profile !== null && !perm.canEdit(profile);

  const [scope, setScope] = useState<WritableScope>(perm.scopes[0] ?? 'personal');
  const [slug, setSlug] = useState(profile?.slug ?? '');
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [icon, setIcon] = useState(profile?.icon ?? 'Sparkles');
  const [prompt, setPrompt] = useState(profile?.prompt ?? '');
  const [skills, setSkills] = useState((profile?.skills ?? []).join(', '));
  const [starters, setStarters] = useState((profile?.starters ?? []).join('\n'));
  const [effort, setEffort] = useState<ReasoningEffort | ''>(profile?.effort ?? '');
  const [touched, setTouched] = useState(false);

  const slugError = profile ? null : validateSlug(slug);
  const nameError = name.trim() ? null : tr('请填写名称');
  const promptError = prompt.trim() ? null : tr('请写角色设定');

  if (readOnly && profile) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <ProfileGlyph icon={profile.icon} size={18} className="text-agent" />
            {trServer(profile.name)}
            <ScopeBadge scope={profile.scope} />
          </span>
        }
        description={trServer(profile.description)}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {tr('关闭')}
            </Button>
            {onCopy && (
              <Button
                variant="primary"
                leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
                onClick={() => onCopy(profile)}
              >
                {copyLabel ?? tr('复制到项目')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3 text-small text-fg-muted">
          <ReadOnlyBlock>{profile.prompt}</ReadOnlyBlock>
          {profile.skills.length > 0 && (
            <p>
              {tr('默认加载：')}
              {profile.skills.map((s) => (
                <code key={s} className="mr-1.5 font-mono text-fg">
                  /{s}
                </code>
              ))}
            </p>
          )}
          {profile.effort && (
            <p>{tr('建议推理强度：{value}', { value: EFFORT_LABEL[profile.effort] })}</p>
          )}
          {profile.starters.length > 0 && (
            <div>
              <p className="mb-1">{tr('开场引导')}</p>
              <ul className="list-disc pl-5">
                {profile.starters.map((s) => (
                  <li key={s}>{trServer(s)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  const submit = () => {
    setTouched(true);
    if (slugError || nameError || promptError) return;
    const fields = {
      name: name.trim(),
      description: description.trim(),
      icon,
      prompt,
      skills: splitList(skills).map((s) => s.replace(/^\//u, '')),
      starters: splitLines(starters).slice(0, 6),
      effort: effort || null,
    };
    const onSuccess = (p: AgentProfile) => {
      toast.success(
        profile
          ? tr('已保存「{name}」', { name: p.name })
          : tr('已新建 profile「{name}」', { name: p.name }),
      );
      onOpenChange(false);
    };
    if (profile) update.mutate({ id: profile.id, patch: fields }, { onSuccess });
    else create.mutate({ ...fields, scope, slug: slug.trim() }, { onSuccess });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="lg"
      title={profile ? tr('编辑「{name}」', { name: trServer(profile.name) }) : tr('新建 profile')}
      description={tr(
        'profile 是 agent 的科研角色：选用后，角色设定会加进系统提示，列出的 Skill 默认加载。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {profile ? tr('保存更改') : tr('新建 profile')}
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
        {!profile && (
          <ScopeField value={scope} onChange={setScope} scopes={perm.scopes} idPrefix={ids} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('名称')} htmlFor={`${ids}-name`}>
            <Input
              id={`${ids}-name`}
              data-autofocus
              value={name}
              maxLength={40}
              placeholder={tr('例如：审稿人')}
              error={touched && nameError ? nameError : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={tr('标识')}
            htmlFor={`${ids}-slug`}
            hint={
              profile
                ? tr('创建后不能修改')
                : tr('/profile 后面跟的名字。{SLUG_HINT}', { SLUG_HINT })
            }
          >
            <Input
              id={`${ids}-slug`}
              value={profile ? profile.slug : slug}
              readOnly={Boolean(profile)}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder="reviewer"
              className="font-mono"
              error={touched && slugError ? slugError : undefined}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </Field>
        </div>
        <Field label={tr('一句话说明')} htmlFor={`${ids}-desc`}>
          <Input
            id={`${ids}-desc`}
            value={description}
            maxLength={200}
            placeholder={tr('例如：按顶会审稿标准挑毛病')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">{tr('图标')}</span>
          <div role="radiogroup" aria-label={tr('图标')} className="flex flex-wrap gap-1">
            {PROFILE_ICON_NAMES.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={icon === n}
                aria-label={n}
                title={n}
                onClick={() => setIcon(n)}
                className={cn(
                  'press inline-flex size-8 cursor-pointer items-center justify-center rounded-md border',
                  'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                  icon === n
                    ? 'border-agent/40 bg-agent-soft text-agent-text'
                    : 'border-line text-fg-muted hover:border-line-strong hover:text-fg',
                )}
              >
                <ProfileGlyph icon={n} size={16} />
              </button>
            ))}
          </div>
        </div>
        <Field label={tr('角色设定')} htmlFor={`${ids}-prompt`}>
          <Textarea
            id={`${ids}-prompt`}
            value={prompt}
            rows={8}
            maxLength={20_000}
            placeholder={tr(
              '你是一位严格的审稿人。阅读材料时，先概括贡献，再逐条指出方法、实验和写作上的问题……',
            )}
            className="text-small"
            error={touched && promptError ? promptError : undefined}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={tr('默认加载的 Skill')}
            htmlFor={`${ids}-skills`}
            hint={tr('填 Skill 的名字，逗号分隔')}
          >
            <Input
              id={`${ids}-skills`}
              value={skills}
              spellCheck={false}
              autoComplete="off"
              placeholder="lit-review, paper-reading"
              className="font-mono"
              onChange={(e) => setSkills(e.target.value)}
            />
          </Field>
          <Field
            label={tr('建议推理强度')}
            htmlFor={`${ids}-effort`}
            hint={tr('选用时自动切换，模型不支持则忽略')}
          >
            <Select
              id={`${ids}-effort`}
              value={effort}
              options={EFFORT_OPTIONS}
              onChange={(e) => setEffort(e.target.value as ReasoningEffort | '')}
            />
          </Field>
        </div>
        <Field
          label={tr('开场引导')}
          htmlFor={`${ids}-starters`}
          hint={tr('每行一句，最多 6 句，新会话首屏会显示成可点的示例')}
        >
          <Textarea
            id={`${ids}-starters`}
            value={starters}
            rows={3}
            autoGrow
            maxLength={2000}
            placeholder={tr('帮我审一下这篇论文的实验部分\n这个 idea 最可能被拒的理由是什么')}
            className="text-small"
            onChange={(e) => setStarters(e.target.value)}
          />
        </Field>
        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
