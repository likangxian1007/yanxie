import { useId, useState } from 'react';
import type { McpServer, McpTransport, WritableScope } from '@srh/shared';
import { Button, Dialog, Input, Tabs, Textarea, toast } from '@/components/ui';
import { useCreateMcpServer, useUpdateMcpServer } from '@/lib/harness';
import { cn } from '@/lib/cn';
import { errorMessage } from '../../lib';
import { Field, InlineError } from '../parts';
import { KeyValueEditor, ScopeField, SwitchRow } from './harness-parts';
import {
  rowsToRecord,
  splitLines,
  TRANSPORT_LABEL,
  useHarnessPerm,
  type KeyValueRow,
} from './perm';
import { tr } from '@/lib/i18n';

type Role = McpServer['roles'][number];

const ROLE_OPTIONS: { value: Role; label: string; hint: string }[] = [
  { value: 'coordinator', label: tr('协调者'), hint: tr('协作台的共用协调者') },
  { value: 'thread', label: tr('线程 agent'), hint: tr('协调者派出的项目线程') },
  { value: 'personal', label: tr('个人 agent'), hint: tr('成员自己的个人会话') },
];

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/u;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface McpServerDialogProps {
  pid: string;
  server: McpServer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 新建 / 编辑 MCP 服务器：stdio 填命令、参数、环境变量；HTTP / SSE 填地址和请求头。 */
export function McpServerDialog({ pid, server, open, onOpenChange }: McpServerDialogProps) {
  const ids = useId();
  const perm = useHarnessPerm(pid);
  const create = useCreateMcpServer(pid);
  const update = useUpdateMcpServer(pid);
  const save = server ? update : create;

  const [scope, setScope] = useState<WritableScope>(server?.scope ?? perm.scopes[0] ?? 'personal');
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'http');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState((server?.args ?? []).join('\n'));
  const [env, setEnv] = useState<KeyValueRow[]>(
    (server?.envKeys ?? []).map((key) => ({ key, value: '', existing: true })),
  );
  const [url, setUrl] = useState(server?.url ?? '');
  const [headers, setHeaders] = useState<KeyValueRow[]>(
    (server?.headerKeys ?? []).map((key) => ({ key, value: '', existing: true })),
  );
  const [roles, setRoles] = useState<Role[]>(
    server?.roles ?? ['coordinator', 'thread', 'personal'],
  );
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [touched, setTouched] = useState(false);

  const stdio = transport === 'stdio';
  const personalScope = scope === 'personal';
  const envResult = rowsToRecord(env);
  const headerResult = rowsToRecord(headers);
  const nameError = NAME_RE.test(name.trim())
    ? null
    : tr('只能用字母、数字、下划线和连字符，最长 32 位');
  const targetError = stdio
    ? command.trim()
      ? null
      : tr('请填写要启动的命令')
    : isHttpUrl(url)
      ? null
      : tr('请填写 http(s) 开头的服务地址');
  const kvError = stdio ? envResult.error : headerResult.error;
  const rolesError = !personalScope && roles.length === 0 ? tr('至少选一种 agent') : null;

  const submit = () => {
    setTouched(true);
    if (nameError || targetError || kvError || rolesError) return;
    const common = {
      name: name.trim(),
      description: description.trim(),
      enabled,
      ...(personalScope ? {} : { roles }),
      ...(stdio
        ? { command: command.trim(), args: splitLines(args), env: envResult.value }
        : { url: url.trim(), headers: headerResult.value }),
    };
    const onSuccess = (s: McpServer) => {
      toast.success(
        server
          ? tr('已保存「{name}」', { name: s.name })
          : tr('已添加「{name}」', { name: s.name }),
        s.state === 'error'
          ? tr('连接出错：{value}', { value: s.error ?? tr('未知原因') })
          : tr('正在连接并读取工具列表。'),
      );
      onOpenChange(false);
    };
    if (server) update.mutate({ id: server.id, patch: common }, { onSuccess });
    else create.mutate({ ...common, scope, transport }, { onSuccess });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!save.isPending) onOpenChange(v);
      }}
      size="md"
      title={server ? tr('编辑 MCP「{name}」', { name: server.name }) : tr('添加 MCP 服务器')}
      description={tr(
        '接入后，agent 能调用它提供的工具（名字形如 mcp__服务器名__工具名）。密钥只保存在服务端，不会再显示出来。',
      )}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {server ? tr('保存更改') : tr('添加服务器')}
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
        {!server && (
          <ScopeField value={scope} onChange={setScope} scopes={perm.scopes} idPrefix={ids} />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('名称')} htmlFor={`${ids}-name`} hint={tr('agent 看到的工具前缀')}>
            <Input
              id={`${ids}-name`}
              data-autofocus
              value={name}
              maxLength={32}
              spellCheck={false}
              autoComplete="off"
              placeholder={tr('例如 zotero')}
              className="font-mono"
              error={touched && nameError ? nameError : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-fg">{tr('连接方式')}</span>
            {server ? (
              <span className="flex h-8 items-center text-body text-fg-muted">
                {TRANSPORT_LABEL[transport]}
              </span>
            ) : (
              <Tabs<McpTransport>
                variant="segmented"
                aria-label={tr('连接方式')}
                layoutId={`${ids}-transport`}
                value={transport}
                onValueChange={setTransport}
                items={(['http', 'sse', 'stdio'] as const).map((t) => ({
                  value: t,
                  label: TRANSPORT_LABEL[t],
                }))}
                className="self-start"
              />
            )}
          </div>
        </div>

        <Field label={tr('说明')} htmlFor={`${ids}-desc`}>
          <Input
            id={`${ids}-desc`}
            value={description}
            maxLength={300}
            placeholder={tr('它能做什么（选填）')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {stdio ? (
          <>
            <Field
              label={tr('命令')}
              htmlFor={`${ids}-cmd`}
              hint={tr('在服务器上启动的子进程，需要部署方开启 MCP_ALLOW_STDIO。')}
            >
              <Input
                id={`${ids}-cmd`}
                value={command}
                maxLength={400}
                spellCheck={false}
                autoComplete="off"
                placeholder="npx"
                className="font-mono"
                error={touched && targetError ? targetError : undefined}
                onChange={(e) => setCommand(e.target.value)}
              />
            </Field>
            <Field
              label={tr('参数')}
              htmlFor={`${ids}-args`}
              hint={tr('每行一个参数，不做 shell 展开。')}
            >
              <Textarea
                id={`${ids}-args`}
                value={args}
                rows={3}
                autoGrow
                spellCheck={false}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/data'}
                className="font-mono text-small"
                onChange={(e) => setArgs(e.target.value)}
              />
            </Field>
            <Field label={tr('环境变量')}>
              <KeyValueEditor
                label={tr('环境变量')}
                rows={env}
                onChange={setEnv}
                keyPlaceholder="API_TOKEN"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={tr('服务地址')} htmlFor={`${ids}-url`}>
              <Input
                id={`${ids}-url`}
                value={url}
                maxLength={500}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'
                }
                className="font-mono"
                error={touched && targetError ? targetError : undefined}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field label={tr('请求头')}>
              <KeyValueEditor
                label={tr('请求头')}
                rows={headers}
                onChange={setHeaders}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer …"
              />
            </Field>
          </>
        )}
        {touched && kvError && <InlineError>{kvError}</InlineError>}

        {!personalScope && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-small font-medium text-fg">
              {tr('哪些 agent 能用')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS.map((r) => {
                const on = roles.includes(r.value);
                return (
                  <label
                    key={r.value}
                    title={r.hint}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-small',
                      on
                        ? 'border-accent/40 bg-accent-soft text-accent-text'
                        : 'border-line text-fg-muted',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setRoles((list) =>
                          on ? list.filter((x) => x !== r.value) : [...list, r.value],
                        )
                      }
                      className="size-3.5 accent-(--accent)"
                    />
                    {r.label}
                  </label>
                );
              })}
            </div>
            {touched && rolesError && <InlineError>{rolesError}</InlineError>}
          </fieldset>
        )}

        <SwitchRow
          title={tr('启用')}
          hint={tr('停用后断开连接，agent 看不到它的工具。')}
          checked={enabled}
          onCheckedChange={setEnabled}
        />

        {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
      </form>
    </Dialog>
  );
}
