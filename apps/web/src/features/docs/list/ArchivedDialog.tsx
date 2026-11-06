import { useState } from 'react';
import { Archive, ArchiveRestore } from 'lucide-react';
import type { DocumentMeta } from '@srh/shared';
import { Button, Dialog, EmptyState, RelativeTime, Skeleton, toast } from '@/components/ui';
import { DocKindIcon } from '../kinds';
import { useArchivedDocs, useUpdateDoc } from './use-docs';
import { tr } from '@/lib/i18n';

/** 已归档文档（GET P/docs?archived=true），可恢复 */
export function ArchivedDialog({
  pid,
  open,
  onOpenChange,
  canEdit,
}: {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const query = useArchivedDocs(pid, open);
  const update = useUpdateDoc(pid);
  const [restoring, setRestoring] = useState<string | null>(null);

  const restore = (doc: DocumentMeta) => {
    setRestoring(doc.id);
    update.mutate(
      { id: doc.id, patch: { archived: false } },
      {
        onSuccess: () =>
          toast.success(
            tr('已恢复'),
            tr('「{value}」回到了文档列表', { value: doc.title || tr('未命名') }),
          ),
        onError: (err) => toast.error(tr('恢复失败'), err.message),
        onSettled: () => setRestoring(null),
      },
    );
  };

  const docs = (query.data ?? [])
    .slice()
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={tr('已归档')}
      description={tr('归档的文档不会出现在列表和搜索里，内容都还在，随时可以恢复。')}
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3 py-1" aria-busy="true" aria-label={tr('正在加载')}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-7 rounded-sm" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3 rounded-lg bg-danger-soft p-4 text-small text-danger">
          <p>{tr('没能加载已归档的文档：{message}', { message: query.error.message })}</p>
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            {tr('重试')}
          </Button>
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={tr('没有已归档的文档')}
          description={tr('在文档的“更多”菜单里选择归档，它会出现在这里。')}
          className="py-8"
        />
      ) : (
        <ul className="-mx-2 flex flex-col">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-subtle"
            >
              <DocKindIcon kind={doc.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-fg">
                  {doc.title || tr('未命名')}
                </span>
                <span className="block truncate text-caption text-fg-subtle">
                  {tr('归档于 ')}
                  <RelativeTime iso={doc.archivedAt ?? doc.updatedAt} />
                </span>
              </span>
              {canEdit && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<ArchiveRestore strokeWidth={1.75} aria-hidden />}
                  loading={restoring === doc.id}
                  disabled={restoring !== null && restoring !== doc.id}
                  onClick={() => restore(doc)}
                >
                  {tr('恢复')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
