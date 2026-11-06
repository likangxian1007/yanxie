import { useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  Forward,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Trash2,
} from 'lucide-react';
import type { Thread } from '@srh/shared';
import {
  Button,
  ContextMenu,
  Dialog,
  MenuItem,
  MenuSeparator,
  toast,
  useContextMenu,
} from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { usePinStore, usePins } from '@/lib/pins';
import { absoluteUrl } from '@/lib/base-path';
import { canWrite, useMyRole, useThreads } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { ForwardDialog } from '@/features/workspace/components/ForwardDialog';
import { LabelDialog, RenameDialog } from './ThreadActionDialogs';
import { useDeleteThread, useUpdateThread } from '../thread-api';
import { collectLabels } from '../thread-utils';
import { tr } from '@/lib/i18n';

type DialogKind = 'rename' | 'label' | 'forward' | 'delete' | null;

/** 线程 / 会话的链接（个人会话在“我的工作区”下面）。 */
export function threadHref(projectId: string, thread: Pick<Thread, 'id' | 'kind'>): string {
  return projectPath(
    projectId,
    `${thread.kind === 'personal' ? 'workspace' : 'threads'}/${thread.id}`,
  );
}

/** 项目里已经用过的标签（项目线程 + 我的个人会话），给“加标签”做候选。 */
export function useKnownLabels(projectId: string): string[] {
  const project = useThreads(projectId);
  const personal = useThreads(projectId, { kind: 'personal' });
  return useMemo(
    () => collectLabels([...(project.data ?? []), ...(personal.data ?? [])]),
    [project.data, personal.data],
  );
}

/**
 * 一个线程的全部操作：菜单项 + 菜单项打开的对话框。
 * 「⋯」按钮和右键菜单都用它，两处的动作和顺序完全一致。
 */
export function useThreadActions(thread: Thread, projectId: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const role = useMyRole(projectId);
  const me = useMeUser();
  const writable = canWrite(role);
  const mine = thread.kind === 'personal' && thread.ownerUserId === me?.id;
  const pinned = usePins(projectId).includes(thread.id);
  const togglePin = usePinStore((s) => s.toggle);
  const update = useUpdateThread(projectId);
  const remove = useDeleteThread(projectId);

  const patch = (p: { title?: string; label?: string | null; resolved?: boolean }, done: string) =>
    update.mutate(
      { id: thread.id, patch: p },
      {
        onSuccess: () => {
          setDialog(null);
          if (p.resolved !== undefined) {
            toast({
              title: done,
              tone: 'success',
              action: {
                label: tr('撤销'),
                onClick: () => update.mutate({ id: thread.id, patch: { resolved: !p.resolved } }),
              },
            });
          } else {
            toast({ title: done, tone: 'success' });
          }
        },
        onError: (e) => toast.error(tr('没改成'), e.message),
      },
    );

  const copyLink = () => {
    const url = absoluteUrl(threadHref(projectId, thread));
    void navigator.clipboard?.writeText(url).then(
      () => toast({ title: tr('已复制链接') }),
      () => toast.error(tr('复制失败'), tr('浏览器没有允许访问剪贴板，可以从地址栏复制。')),
    );
  };

  const doDelete = () =>
    remove.mutate(thread.id, {
      onSuccess: () => {
        setDialog(null);
        toast({ title: tr('已删除会话') });
        if (location.pathname.includes(thread.id)) {
          void navigate(projectPath(projectId, 'workspace'), { replace: true });
        }
      },
      onError: (e) => toast.error(tr('没能删除'), e.message),
    });

  const items = (
    <>
      {writable && (
        <MenuItem icon={<Pencil strokeWidth={1.75} />} onSelect={() => setDialog('rename')}>
          {tr('重命名')}
        </MenuItem>
      )}
      {writable && (
        <MenuItem icon={<Tag strokeWidth={1.75} />} onSelect={() => setDialog('label')}>
          {thread.label ? tr('修改标签') : tr('加标签')}
        </MenuItem>
      )}
      <MenuItem
        icon={pinned ? <PinOff strokeWidth={1.75} /> : <Pin strokeWidth={1.75} />}
        onSelect={() => togglePin(projectId, thread.id)}
      >
        {pinned ? tr('取消置顶') : tr('置顶')}
      </MenuItem>
      <MenuItem icon={<Link2 strokeWidth={1.75} />} onSelect={copyLink}>
        {tr('复制链接')}
      </MenuItem>
      {mine && writable && (
        <MenuItem icon={<Forward strokeWidth={1.75} />} onSelect={() => setDialog('forward')}>
          {thread.forwardedAt ? tr('再次转给协调者') : tr('转给协调者')}
        </MenuItem>
      )}
      {writable && (
        <>
          <MenuSeparator />
          {thread.resolved ? (
            <MenuItem
              icon={<ArchiveRestore strokeWidth={1.75} />}
              onSelect={() => patch({ resolved: false }, tr('已重新打开'))}
            >
              {tr('取消归档')}
            </MenuItem>
          ) : (
            <MenuItem
              icon={<Archive strokeWidth={1.75} />}
              description={tr('标为已解决，收进「已解决」')}
              onSelect={() => patch({ resolved: true }, tr('已归档'))}
            >
              {tr('归档')}
            </MenuItem>
          )}
          {mine && (
            <MenuItem
              danger
              icon={<Trash2 strokeWidth={1.75} />}
              onSelect={() => setDialog('delete')}
            >
              {tr('删除')}
            </MenuItem>
          )}
        </>
      )}
    </>
  );

  const dialogs = (
    <>
      {dialog === 'rename' && (
        <RenameDialog
          initial={thread.title}
          saving={update.isPending}
          onClose={() => setDialog(null)}
          onSave={(title) => patch({ title }, tr('已重命名'))}
        />
      )}
      {dialog === 'label' && (
        <LabelDialog
          projectId={projectId}
          initial={thread.label}
          saving={update.isPending}
          onClose={() => setDialog(null)}
          onSave={(label) =>
            patch({ label }, label ? tr('标签改为「{label}」', { label }) : tr('已移除标签'))
          }
        />
      )}
      {dialog === 'forward' && (
        <ForwardDialog
          projectId={projectId}
          thread={thread}
          open
          onOpenChange={(v) => !v && setDialog(null)}
        />
      )}
      <Dialog
        open={dialog === 'delete'}
        onOpenChange={(v) => {
          if (!v && !remove.isPending) setDialog(null);
        }}
        size="sm"
        title={tr('删除这个会话？')}
        description={tr(
          '「{title}」里的消息和产出会一起删除，删除后无法恢复。只想先收起来的话，可以用「归档」。',
          { title: thread.title },
        )}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={remove.isPending}>
              {tr('取消')}
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={doDelete}>
              {tr('删除')}
            </Button>
          </>
        }
      />
    </>
  );

  return { items, dialogs };
}

/**
 * 列表项的右键菜单：把 handlers 挂到列表项上，menu 渲染一次。
 * Shift + 右键保留浏览器原生菜单；菜单键 / Shift+F10 用键盘打开。
 */
export function useThreadContextMenu(
  thread: Thread,
  projectId: string,
): {
  handlers: {
    onContextMenu: ReturnType<typeof useContextMenu>['onContextMenu'];
    onKeyDown: ReturnType<typeof useContextMenu>['onKeyDown'];
  };
  menu: ReactNode;
} {
  const ctx = useContextMenu();
  const { items, dialogs } = useThreadActions(thread, projectId);
  return {
    handlers: { onContextMenu: ctx.onContextMenu, onKeyDown: ctx.onKeyDown },
    menu: (
      <>
        <ContextMenu
          at={ctx.at}
          onClose={ctx.close}
          label={tr('「{title}」的操作', { title: thread.title })}
        >
          {items}
        </ContextMenu>
        {dialogs}
      </>
    ),
  };
}
