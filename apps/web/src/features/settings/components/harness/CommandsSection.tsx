import { useState, type ReactNode } from 'react';
import { MoreHorizontal, Pencil, Plus, SquareSlash, Trash2 } from 'lucide-react';
import type { CommandKind, SlashCommand } from '@srh/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  toast,
} from '@/components/ui';
import { useDeleteCommand, useSlashCommands } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from '../parts';
import { CommandDialog } from './CommandDialog';
import { ScopeBadge } from './harness-parts';
import { useHarnessPerm } from './perm';
import { tr, trServer } from '@/lib/i18n';

const KIND_LABEL: Record<CommandKind, string> = {
  client: tr('界面操作'),
  session: tr('会话操作'),
  prompt: tr('发给 agent'),
};

interface EditorState {
  open: boolean;
  command: SlashCommand | null;
  key: number;
}

function CommandRow({ c, actions }: { c: SlashCommand; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <code className="font-mono text-body text-fg">/{c.name}</code>
          {c.argumentHint && (
            <span className="font-mono text-caption font-normal text-fg-subtle">
              {trServer(c.argumentHint)}
            </span>
          )}
          {c.scope === 'builtin' ? (
            <Badge>{KIND_LABEL[c.kind]}</Badge>
          ) : (
            <ScopeBadge scope={c.scope} />
          )}
        </div>
        <p className="mt-0.5 text-small text-fg-muted">{trServer(c.description)}</p>
        {c.template && (
          <p className="mt-1 line-clamp-2 rounded-xs bg-subtle px-2 py-1 font-mono text-caption font-normal whitespace-pre-line text-fg-subtle">
            {c.template}
          </p>
        )}
      </div>
      {actions}
    </div>
  );
}

/** 设置 → 指令：内置斜杠指令（只读）+ 自定义指令（模板）。 */
export function CommandsSection({ pid }: { pid: string }) {
  const commands = useSlashCommands(pid);
  const perm = useHarnessPerm(pid);
  const remove = useDeleteCommand(pid);
  const [editor, setEditor] = useState<EditorState>({ open: false, command: null, key: 0 });
  const [deleting, setDeleting] = useState<SlashCommand | null>(null);
  const canCreate = perm.scopes.length > 0;

  const openEditor = (command: SlashCommand | null) =>
    setEditor((s) => ({ open: true, command, key: s.key + 1 }));

  const newButton = canCreate ? (
    <Button
      variant="primary"
      size="sm"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => openEditor(null)}
    >
      {tr('新建指令')}
    </Button>
  ) : (
    <ReadOnlyNote>{tr('访客不能新建指令')}</ReadOnlyNote>
  );

  let body: ReactNode;
  if (commands.isPending) body = <SectionSkeleton rows={3} />;
  else if (commands.isError)
    body = <ErrorCard error={commands.error} onRetry={() => void commands.refetch()} />;
  else {
    const builtins = commands.data.filter((c) => c.scope === 'builtin');
    const customs = commands.data.filter((c) => c.scope !== 'builtin');
    body = (
      <>
        <section aria-label={tr('自定义指令')} className="flex flex-col gap-2">
          <h3 className="px-1 text-caption text-fg-subtle">
            {tr('自定义 · {count}', { count: customs.length })}
          </h3>
          {customs.length === 0 ? (
            <EmptyState
              framed
              icon={SquareSlash}
              title={tr('还没有自定义指令')}
              description={tr(
                '把常发的长指令存成模板，例如 /weekly 起草周报、/check 跑实验前检查。',
              )}
              action={canCreate ? newButton : undefined}
            />
          ) : (
            <Card padding="none" className="divide-y divide-line">
              {customs.map((c) => (
                <CommandRow
                  key={c.id}
                  c={c}
                  actions={
                    perm.canEdit(c) ? (
                      <Menu
                        align="end"
                        label={tr('/{name} 的操作', { name: c.name })}
                        trigger={
                          <IconButton label={tr('更多操作')} size="sm">
                            <MoreHorizontal strokeWidth={1.75} aria-hidden />
                          </IconButton>
                        }
                      >
                        <MenuItem
                          icon={<Pencil strokeWidth={1.75} aria-hidden />}
                          onSelect={() => openEditor(c)}
                        >
                          {tr('编辑')}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                          onSelect={() => {
                            remove.reset();
                            setDeleting(c);
                          }}
                        >
                          {tr('删除')}
                        </MenuItem>
                      </Menu>
                    ) : undefined
                  }
                />
              ))}
            </Card>
          )}
        </section>
        <section aria-label={tr('内置指令')} className="flex flex-col gap-2">
          <h3 className="px-1 text-caption text-fg-subtle">
            {tr('内置 · {count}', { count: builtins.length })}
          </h3>
          <Card padding="none" className="divide-y divide-line">
            {builtins.map((c) => (
              <CommandRow key={c.id} c={c} />
            ))}
          </Card>
        </section>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('斜杠指令')}
        description={tr('输入 / 调用指令。内置指令只读，自定义模板可编辑。')}
        actions={newButton}
      />
      {body}

      {canCreate && (
        <CommandDialog
          key={editor.key}
          pid={pid}
          command={editor.command}
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
        title={tr('删除指令 /{value}？', { value: deleting?.name ?? '' })}
        description={tr('已经发出的消息不受影响。')}
        confirmLabel={tr('删除指令')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success(tr('已删除 /{name}', { name: target.name }));
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}
