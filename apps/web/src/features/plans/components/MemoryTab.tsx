import { useState } from 'react';
import { BookCheck, Save } from 'lucide-react';
import type { PersonalMemory, ProjectMember } from '@srh/shared';
import { Button, Input, RelativeTime, Select, Skeleton, Textarea, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useMembers } from '@/lib/project';
import { usePersonalMemory, useSaveMemory } from '../api';
import { ProposalFormDialog } from './ProposalFormDialog';
import { LoadError, errorText } from './shared';
import { tr, trServer } from '@/lib/i18n';

export interface MemoryTabProps {
  pid: string;
  meId: string | undefined;
  canManage: boolean;
  canWrite: boolean;
}

/** 我的记忆：个人笔记，只自己（和负责人）可见；可整理为团队依据提案 */
export function MemoryTab({ pid, meId, canManage, canWrite }: MemoryTabProps) {
  const [viewUserId, setViewUserId] = useState<string | undefined>(undefined);
  const userId = viewUserId ?? meId;
  const members = useMembers(pid);
  const query = usePersonalMemory(pid, userId);
  const isMine = userId === meId;

  return (
    <div className="flex flex-col gap-3">
      {canManage && (members.data?.length ?? 0) > 1 && (
        <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="shrink-0 text-small text-fg-muted">{tr('查看成员')}</span>
          <Select
            wrapperClassName="sm:max-w-64"
            value={userId ?? ''}
            onChange={(e) => setViewUserId(e.target.value)}
          >
            {(members.data ?? []).map((m: ProjectMember) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.id === meId ? tr('{name}（我）', { name: m.user.name }) : m.user.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={tr('正在加载记忆')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.isError &&
        !(query.error instanceof ApiRequestError && query.error.status === 404) ? (
        <LoadError
          message={tr('记忆没能加载出来：{message}', { message: query.error.message })}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <MemoryEditor
          // 换人或服务端版本变化时重新挂载编辑器
          key={`${userId}:${query.data?.id ?? 'new'}`}
          pid={pid}
          memory={query.data ?? null}
          readOnly={!isMine || !canWrite}
          isMine={isMine}
        />
      )}
    </div>
  );
}

function MemoryEditor({
  pid,
  memory,
  readOnly,
  isMine,
}: {
  pid: string;
  memory: PersonalMemory | null;
  readOnly: boolean;
  isMine: boolean;
}) {
  const [title, setTitle] = useState(memory?.title ?? tr('我的记忆'));
  const [content, setContent] = useState(memory?.content ?? '');
  const [baseVersion, setBaseVersion] = useState(memory?.version ?? 0);
  const [proposalKey, setProposalKey] = useState(0);
  const [proposing, setProposing] = useState(false);
  const save = useSaveMemory(pid);
  const dirty = title !== (memory?.title ?? tr('我的记忆')) || content !== (memory?.content ?? '');
  const conflict = memory !== null && memory.version !== baseVersion;

  const onSave = () => {
    if (!title.trim()) return;
    save.mutate(
      { memoryId: memory?.id ?? null, title: title.trim(), content, baseVersion },
      {
        onSuccess: (m) => {
          setBaseVersion(m.version);
          toast({ title: tr('记忆已保存'), tone: 'success' });
        },
        onError: (e) => toast({ title: errorText(e, tr('保存记忆')), tone: 'danger' }),
      },
    );
  };

  if (readOnly && !memory) {
    return (
      <p className="rounded-md bg-subtle px-3 py-2.5 text-small text-fg-muted">
        {isMine ? tr('你还没有记忆。') : tr('这位成员还没有写记忆。')}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-small text-fg-muted">
        {isMine
          ? tr(
              '记录你的想法、观察和待验证的假设，只有你和负责人能看到。想让团队采用时，整理为团队依据提案。',
            )
          : tr('这是成员的个人记忆，你只能查看。')}
      </p>
      {conflict && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-small text-warning">
          {tr('记忆在别处更新过，保存会被拒绝。请复制你的修改后刷新页面。')}
        </p>
      )}
      <Input
        aria-label={tr('记忆标题')}
        value={title}
        maxLength={200}
        readOnly={readOnly}
        error={!title.trim() ? tr('写一个标题') : undefined}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        aria-label={tr('记忆内容')}
        rows={12}
        autoGrow
        readOnly={readOnly}
        maxLength={50_000}
        placeholder={tr('例如：在 B 数据集上学习率 3e-4 收敛更稳，但还没在 C 上验证')}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {memory && (
          <span className="mr-auto text-caption text-fg-subtle">
            {trServer(memory.updatedBy.name)}
            {tr(' 更新于 ')}
            <RelativeTime iso={memory.updatedAt} />
          </span>
        )}
        {!readOnly && (
          <Button
            variant="secondary"
            disabled={!content.trim() || dirty}
            leftIcon={<BookCheck strokeWidth={1.75} aria-hidden />}
            onClick={() => {
              setProposalKey((k) => k + 1);
              setProposing(true);
            }}
          >
            {tr('整理为团队依据提案')}
          </Button>
        )}
        {!readOnly && (
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!dirty || !title.trim()}
            leftIcon={<Save strokeWidth={1.75} aria-hidden />}
            onClick={onSave}
          >
            {tr('保存记忆')}
          </Button>
        )}
      </div>
      {!readOnly && dirty && content.trim() && (
        <p className="text-caption text-fg-subtle">{tr('先保存记忆，再整理为团队依据提案。')}</p>
      )}
      {memory && (
        <ProposalFormDialog
          key={proposalKey}
          pid={pid}
          open={proposing}
          onOpenChange={setProposing}
          description={tr('从你的记忆整理出一条依据，提交给负责人审批后纳入团队依据。')}
          initial={{
            kind: 'team_basis',
            title: memory.title,
            content: memory.content,
            rationale: '',
            impact: '',
            conditions: '',
            claimType: 'hypothesis',
            evidence: [
              {
                kind: 'personal_memory',
                ref: memory.id,
                version: String(memory.version),
                label: memory.title,
              },
            ],
          }}
        />
      )}
    </div>
  );
}
