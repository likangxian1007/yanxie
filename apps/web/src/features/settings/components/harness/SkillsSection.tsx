import { useState, type ReactNode } from 'react';
import { BookOpen, Copy, Eye, FileUp, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { HarnessScope, Skill } from '@srh/shared';
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
} from '@/components/ui';
import { useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from '@/lib/harness';
import { errorMessage } from '../../lib';
import { ConfirmDialog, ErrorCard, ReadOnlyNote, SectionSkeleton, SettingsCard } from '../parts';
import { SCOPE_LABEL, useHarnessPerm } from './perm';
import { SkillDialog, SkillImportDialog } from './SkillDialog';
import { tr, trServer } from '@/lib/i18n';

const SCOPE_ORDER: HarnessScope[] = ['personal', 'project', 'builtin'];

interface EditorState {
  open: boolean;
  skill: Skill | null;
  key: number;
}

/** 设置 → Skill：按作用域分组；内置只读，可复制成项目 / 个人的同名 Skill 来覆盖。 */
export function SkillsSection({ pid }: { pid: string }) {
  const skills = useSkills(pid);
  const perm = useHarnessPerm(pid);
  const create = useCreateSkill(pid);
  const update = useUpdateSkill(pid);
  const remove = useDeleteSkill(pid);
  const [editor, setEditor] = useState<EditorState>({ open: false, skill: null, key: 0 });
  const [importOpen, setImportOpen] = useState(false);
  const [importKey, setImportKey] = useState(0);
  const [deleting, setDeleting] = useState<Skill | null>(null);

  const copyScope = perm.manage ? 'project' : 'personal';
  const copyLabel = perm.manage ? tr('复制到项目') : tr('复制为个人');
  const canCreate = perm.scopes.length > 0;

  const openEditor = (skill: Skill | null) =>
    setEditor((s) => ({ open: true, skill, key: s.key + 1 }));

  const copy = (s: Skill) =>
    create.mutate(
      {
        scope: copyScope,
        slug: s.slug,
        name: s.name,
        description: s.description,
        body: s.body,
        enabled: true,
        userInvocable: s.userInvocable,
        modelInvocable: s.modelInvocable,
      },
      {
        onSuccess: (n) => {
          toast.success(
            tr('已复制「{name}」', { name: trServer(n.name) }),
            tr('{value}里的同名 Skill 会覆盖内置的，可以接着编辑。', {
              value: SCOPE_LABEL[n.scope],
            }),
          );
          openEditor(n);
        },
        onError: (e) => toast.error(tr('没能复制'), errorMessage(e)),
      },
    );

  const actions = canCreate ? (
    <>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<FileUp strokeWidth={1.75} aria-hidden />}
        onClick={() => {
          setImportKey((k) => k + 1);
          setImportOpen(true);
        }}
      >
        {tr('导入 SKILL.md')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Plus strokeWidth={2} aria-hidden />}
        onClick={() => openEditor(null)}
      >
        {tr('新建 Skill')}
      </Button>
    </>
  ) : (
    <ReadOnlyNote>{tr('访客不能新建 Skill')}</ReadOnlyNote>
  );

  let body: ReactNode;
  if (skills.isPending) body = <SectionSkeleton rows={3} />;
  else if (skills.isError)
    body = <ErrorCard error={skills.error} onRetry={() => void skills.refetch()} />;
  else if (skills.data.length === 0)
    body = (
      <EmptyState
        framed
        icon={BookOpen}
        title={tr('还没有 Skill')}
        description={tr('把常做的事写成 Skill：读论文的步骤、写周报的格式、跑实验前的检查清单。')}
      />
    );
  else {
    const overridden = new Set(skills.data.filter((s) => s.scope !== 'builtin').map((s) => s.slug));
    body = SCOPE_ORDER.map((scope) => {
      const list = skills.data.filter((s) => s.scope === scope);
      if (list.length === 0) return null;
      return (
        <section
          key={scope}
          aria-label={`${SCOPE_LABEL[scope]} Skill`}
          className="flex flex-col gap-2"
        >
          <h3 className="px-1 text-caption text-fg-subtle">
            {SCOPE_LABEL[scope]} · {list.length}
          </h3>
          <Card padding="none" className="divide-y divide-line">
            {list.map((s) => {
              const editable = perm.canEdit(s);
              return (
                <div key={s.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-body font-medium text-fg">
                        {trServer(s.name)}
                      </span>
                      <code className="font-mono text-caption text-fg-subtle">/{s.slug}</code>
                      {!s.userInvocable && <Badge>{tr('仅 agent 自选')}</Badge>}
                      {!s.modelInvocable && <Badge>{tr('仅成员点名')}</Badge>}
                      {s.scope === 'builtin' && overridden.has(s.slug) && (
                        <Badge tone="warning">{tr('已被覆盖')}</Badge>
                      )}
                      {s.attachments.length > 0 && (
                        <Badge>{tr('{count} 个附件', { count: s.attachments.length })}</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-small text-fg-muted">
                      {trServer(s.description)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {editable ? (
                      <Switch
                        label={
                          s.enabled
                            ? tr('停用「{name}」', { name: trServer(s.name) })
                            : tr('启用「{name}」', { name: trServer(s.name) })
                        }
                        checked={s.enabled}
                        disabled={update.isPending && update.variables?.id === s.id}
                        onCheckedChange={(enabled) =>
                          update.mutate(
                            { id: s.id, patch: { enabled } },
                            { onError: (e) => toast.error(tr('没能切换'), errorMessage(e)) },
                          )
                        }
                        className="mr-1"
                      />
                    ) : (
                      !s.enabled && <Badge>{tr('已停用')}</Badge>
                    )}
                    <Menu
                      align="end"
                      label={tr('{name} 的操作', { name: trServer(s.name) })}
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
                        onSelect={() => openEditor(s)}
                      >
                        {editable ? tr('编辑') : tr('查看')}
                      </MenuItem>
                      {s.scope === 'builtin' && canCreate && (
                        <MenuItem
                          icon={<Copy strokeWidth={1.75} aria-hidden />}
                          onSelect={() => copy(s)}
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
                              setDeleting(s);
                            }}
                          >
                            {tr('删除')}
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  </div>
                </div>
              );
            })}
          </Card>
        </section>
      );
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title="Skill"
        description={tr('同名 Skill 按个人、项目、内置的顺序优先使用。')}
        actions={actions}
      />
      {body}

      <SkillDialog
        key={editor.key}
        pid={pid}
        skill={editor.skill}
        open={editor.open}
        onOpenChange={(v) => {
          if (!v) setEditor((s) => ({ ...s, open: false }));
        }}
        {...(canCreate
          ? {
              onCopy: (s: Skill) => {
                setEditor((st) => ({ ...st, open: false }));
                copy(s);
              },
              copyLabel,
            }
          : {})}
      />
      {canCreate && (
        <SkillImportDialog
          key={`import-${importKey}`}
          pid={pid}
          open={importOpen}
          onOpenChange={setImportOpen}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        title={tr('删除 Skill「{value}」？', { value: trServer(deleting?.name ?? '') })}
        description={tr(
          '删除后 agent 和成员都不能再用它；如果有同名的内置 Skill，会恢复成内置版本。',
        )}
        confirmLabel={tr('删除 Skill')}
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
