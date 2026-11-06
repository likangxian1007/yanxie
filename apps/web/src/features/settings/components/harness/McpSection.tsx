import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import type { McpServer, McpState } from '@srh/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Switch,
  toast,
  type BadgeTone,
} from '@/components/ui';
import {
  useDeleteMcpServer,
  useMcpServers,
  useRefreshMcpServer,
  useUpdateMcpServer,
} from '@/lib/harness';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { errorMessage } from '../../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from '../parts';
import { ScopeBadge } from './harness-parts';
import { McpServerDialog } from './McpServerDialog';
import { TRANSPORT_LABEL, useHarnessPerm } from './perm';
import { tr } from '@/lib/i18n';

const STATE: Record<McpState, { label: string; tone: BadgeTone }> = {
  ready: { label: tr('已连接'), tone: 'success' },
  connecting: { label: tr('连接中'), tone: 'accent' },
  idle: { label: tr('未连接'), tone: 'neutral' },
  disabled: { label: tr('已停用'), tone: 'neutral' },
  error: { label: tr('出错'), tone: 'danger' },
};

const ROLE_LABEL: Record<McpServer['roles'][number], string> = {
  coordinator: tr('协调者'),
  thread: tr('线程 agent'),
  personal: tr('个人 agent'),
};

interface EditorState {
  open: boolean;
  server: McpServer | null;
  key: number;
}

/** 设置 → MCP：外部工具服务器，按作用域给不同的 agent 用。 */
export function McpSection({ pid }: { pid: string }) {
  const servers = useMcpServers(pid);
  const perm = useHarnessPerm(pid);
  const { variants, stagger } = useMotionPreset();
  const update = useUpdateMcpServer(pid);
  const refresh = useRefreshMcpServer(pid);
  const remove = useDeleteMcpServer(pid);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorState>({ open: false, server: null, key: 0 });
  const [deleting, setDeleting] = useState<McpServer | null>(null);

  const openEditor = (server: McpServer | null) =>
    setEditor((s) => ({ open: true, server, key: s.key + 1 }));

  const patch = (s: McpServer, body: Parameters<typeof update.mutate>[0]['patch'], ok?: string) =>
    update.mutate(
      { id: s.id, patch: body },
      {
        onSuccess: () => {
          if (ok) toast.success(ok);
        },
        onError: (e) => toast.error(tr('没能保存'), errorMessage(e)),
      },
    );

  const toggleTool = (s: McpServer, tool: string, on: boolean) => {
    const disabled = new Set(s.disabledTools);
    if (on) disabled.delete(tool);
    else disabled.add(tool);
    patch(s, { disabledTools: [...disabled] });
  };

  const newButton =
    perm.scopes.length > 0 ? (
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Plus strokeWidth={2} aria-hidden />}
        onClick={() => openEditor(null)}
      >
        {tr('添加服务器')}
      </Button>
    ) : (
      <ReadOnlyNote>{tr('访客不能添加 MCP 服务器')}</ReadOnlyNote>
    );

  let body: ReactNode;
  if (servers.isPending) body = <SectionSkeleton rows={2} />;
  else if (servers.isError)
    body = <ErrorCard error={servers.error} onRetry={() => void servers.refetch()} />;
  else if (servers.data.length === 0)
    body = (
      <EmptyState
        framed
        icon={Server}
        title={tr('还没有 MCP 服务器')}
        description={tr(
          '接入文献库、数据库、计算平台等外部工具，agent 就能直接调用。个人作用域的只对你自己的个人会话生效。',
        )}
        action={perm.scopes.length > 0 ? newButton : undefined}
      />
    );
  else
    body = (
      <motion.ul
        variants={stagger()}
        initial="hidden"
        animate="visible"
        aria-label={tr('MCP 服务器')}
        className="flex flex-col gap-3"
      >
        {servers.data.map((s) => {
          const editable = perm.canEdit(s);
          const state = STATE[s.state];
          const open = expanded[s.id] ?? false;
          const disabledCount = s.tools.filter((t) => !t.enabled).length;
          return (
            <motion.li key={s.id} variants={variants.fadeUp}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="min-w-0 truncate font-mono text-h3 text-fg">{s.name}</h3>
                      <ScopeBadge scope={s.scope} />
                      <Badge tone="neutral">{TRANSPORT_LABEL[s.transport]}</Badge>
                      <Badge tone={state.tone} dot>
                        {state.label}
                      </Badge>
                    </div>
                    {s.description && (
                      <p className="mt-0.5 text-small text-fg-muted">{s.description}</p>
                    )}
                    <p className="mt-0.5 font-mono text-caption font-normal break-all text-fg-subtle">
                      {s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}
                    </p>
                    {s.scope === 'project' && (
                      <p className="mt-0.5 text-caption font-normal text-fg-subtle">
                        {tr('可用：')}
                        {s.roles.map((r) => ROLE_LABEL[r]).join(tr('、'))}
                      </p>
                    )}
                  </div>
                  <Switch
                    label={
                      s.enabled
                        ? tr('停用「{name}」', { name: s.name })
                        : tr('启用「{name}」', { name: s.name })
                    }
                    checked={s.enabled}
                    disabled={!editable || (update.isPending && update.variables?.id === s.id)}
                    onCheckedChange={(enabled) =>
                      patch(
                        s,
                        { enabled },
                        enabled
                          ? tr('已启用「{name}」', { name: s.name })
                          : tr('已停用「{name}」', { name: s.name }),
                      )
                    }
                    className="mt-0.5"
                  />
                </div>

                {s.state === 'error' && s.error && (
                  <p
                    role="alert"
                    className="flex items-start gap-1.5 rounded-md bg-danger-soft px-3 py-2 text-small text-danger"
                  >
                    <AlertCircle
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 break-words">{s.error}</span>
                  </p>
                )}

                {s.tools.length > 0 && (
                  <div className="rounded-md border border-line">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded((m) => ({ ...m, [s.id]: !open }))}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-small text-fg-muted hover:text-fg"
                    >
                      <span className="flex-1">
                        {tr('工具 ')}
                        {s.tools.length}
                        {tr(' 个')}
                        {disabledCount > 0 && tr(' · 停用 {disabledCount} 个', { disabledCount })}
                      </span>
                      <ChevronDown
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden
                        className={cn(
                          'shrink-0 transition-transform duration-(--dur-fast)',
                          open && 'rotate-180',
                        )}
                      />
                    </button>
                    {open && (
                      <ul className="flex flex-col divide-y divide-line border-t border-line">
                        {s.tools.map((t) => (
                          <li key={t.name} className="flex items-start gap-3 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-small break-all text-fg">{t.name}</p>
                              {t.description && (
                                <p className="line-clamp-2 text-caption font-normal text-fg-subtle">
                                  {t.description}
                                </p>
                              )}
                            </div>
                            <Switch
                              label={
                                t.enabled
                                  ? tr('停用工具 {name}', { name: t.name })
                                  : tr('启用工具 {name}', { name: t.name })
                              }
                              checked={t.enabled}
                              disabled={!editable || update.isPending}
                              onCheckedChange={(on) => toggleTool(s, t.name, on)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {editable && (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<RefreshCw strokeWidth={1.75} aria-hidden />}
                      loading={refresh.isPending && refresh.variables === s.id}
                      disabled={!s.enabled}
                      onClick={() =>
                        refresh.mutate(s.id, {
                          onSuccess: (r) =>
                            r.state === 'ready'
                              ? toast.success(
                                  tr('「{name}」已连接', { name: r.name }),
                                  tr('读到 {count} 个工具。', { count: r.tools.length }),
                                )
                              : toast.error(
                                  tr('「{name}」连接出错', { name: r.name }),
                                  r.error ?? tr('请检查配置后重试。'),
                                ),
                          onError: (e) => toast.error(tr('没能重新连接'), errorMessage(e)),
                        })
                      }
                    >
                      {tr('重新连接')}
                    </Button>
                    <Menu
                      align="end"
                      label={tr('{name} 的操作', { name: s.name })}
                      trigger={
                        <IconButton label={tr('更多操作')} size="sm">
                          <MoreHorizontal strokeWidth={1.75} aria-hidden />
                        </IconButton>
                      }
                    >
                      <MenuItem
                        icon={<Pencil strokeWidth={1.75} aria-hidden />}
                        onSelect={() => openEditor(s)}
                      >
                        {tr('编辑')}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                        onSelect={() => {
                          remove.reset();
                          setDeleting(s);
                        }}
                      >
                        {tr('删除')}
                      </MenuItem>
                    </Menu>
                  </div>
                )}
              </Card>
            </motion.li>
          );
        })}
      </motion.ul>
    );

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('MCP 服务器')}
        description={tr('项目工具由负责人和导师管理，个人工具仅用于你自己的会话。')}
        actions={newButton}
      />
      {body}

      {perm.scopes.length > 0 && (
        <McpServerDialog
          key={editor.key}
          pid={pid}
          server={editor.server}
          open={editor.open}
          onOpenChange={(v) => {
            if (!v) setEditor((s) => ({ ...s, open: false }));
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        title={tr('删除 MCP「{value}」？', { value: deleting?.name ?? '' })}
        description={tr('agent 将不能再调用它的工具，保存的密钥一并删除。')}
        confirmLabel={tr('删除服务器')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success(tr('已删除「{name}」', { name: target.name }));
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}
