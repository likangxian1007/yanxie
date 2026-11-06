import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type Project, type ProjectVisibility } from '@srh/shared';
import { Button, Input, Tabs, Textarea, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { paletteSoft, paletteVar } from '@/lib/palette';
import { canManage, useMyRole, useProject } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import { errorMessage, VISIBILITY_LABEL } from '../lib';
import {
  ConfirmDialog,
  ErrorCard,
  Field,
  InlineError,
  PaletteSwatches,
  ReadOnlyNote,
  SectionSkeleton,
  SettingsCard,
} from './parts';
import { tr } from '@/lib/i18n';

interface GeneralFields {
  name: string;
  description: string;
  icon: string;
  color: number;
  visibility: ProjectVisibility;
  researchDomains: string[];
}

const FIELDS = ['name', 'description', 'icon', 'color', 'visibility', 'researchDomains'] as const;

const VISIBILITY_HINT: Record<ProjectVisibility, string> = {
  private: tr('只有被邀请的成员能看到这个项目。'),
  team: tr('团队里的人都能找到这个项目，加入仍需邀请。'),
};

export function GeneralSection({ pid }: { pid: string }) {
  const project = useProject(pid);
  if (project.isPending) return <SectionSkeleton rows={4} />;
  if (project.isError)
    return <ErrorCard error={project.error} onRetry={() => void project.refetch()} />;
  return <GeneralForm pid={pid} project={project.data} />;
}

function GeneralForm({ pid, project }: { pid: string; project: Project }) {
  const qc = useQueryClient();
  const role = useMyRole(pid);
  const editable = canManage(role);
  const ids = useId();

  // 只记录改动过的字段；没改的字段始终跟随服务端（实时事件也会更新）
  const [draft, setDraft] = useState<Partial<GeneralFields>>({});
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const values: GeneralFields = {
    name: draft.name ?? project.name,
    description: draft.description ?? project.description,
    icon: draft.icon ?? project.icon,
    color: draft.color ?? project.color,
    visibility: draft.visibility ?? project.visibility,
    researchDomains: draft.researchDomains ?? project.researchDomains ?? [],
  };
  const changes: Partial<GeneralFields> = {};
  for (const key of FIELDS) {
    if (draft[key] !== undefined && JSON.stringify(draft[key]) !== JSON.stringify(project[key])) {
      Object.assign(changes, { [key]: draft[key] });
    }
  }
  const dirty = Object.keys(changes).length > 0;
  const set = <K extends keyof GeneralFields>(key: K, value: GeneralFields[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const nameError = values.name.trim() ? undefined : tr('项目名称不能为空');
  const iconError = values.icon.trim() ? undefined : tr('请填一个 emoji 或短字符');

  const save = useMutation({
    mutationFn: (body: Partial<GeneralFields>) => api.patch<Project>(`/projects/${pid}`, body),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(pid), p);
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.projects });
      setDraft({});
      setDomainsText(null);
      toast.success(tr('已保存项目设置'));
    },
  });

  const submit = () => {
    if (!dirty || nameError || iconError) return;
    const body = { ...changes };
    if (body.name !== undefined) body.name = body.name.trim();
    if (body.icon !== undefined) body.icon = body.icon.trim();
    save.mutate(body);
  };

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SettingsCard
          title={tr('项目信息')}
          description={tr('课题名称与标识。')}
          footer={
            <>
              {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
              {!editable && <ReadOnlyNote />}
              {editable && dirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft({});
                    setDomainsText(null);
                  }}
                  disabled={save.isPending}
                >
                  {tr('放弃更改')}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                loading={save.isPending}
                disabled={!editable || !dirty || Boolean(nameError || iconError)}
              >
                {tr('保存更改')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="grid size-10 shrink-0 place-items-center rounded-lg text-h3"
                style={{
                  backgroundColor: paletteSoft(values.color),
                  color: paletteVar(values.color),
                }}
              >
                {values.icon.trim() || '·'}
              </span>
              <div className="min-w-0">
                <p className="truncate text-h3 text-fg">{values.name.trim() || tr('未命名项目')}</p>
                <p className="truncate text-small text-fg-muted">
                  {VISIBILITY_LABEL[values.visibility]}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
              <Field label={tr('项目名称')} htmlFor={`${ids}-name`}>
                <Input
                  id={`${ids}-name`}
                  value={values.name}
                  maxLength={60}
                  disabled={!editable}
                  error={draft.name !== undefined ? nameError : undefined}
                  onChange={(e) => set('name', e.target.value)}
                />
              </Field>
              <Field label={tr('图标')} htmlFor={`${ids}-icon`}>
                <Input
                  id={`${ids}-icon`}
                  value={values.icon}
                  maxLength={8}
                  disabled={!editable}
                  placeholder="🔬"
                  error={draft.icon !== undefined ? iconError : undefined}
                  onChange={(e) => set('icon', e.target.value)}
                />
              </Field>
            </div>

            <Field
              label={tr('项目简介')}
              htmlFor={`${ids}-desc`}
              hint={`${values.description.length} / 500`}
            >
              <Textarea
                id={`${ids}-desc`}
                value={values.description}
                maxLength={500}
                rows={3}
                autoGrow
                disabled={!editable}
                placeholder={tr('一两句话说明这个项目在研究什么')}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>

            <Field
              label={tr('研究领域（可选）')}
              htmlFor={`${ids}-domains`}
              hint={tr('用逗号分隔，最多 30 个。')}
            >
              <Input
                id={`${ids}-domains`}
                value={domainsText ?? values.researchDomains.join(tr('、'))}
                disabled={!editable}
                onChange={(e) => {
                  setDomainsText(e.target.value);
                  set(
                    'researchDomains',
                    e.target.value
                      .split(/[，,、]/u)
                      .map((value) => value.trim())
                      .filter(Boolean),
                  );
                }}
                placeholder={tr('例如：公共卫生、信息科学')}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-small font-medium text-fg">{tr('项目颜色')}</span>
              <PaletteSwatches
                label={tr('项目颜色')}
                value={values.color}
                disabled={!editable}
                onChange={(c) => set('color', c)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span id={`${ids}-vis`} className="text-small font-medium text-fg">
                {tr('可见范围')}
              </span>
              <div>
                <Tabs<ProjectVisibility>
                  variant="segmented"
                  aria-label={tr('可见范围')}
                  layoutId={`${ids}-visibility`}
                  value={values.visibility}
                  onValueChange={(v) => {
                    if (editable) set('visibility', v);
                  }}
                  items={(['private', 'team'] as const).map((v) => ({
                    value: v,
                    label: VISIBILITY_LABEL[v],
                    disabled: !editable,
                  }))}
                />
              </div>
              <p className="text-caption font-normal text-fg-subtle">
                {VISIBILITY_HINT[values.visibility]}
              </p>
            </div>
          </div>
        </SettingsCard>
      </form>

      {role === 'owner' && <DangerZone pid={pid} project={project} />}
    </div>
  );
}

function DangerZone({ pid, project }: { pid: string; project: Project }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${pid}`),
    onSuccess: () => {
      setOpen(false);
      toast.success(tr('已删除项目「{name}」', { name: project.name }));
      navigate('/', { replace: true });
      void qc.invalidateQueries({ queryKey: qk.me });
      void qc.invalidateQueries({ queryKey: qk.projects });
    },
  });

  return (
    <>
      <SettingsCard
        tone="danger"
        title={tr('危险操作')}
        description={tr(
          '删除后，项目里的线程、文档、看板、研究空间和项目记忆都会一起删除，无法恢复。',
        )}
        actions={
          <Button
            variant="danger"
            leftIcon={<Trash2 strokeWidth={1.75} aria-hidden />}
            onClick={() => {
              remove.reset();
              setOpen(true);
            }}
          >
            {tr('删除项目')}
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tr('删除这个项目？')}
        description={tr('所有成员都会立刻失去访问权限，项目里的全部内容会被永久删除。')}
        confirmLabel={tr('删除项目')}
        requireText={project.name}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
