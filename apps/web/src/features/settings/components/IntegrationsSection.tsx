import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import type { ApiToken, ApiTokenCreated, ApiTokenList } from '@srh/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Switch,
  toast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { withBase } from '@/lib/base-path';
import { qk } from '@/lib/query-keys';
import { useMe } from '@/lib/session';
import { errorMessage } from '../lib';
import {
  ConfirmDialog,
  ErrorCard,
  Field,
  InlineError,
  SectionSkeleton,
  SettingsCard,
} from './parts';
import { locale, tr } from '@/lib/i18n';

/**
 * 设置 → 接入：API 令牌（API.md §2.21）。
 *
 * 令牌是给 dots 这类个人 agent / 脚本的「门禁卡」：`Authorization: Bearer srh_pat_…`。
 * 原文只在创建响应里出现一次，库里只存 SHA-256，所以列表只能显示 hint；
 * 令牌能做的事不会超过本人在网页上能做的（角色、项目成员、认领规则一律照旧）。
 */
const EXPIRY_OPTIONS = [
  { value: '30', label: tr('30 天') },
  { value: '90', label: tr('90 天') },
  { value: '365', label: tr('365 天') },
  { value: 'never', label: tr('永不过期') },
];

const EXAMPLE = tr(
  'curl -s "https://你的站点/api/v1/projects" \\\n  -H "Authorization: Bearer srh_pat_…"',
);

/** MCP 客户端的配置片段（API.md §2.22）：地址按当前站点拼，令牌留占位符让用户自己换 */
function mcpSnippet(): string {
  const origin = typeof window === 'undefined' ? tr('https://你的站点') : window.location.origin;
  return JSON.stringify(
    {
      mcpServers: {
        研协: {
          type: 'http',
          url: `${origin}${withBase('/api/v1/mcp')}`,
          headers: { Authorization: 'Bearer srh_pat_…' },
        },
      },
    },
    null,
    2,
  );
}

async function copyText(text: string, ok: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error(tr('没能复制'), tr('浏览器不允许访问剪贴板，请手动选中后复制。'));
  }
}

export function IntegrationsSection() {
  const qc = useQueryClient();
  const me = useMe();
  const tokens = useQuery({
    queryKey: qk.apiTokens,
    queryFn: ({ signal }) => api.get<ApiTokenList>('/auth/me/tokens', { signal }),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/me/tokens/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.apiTokens });
      setRevoking(null);
      toast.success(tr('已撤销这个令牌'));
    },
  });

  const enabled = tokens.data?.enabled ?? false;

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        title={tr('API 令牌')}
        description={tr(
          '给 dots 这类个人 agent 或脚本用的钥匙。令牌跟账号走，能做的事不会超过你本人在网页上能做的；原文只显示一次，丢了只能重新生成。',
        )}
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            disabled={!enabled}
            onClick={() => setCreateOpen(true)}
          >
            {tr('新建令牌')}
          </Button>
        }
      >
        {!tokens.isPending && !enabled && (
          <p className="mb-4 flex items-start gap-2 rounded-md border border-line bg-subtle p-3 text-small text-fg-muted">
            <ShieldAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              {tr('服务器还没打开这个功能：在部署的 ')}
              <code className="font-mono">.env</code>
              {tr(' 里设')} <code className="font-mono">API_TOKENS_ENABLED=true</code>
              {tr(' 并重启后，才能新建令牌。 已经生成的令牌现在全部无效。')}
            </span>
          </p>
        )}
        {tokens.isPending ? (
          <SectionSkeleton rows={2} />
        ) : tokens.isError ? (
          <ErrorCard error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.tokens.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={tr('还没有令牌')}
            description={tr('建一个令牌，贴进 dots 或你自己的脚本，就能读写这个账号能访问的项目。')}
            className="py-8"
          />
        ) : (
          <ul
            aria-label={tr('API 令牌列表')}
            className="-mx-4 flex flex-col divide-y divide-line border-t border-line"
          >
            {tokens.data.tokens.map((token) => (
              <TokenRow key={token.id} token={token} onRevoke={() => setRevoking(token)} />
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard
        title={tr('怎么用')}
        description={tr(
          '令牌放在 Authorization 头里，效果和网页登录一样。可以先用它读一次项目列表试试。',
        )}
      >
        <div className="flex flex-col gap-3">
          <pre className="overflow-x-auto rounded-md border border-line bg-subtle p-3 text-caption">
            <code className="font-mono">{EXAMPLE}</code>
          </pre>
          <p className="text-caption text-fg-subtle">
            {tr(
              '只读令牌只能看，不能发消息或改东西；限定项目的令牌碰不到别的项目。令牌调用太频繁会返回 429，等一会儿再试。',
            )}
          </p>
        </div>
      </SettingsCard>

      {tokens.data?.mcpEnabled && (
        <SettingsCard
          title={tr('接给 AI agent（MCP）')}
          description={tr(
            '把下面这段贴进 dots、Cursor 这类支持 MCP 的客户端，它就能自己读项目、发消息。凭证就是上面生成的令牌。',
          )}
        >
          <div className="flex flex-col gap-3">
            <pre className="overflow-x-auto rounded-md border border-line bg-subtle p-3 text-caption">
              <code className="font-mono">{mcpSnippet()}</code>
            </pre>
            <Button
              variant="secondary"
              leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
              onClick={() => void copyText(mcpSnippet(), tr('已复制 MCP 配置'))}
            >
              {tr('复制 MCP 配置')}
            </Button>
            <p className="text-caption text-fg-subtle">
              {tr('把 ')}
              <code className="font-mono">srh_pat_…</code>{' '}
              {tr(
                '换成你自己的令牌。只读令牌接进去只能看； 写操作（发消息、建待办）有每天的次数上限，超了会返回中文提示。',
              )}
            </p>
          </div>
        </SettingsCard>
      )}

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={me.data?.projects ?? []}
        onCreated={(data) => {
          setCreateOpen(false);
          setCreated(data);
          void qc.invalidateQueries({ queryKey: qk.apiTokens });
        }}
      />

      <TokenCreatedDialog created={created} onClose={() => setCreated(null)} />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={tr('撤销这个令牌？')}
        description={
          revoking
            ? tr('「{name}」撤销后立刻失效，用它接的 agent 会马上报 401。这个操作不能恢复。', {
                name: revoking.name,
              })
            : undefined
        }
        confirmLabel={tr('撤销令牌')}
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id);
        }}
      />
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke: () => void }) {
  const revoked = token.revokedAt !== null;
  // 「是否过期」由服务端算好（ApiToken.expired）：渲染期不读 Date.now()，避免同一份数据画出不同结果
  const expired = !revoked && token.expired;
  const canWrite = token.scopes.includes('write');
  const usage = token.lastUsedAt
    ? tr('最后使用 {value}', { value: new Date(token.lastUsedAt).toLocaleString(locale()) })
    : tr('还没用过');
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-subtle text-fg-muted ring-1 ring-line">
        <KeyRound size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-body font-medium text-fg">{token.name}</span>
          <code className="truncate font-mono text-caption text-fg-subtle">
            srh_pat_{token.hint}…
          </code>
        </div>
        <p className="truncate text-small text-fg-subtle">
          {canWrite ? tr('可读可写') : tr('只读')}
          {token.projectIds.length > 0
            ? tr(' · 限定 {count} 个项目', { count: token.projectIds.length })
            : tr(' · 全部项目')}
          {` · ${usage}`}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {revoked ? (
          <Badge tone="neutral">{tr('已撤销')}</Badge>
        ) : expired ? (
          <Badge tone="warning">{tr('已过期')}</Badge>
        ) : (
          <>
            <Badge tone={canWrite ? 'accent' : 'neutral'}>
              {canWrite ? tr('可写') : tr('只读')}
            </Badge>
            <IconButton
              label={tr('撤销 {name}', { name: token.name })}
              size="sm"
              onClick={onRevoke}
            >
              <Trash2 strokeWidth={1.75} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </li>
  );
}

function CreateTokenDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  onCreated: (data: ApiTokenCreated) => void;
}) {
  const ids = useId();
  const [name, setName] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [allProjects, setAllProjects] = useState(true);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [touched, setTouched] = useState(false);

  const nameError = name.trim() ? undefined : tr('请给这个令牌起个名字，例如「我的 dots」');
  const projectError = !allProjects && projectIds.length === 0 ? tr('至少选一个项目') : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.post<ApiTokenCreated>('/auth/me/tokens', {
        name: name.trim(),
        scopes: canWrite ? ['read', 'write'] : ['read'],
        projectIds: allProjects ? [] : projectIds,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      }),
    onSuccess: (data) => {
      onCreated(data);
      setName('');
      setCanWrite(false);
      setAllProjects(true);
      setProjectIds([]);
      setExpiry('90');
      setTouched(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr('新建 API 令牌')}
      description={tr('起一个能认出来的名字，选好权限和范围。生成后会显示一次原文。')}
      size="md"
      footer={
        <>
          {create.isError && <InlineError>{errorMessage(create.error)}</InlineError>}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTouched(true);
              if (!nameError && !projectError) create.mutate();
            }}
          >
            {tr('生成令牌')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          htmlFor={`${ids}-name`}
          label={tr('名字')}
          hint={tr('只给你自己看，用来区分不同用途')}
        >
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={60}
            autoComplete="off"
            placeholder={tr('我的 dots')}
            error={touched ? nameError : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <div className="flex items-start justify-between gap-4 rounded-md border border-line p-3">
          <div className="min-w-0">
            <p className="text-small font-medium text-fg">{tr('允许写入')}</p>
            <p className="mt-0.5 text-caption text-fg-subtle">
              {tr('关闭时只能读（看项目、线程、文档）；打开后才能发消息、改待办、编辑内容。')}
            </p>
          </div>
          <Switch checked={canWrite} onCheckedChange={setCanWrite} label={tr('允许写入')} />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <span className="text-small font-medium text-fg">{tr('限定项目')}</span>
            <label className="flex items-center gap-2 text-small text-fg-muted">
              <input
                type="checkbox"
                className="size-4"
                checked={allProjects}
                onChange={(e) => setAllProjects(e.target.checked)}
              />
              {tr('全部项目')}
            </label>
          </div>
          {!allProjects && (
            <div className="max-h-52 overflow-y-auto rounded-md border border-line p-2">
              {projects.length === 0 ? (
                <p className="p-1 text-small text-fg-subtle">{tr('你还没有加入任何项目。')}</p>
              ) : (
                <ul className="flex flex-col">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <label className="flex min-h-9 items-center gap-2 rounded-sm px-1 text-small">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={projectIds.includes(p.id)}
                          onChange={(e) =>
                            setProjectIds((prev) =>
                              e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                            )
                          }
                        />
                        <span className="truncate">{p.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {touched && projectError && <p className="text-caption text-danger">{projectError}</p>}
        </div>

        <Field
          htmlFor={`${ids}-expiry`}
          label={tr('有效期')}
          hint={tr('到期后令牌自动失效，需要重新生成')}
        >
          <Select
            id={`${ids}-expiry`}
            value={expiry}
            options={EXPIRY_OPTIONS}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function TokenCreatedDialog({
  created,
  onClose,
}: {
  created: ApiTokenCreated | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('令牌已生成')}
      description={tr('这串原文只显示这一次。关掉窗口后就再也看不到，只能重新生成。')}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {tr('我已保存')}
        </Button>
      }
    >
      {created && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-line bg-subtle p-3">
            <Check size={16} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0 text-success" />
            <p className="text-small text-fg-muted">
              {tr('把它贴进 dots 的 MCP / HTTP 配置，或你自己的脚本里。别发到群里、别提交进 Git。')}
            </p>
          </div>
          <Input
            readOnly
            aria-label={tr('令牌原文')}
            value={created.token}
            className="font-mono text-small"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            variant="secondary"
            leftIcon={<Copy strokeWidth={1.75} aria-hidden />}
            onClick={() => void copyText(created.token, tr('已复制令牌'))}
          >
            {tr('复制令牌')}
          </Button>
          <p className="text-caption text-fg-subtle">
            {tr('名字：')}
            {created.apiToken.name}
            {created.apiToken.expiresAt
              ? tr(' · 到期：{value}', {
                  value: new Date(created.apiToken.expiresAt).toLocaleDateString(locale()),
                })
              : tr(' · 永不过期')}
          </p>
        </div>
      )}
    </Dialog>
  );
}
