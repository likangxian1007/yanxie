import { useEffect } from 'react';
import { Braces } from 'lucide-react';
import { Button, EmptyState, Sheet, Skeleton } from '@/components/ui';
import { useNotebookVariables } from '../api';
import { tr } from '@/lib/i18n';

function formatSize(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 变量查看器（类似 JupyterLab Variable Inspector）：每次执行完自动刷新 */
export function VariablesSheet({
  pid,
  notebookId,
  open,
  onOpenChange,
  executionCount,
}: {
  pid: string;
  notebookId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  executionCount: number;
}) {
  const q = useNotebookVariables(pid, notebookId, open);
  const { refetch } = q;
  useEffect(() => {
    if (open) void refetch();
  }, [open, executionCount, refetch]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={tr('变量')} width="min(32rem, 100vw)">
      {q.isPending ? (
        <div className="flex flex-col gap-2 p-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState
          icon={Braces}
          title={tr('变量没有读出来')}
          description={q.error.message}
          action={
            <Button size="sm" onClick={() => void refetch()}>
              {tr('重试')}
            </Button>
          }
        />
      ) : !q.data.length ? (
        <EmptyState
          icon={Braces}
          title={tr('还没有变量')}
          description={tr('运行单元格后，这里会列出内核里的变量、类型和形状。')}
        />
      ) : (
        <table className="w-full table-fixed text-body-sm">
          <thead className="text-left text-caption text-fg-subtle">
            <tr>
              <th className="w-[28%] pb-2 font-normal">{tr('名称')}</th>
              <th className="w-[20%] pb-2 font-normal">{tr('类型')}</th>
              <th className="w-[16%] pb-2 font-normal">{tr('形状')}</th>
              <th className="pb-2 font-normal">{tr('值')}</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((v) => (
              <tr key={v.name} className="border-t border-line align-top">
                <td className="truncate py-1.5 pr-2 font-mono text-fg" title={v.name}>
                  {v.name}
                </td>
                <td className="truncate py-1.5 pr-2 text-fg-muted" title={v.type}>
                  {v.type}
                </td>
                <td className="truncate py-1.5 pr-2 font-mono text-fg-muted">
                  {v.shape ?? formatSize(v.size)}
                </td>
                <td className="py-1.5 font-mono text-[12px] break-all text-fg-muted">
                  {v.summary}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Sheet>
  );
}
