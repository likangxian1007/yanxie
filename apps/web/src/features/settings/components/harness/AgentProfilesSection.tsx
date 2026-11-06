import { useState, type ReactNode } from 'react';
import { Copy, Eye, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { EFFORT_LABEL, type AgentProfile, type HarnessScope } from '@srh/shared';
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
import { ProfileGlyph } from '@/features/harness';
import { useAgentProfiles, useCreateProfile, useDeleteProfile } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from '../parts';
import { SCOPE_LABEL, useHarnessPerm } from './perm';
import { ProfileDialog } from './ProfileDialog';
import { tr, trServer } from '@/lib/i18n';

const SCOPE_ORDER: HarnessScope[] = ['personal', 'project', 'builtin'];

interface EditorState {
  open: boolean;
  profile: AgentProfile | null;
  key: number;
}

/** 设置 → Profile：科研角色。内置只读，可复制后修改。 */
export function AgentProfilesSection({ pid }: { pid: string }) {
  const profiles = useAgentProfiles(pid);
  const perm = useHarnessPerm(pid);
  const create = useCreateProfile(pid);
  const remove = useDeleteProfile(pid);
  const [editor, setEditor] = useState<EditorState>({ open: false, profile: null, key: 0 });
  const [deleting, setDeleting] = useState<AgentProfile | null>(null);
  const canCreate = perm.scopes.length > 0;
  const copyScope = perm.manage ? 'project' : 'personal';
  const copyLabel = perm.manage ? tr('复制到项目') : tr('复制为个人');

  const openEditor = (profile: AgentProfile | null) =>
    setEditor((s) => ({ open: true, profile, key: s.key + 1 }));

  const copy = (p: AgentProfile) =>
    create.mutate(
      {
        scope: copyScope,
        slug: p.slug,
        name: p.name,
        description: p.description,
        icon: p.icon,
        prompt: p.prompt,
        skills: p.skills,
        starters: p.starters,
        effort: p.effort,
      },
      {
        onSuccess: (n) => {
          toast.success(
            tr('已复制「{name}」', { name: trServer(n.name) }),
            tr('同名的会覆盖内置的，可以接着编辑。'),
          );
          openEditor(n);
        },
        onError: (e) => toast.error(tr('没能复制'), errorMessage(e)),
      },
    );

  const newButton = canCreate ? (
    <Button
      variant="primary"
      size="sm"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => openEditor(null)}
    >
      {tr('新建 profile')}
    </Button>
  ) : (
    <ReadOnlyNote>{tr('访客不能新建 profile')}</ReadOnlyNote>
  );

  let body: ReactNode;
  if (profiles.isPending) body = <SectionSkeleton rows={3} />;
  else if (profiles.isError)
    body = <ErrorCard error={profiles.error} onRetry={() => void profiles.refetch()} />;
  else if (profiles.data.length === 0)
    body = (
      <EmptyState
        framed
        icon={Sparkles}
        title={tr('还没有 profile')}
        description={tr(
          '给 agent 设定科研角色：审稿人、实验设计、论文写作……成员在新会话或用 /profile 选用。',
        )}
        action={canCreate ? newButton : undefined}
      />
    );
  else
    body = SCOPE_ORDER.map((scope) => {
      const list = profiles.data.filter((p) => p.scope === scope);
      if (list.length === 0) return null;
      return (
        <section
          key={scope}
          aria-label={`${SCOPE_LABEL[scope]} profile`}
          className="flex flex-col gap-2"
        >
          <h3 className="px-1 text-caption text-fg-subtle">
            {SCOPE_LABEL[scope]} · {list.length}
          </h3>
          <Card padding="none" className="divide-y divide-line">
            {list.map((p) => {
              const editable = perm.canEdit(p);
              return (
                <div key={p.id} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-agent-soft text-agent">
                    <ProfileGlyph icon={p.icon} size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-body font-medium text-fg">
                        {trServer(p.name)}
                      </span>
                      <code className="font-mono text-caption text-fg-subtle">{p.slug}</code>
                      {p.effort && <Badge>{EFFORT_LABEL[p.effort]}</Badge>}
                      {p.skills.length > 0 && (
                        <Badge>{tr('{count} 个 Skill', { count: p.skills.length })}</Badge>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-0.5 line-clamp-2 text-small text-fg-muted">
                        {trServer(p.description)}
                      </p>
                    )}
                  </div>
                  <Menu
                    align="end"
                    label={tr('{name} 的操作', { name: trServer(p.name) })}
                    trigger={
                      <IconButton label={tr('更多操作')} size="sm">
                        <MoreHorizontal strokeWidth={1.75} aria-hidden />
                      </IconButton>
                    }
                  >
                    <MenuItem
                      icon={
                        editable ? (
                          <Pencil strokeWidth={1.75} aria-hidden />
                        ) : (
                          <Eye strokeWidth={1.75} aria-hidden />
                        )
                      }
                      onSelect={() => openEditor(p)}
                    >
                      {editable ? tr('编辑') : tr('查看')}
                    </MenuItem>
                    {p.scope === 'builtin' && canCreate && (
                      <MenuItem
                        icon={<Copy strokeWidth={1.75} aria-hidden />}
                        onSelect={() => copy(p)}
                      >
                        {copyLabel}
                      </MenuItem>
                    )}
                    {editable && (
                      <>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                          onSelect={() => {
                            remove.reset();
                            setDeleting(p);
                          }}
                        >
                          {tr('删除')}
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                </div>
              );
            })}
          </Card>
        </section>
      );
    });

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={tr('科研 profile')}
        description={tr(
          'agent 的科研角色。成员在新会话首屏或用 /profile 为会话选用；同名时个人的优先于项目的，项目的优先于内置的。',
        )}
        actions={newButton}
      />
      {body}

      <ProfileDialog
        key={editor.key}
        pid={pid}
        profile={editor.profile}
        open={editor.open}
        onOpenChange={(v) => {
          if (!v) setEditor((s) => ({ ...s, open: false }));
        }}
        {...(canCreate
          ? {
              onCopy: (p: AgentProfile) => {
                setEditor((s) => ({ ...s, open: false }));
                copy(p);
              },
              copyLabel,
            }
          : {})}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        title={tr('删除 profile「{value}」？', { value: trServer(deleting?.name ?? '') })}
        description={tr('正在用它的会话会回到通用设定。')}
        confirmLabel={tr('删除 profile')}
        loading={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => {
          if (!deleting) return;
          const target = deleting;
          remove.mutate(target.id, {
            onSuccess: () => {
              toast.success(tr('已删除「{name}」', { name: trServer(target.name) }));
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}
