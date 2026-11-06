import { useMemo, useState, type FormEvent } from 'react';
import type { DocumentMeta } from '@srh/shared';
import { Button, Dialog, Input, Select, toast } from '@/components/ui';
import { DOC_KIND_META } from '../kinds';
import { descendantIds } from './doc-tree';
import { useUpdateDoc } from './use-docs';
import { tr } from '@/lib/i18n';

/** 重命名（PATCH title）。父组件用 key={doc.id} 重新挂载以重置输入。 */
export function RenameDocDialog({
  pid,
  doc,
  onClose,
}: {
  pid: string;
  doc: DocumentMeta | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(doc?.title ?? '');
  const update = useUpdateDoc(pid);
  const trimmed = title.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!doc || !trimmed) return;
    if (trimmed === doc.title) {
      onClose();
      return;
    }
    update.mutate(
      { id: doc.id, patch: { title: trimmed } },
      {
        onSuccess: () => onClose(),
        onError: (err) => toast.error(tr('重命名失败'), err.message),
      },
    );
  };

  return (
    <Dialog
      open={doc !== null}
      onOpenChange={(o) => !o && onClose()}
      title={tr('重命名')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-doc-form"
            loading={update.isPending}
            disabled={!trimmed}
          >
            {tr('保存')}
          </Button>
        </>
      }
    >
      <form id="rename-doc-form" onSubmit={submit}>
        <label htmlFor="rename-doc-title" className="mb-1.5 block text-small text-fg-muted">
          {tr('标题')}
        </label>
        <Input
          id="rename-doc-title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          error={trimmed ? undefined : tr('标题不能为空')}
          data-autofocus
        />
      </form>
    </Dialog>
  );
}

const ROOT = '__root__';

/** 移动到…（PATCH parentId）。不能移到自己或自己的子孙下面。 */
export function MoveDocDialog({
  pid,
  doc,
  docs,
  onClose,
}: {
  pid: string;
  doc: DocumentMeta | null;
  docs: DocumentMeta[];
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string>(doc?.parentId ?? ROOT);
  const update = useUpdateDoc(pid);

  const options = useMemo(() => {
    if (!doc) return [];
    const banned = descendantIds(docs, doc.id);
    return [
      { value: ROOT, label: tr('顶层（不放在任何文档下）') },
      ...docs
        .filter((d) => !banned.has(d.id))
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
        .map((d) => ({
          value: d.id,
          label: `${DOC_KIND_META[d.kind].label} · ${d.title || tr('未命名')}`,
        })),
    ];
  }, [doc, docs]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!doc) return;
    const parentId = target === ROOT ? null : target;
    if (parentId === doc.parentId) {
      onClose();
      return;
    }
    update.mutate(
      { id: doc.id, patch: { parentId } },
      {
        onSuccess: () => {
          toast.success(parentId ? tr('已移动') : tr('已移到顶层'));
          onClose();
        },
        onError: (err) => toast.error(tr('移动失败'), err.message),
      },
    );
  };

  return (
    <Dialog
      open={doc !== null}
      onOpenChange={(o) => !o && onClose()}
      title={tr('移动到…')}
      description={
        doc
          ? tr('把「{value}」放到另一份文档下面，作为它的子文档。', {
              value: doc.title || tr('未命名'),
            })
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button variant="primary" type="submit" form="move-doc-form" loading={update.isPending}>
            {tr('移动')}
          </Button>
        </>
      }
    >
      <form id="move-doc-form" onSubmit={submit}>
        <label htmlFor="move-doc-parent" className="mb-1.5 block text-small text-fg-muted">
          {tr('父文档')}
        </label>
        <Select
          id="move-doc-parent"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          options={options}
        />
      </form>
    </Dialog>
  );
}
