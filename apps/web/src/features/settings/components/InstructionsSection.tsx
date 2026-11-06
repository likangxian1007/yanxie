import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import type { Project } from '@srh/shared';
import { Button, EmptyState, Markdown, Tabs, Textarea, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { canManage, useMyRole, useProject } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import { errorMessage } from '../lib';
import { ErrorCard, InlineError, ReadOnlyNote, SectionSkeleton, SettingsCard } from './parts';
import { locale, tr } from '@/lib/i18n';

const MAX = 20_000;
type Mode = 'edit' | 'preview';

const PLACEHOLDER = tr(
  '## 项目背景\n我们在研究……\n\n## 协作约定\n- 回答用中文，引用论文时给出处\n- 改动实验配置前先在线程里说明\n',
);

export function InstructionsSection({ pid }: { pid: string }) {
  const project = useProject(pid);
  if (project.isPending) return <SectionSkeleton rows={2} />;
  if (project.isError)
    return <ErrorCard error={project.error} onRetry={() => void project.refetch()} />;
  return <InstructionsEditor pid={pid} project={project.data} />;
}

function InstructionsEditor({ pid, project }: { pid: string; project: Project }) {
  const qc = useQueryClient();
  const editable = canManage(useMyRole(pid));
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(editable ? 'edit' : 'preview');
  const value = draft ?? project.instructions;
  const dirty = draft !== null && draft !== project.instructions;
  const tooLong = value.length > MAX;
  const effectiveMode: Mode = editable ? mode : 'preview';

  const save = useMutation({
    mutationFn: (instructions: string) => api.patch<Project>(`/projects/${pid}`, { instructions }),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(pid), p);
      setDraft(null);
      toast.success(tr('已保存协调者指令'), tr('协调者下一次回复时就会按新的指令工作。'));
    },
  });

  return (
    <SettingsCard
      title={tr('协调者指令')}
      description={tr('协调者和线程 agent 每次开始工作都会读取这些说明。')}
      actions={
        editable ? (
          <Tabs<Mode>
            variant="segmented"
            size="sm"
            aria-label={tr('编辑或预览')}
            layoutId={`${id}-mode`}
            value={effectiveMode}
            onValueChange={setMode}
            items={[
              { value: 'edit', label: tr('编辑') },
              { value: 'preview', label: tr('预览') },
            ]}
          />
        ) : undefined
      }
      footer={
        <>
          {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
          {!editable && <ReadOnlyNote />}
          <span
            className={
              tooLong
                ? 'text-caption text-danger tabular-nums'
                : 'text-caption font-normal text-fg-subtle tabular-nums'
            }
          >
            {value.length.toLocaleString(locale())} / {MAX.toLocaleString(locale())}
          </span>
          {editable && dirty && (
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
              {tr('放弃更改')}
            </Button>
          )}
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!editable || !dirty || tooLong}
            onClick={() => save.mutate(value)}
          >
            {tr('保存更改')}
          </Button>
        </>
      }
    >
      {effectiveMode === 'edit' ? (
        <Textarea
          aria-label={tr('协调者指令')}
          value={value}
          rows={12}
          autoGrow
          spellCheck={false}
          placeholder={PLACEHOLDER}
          className="min-h-60 font-mono text-small leading-relaxed"
          error={
            tooLong
              ? tr('最多 {MAX} 个字符，请精简一些', { MAX: MAX.toLocaleString(locale()) })
              : undefined
          }
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : value.trim() ? (
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-line bg-canvas px-4 py-3">
          <Markdown>{value}</Markdown>
        </div>
      ) : (
        <EmptyState
          icon={ScrollText}
          className="rounded-md border border-dashed border-line-strong py-10"
          title={tr('还没有协调者指令')}
          description={
            editable
              ? tr('切换到编辑，写下项目背景和协作约定，协调者会按它来工作。')
              : tr('负责人或导师写好指令后，会显示在这里。')
          }
        />
      )}
    </SettingsCard>
  );
}
