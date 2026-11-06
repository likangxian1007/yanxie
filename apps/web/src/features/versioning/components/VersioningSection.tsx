import { useId, useState } from 'react';
import { CircleCheck, ExternalLink, PlugZap } from 'lucide-react';
import type { VersioningSettings } from '@srh/shared';
import { Badge, Button, Input, Switch, toast } from '@/components/ui';
import { canManage, useMyRole } from '@/lib/project';
import {
  ErrorCard,
  Field,
  InlineError,
  ReadOnlyNote,
  SectionSkeleton,
  SettingsCard,
} from '@/features/settings/components/parts';
import { errorMessage } from '@/features/settings/lib';
import {
  useTestGithub,
  useUpdateVersioningSettings,
  useVersioningEvents,
  useVersioningSettings,
} from '../api';
import { tr } from '@/lib/i18n';

/** 设置 →「版本与提案」：agent 写入方式、关联 GitHub 仓库 */
export function VersioningSection({ pid }: { pid: string }) {
  useVersioningEvents(pid);
  const q = useVersioningSettings(pid);
  if (q.isPending) return <SectionSkeleton rows={3} />;
  if (q.isError) return <ErrorCard error={q.error} onRetry={() => void q.refetch()} />;
  return <VersioningForm pid={pid} settings={q.data} />;
}

function VersioningForm({ pid, settings }: { pid: string; settings: VersioningSettings }) {
  const role = useMyRole(pid);
  const editable = canManage(role);
  const update = useUpdateVersioningSettings(pid);
  const test = useTestGithub(pid);
  const ids = useId();
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const repoValue = repo ?? settings.githubRepo ?? '';
  const branchValue = branch ?? settings.githubBranch;
  const dirty =
    (repo !== null && repo.trim() !== (settings.githubRepo ?? '')) ||
    (branch !== null && branch.trim() !== settings.githubBranch) ||
    token.trim() !== '';

  const toggleDirect = (on: boolean) =>
    update.mutate(
      { agentDirectWrite: on },
      {
        onSuccess: () =>
          toast({
            title: on ? tr('agent 将直接写入正文') : tr('agent 的修改将先成为改动提案'),
            tone: 'success',
          }),
        onError: (err) => toast({ title: errorMessage(err), tone: 'danger' }),
      },
    );

  const saveRepo = () =>
    update.mutate(
      {
        ...(repo !== null ? { githubRepo: repo.trim() || null } : {}),
        ...(branch !== null && branch.trim() ? { githubBranch: branch.trim() } : {}),
        ...(token.trim() ? { githubToken: token.trim() } : {}),
      },
      {
        onSuccess: () => {
          setRepo(null);
          setBranch(null);
          setToken('');
          toast({ title: tr('仓库设置已保存'), tone: 'success' });
        },
      },
    );

  const clearRepo = () =>
    update.mutate(
      { githubRepo: null, githubToken: null },
      {
        onSuccess: () => {
          setRepo(null);
          setToken('');
          test.reset();
          toast({ title: tr('已取消关联'), tone: 'success' });
        },
        onError: (err) => toast({ title: errorMessage(err), tone: 'danger' }),
      },
    );

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('agent 的修改方式')}
        description={tr(
          '默认 agent 改别人的文档、表格、LaTeX 和 notebook 时，不直接写进正文，而是生成一份改动提案，请负责人和导师审阅；可以逐条接受或拒绝，全部 LGTM 后自动合入。',
        )}
      >
        <div className="flex items-start justify-between gap-4 rounded-md border border-line px-3 py-3">
          <div className="min-w-0">
            <p className="text-small font-medium text-fg">{tr('允许 agent 直接写入')}</p>
            <p className="mt-0.5 text-caption text-fg-muted">
              {tr(
                '适合草稿阶段。打开后 agent 的修改立即生效，仍会自动存版本，可以在版本历史里回滚。',
              )}
            </p>
          </div>
          <Switch
            label={tr('允许 agent 直接写入')}
            checked={settings.agentDirectWrite}
            disabled={!editable || update.isPending}
            onCheckedChange={toggleDirect}
          />
        </div>
        {!editable && (
          <div className="mt-3">
            <ReadOnlyNote />
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={tr('代码仓库')}
        description={tr(
          '写代码的课题可以关联一个 GitHub 仓库：agent 读仓库里的文件，把代码改动提交到新分支并开 PR，由成员在 GitHub 上审阅合并。',
        )}
        actions={
          settings.githubRepo && settings.githubTokenSet ? (
            <Badge tone="success" dot>
              {tr('已关联')}
            </Badge>
          ) : (
            <Badge>{tr('未关联')}</Badge>
          )
        }
        footer={
          editable ? (
            <>
              {update.isError && <InlineError>{errorMessage(update.error)}</InlineError>}
              {settings.githubRepo && (
                <Button variant="ghost" onClick={clearRepo} disabled={update.isPending}>
                  {tr('取消关联')}
                </Button>
              )}
              <Button
                variant="secondary"
                leftIcon={<PlugZap size={14} strokeWidth={1.75} aria-hidden />}
                disabled={!settings.githubRepo || !settings.githubTokenSet || dirty}
                loading={test.isPending}
                onClick={() =>
                  test.mutate(undefined, {
                    onError: (err) => toast({ title: errorMessage(err), tone: 'danger' }),
                  })
                }
              >
                {tr('测试连接')}
              </Button>
              <Button
                variant="primary"
                disabled={!dirty}
                loading={update.isPending}
                onClick={saveRepo}
              >
                {tr('保存')}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field
            label={tr('仓库')}
            htmlFor={`${ids}-repo`}
            hint={tr('owner/name，例如 lab/paper-code')}
          >
            <Input
              id={`${ids}-repo`}
              value={repoValue}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
              disabled={!editable}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label={tr('目标分支')} htmlFor={`${ids}-branch`} hint={tr('PR 合并到这个分支')}>
            <Input
              id={`${ids}-branch`}
              value={branchValue}
              onChange={(e) => setBranch(e.target.value)}
              disabled={!editable}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field
            className="sm:col-span-2"
            label={tr('访问令牌')}
            htmlFor={`${ids}-token`}
            hint={
              settings.githubTokenSet
                ? tr('已保存（不会再显示）。填新的会替换旧的。')
                : tr(
                    'GitHub fine-grained token，只授权这一个仓库的 Contents 与 Pull requests 读写。',
                  )
            }
          >
            <Input
              id={`${ids}-token`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={settings.githubTokenSet ? '••••••••' : 'github_pat_…'}
              disabled={!editable}
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
        </div>

        {test.data && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-success-soft px-3 py-2 text-small text-fg">
            <CircleCheck
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className="shrink-0 text-success"
            />
            <span className="min-w-0 flex-1">
              {tr('连接正常：')}
              {test.data.fullName}
              {tr('（')}
              {test.data.private ? tr('私有') : tr('公开')}
              {tr('，默认分支')} {test.data.defaultBranch}
              {tr('）')}
              {!test.data.canPush && tr('。这个令牌没有写权限，agent 开不了 PR')}
            </span>
            <a
              href={test.data.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-accent-text hover:underline"
            >
              {tr('打开仓库')}
              <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
            </a>
          </div>
        )}

        <ul className="mt-4 flex list-disc flex-col gap-1 pl-5 text-caption text-fg-muted">
          <li>{tr('agent 只新建分支、开 PR，从不合并，也不推送到已有分支。')}</li>
          <li>{tr('每次改动整文件覆盖，一次最多 30 个文件、每个不超过 1 MB。')}</li>
          <li>{tr('仓库内容不会同步到项目文件；评审、CI 和合并都在 GitHub 上进行。')}</li>
        </ul>
        {!editable && (
          <div className="mt-3">
            <ReadOnlyNote />
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
