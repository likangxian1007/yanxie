import { Link } from 'react-router';
import { ApiRequestError } from '@/lib/api';
import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import 'katex/dist/katex.min.css';
import '../notebook.css';
import { Button, EmptyState, Skeleton, toast } from '@/components/ui';
import { useCollabDoc } from '@/features/docs/collab/useCollabDoc';
import { useNotebook } from '../api';
import { NotebookView } from './NotebookView';
import { tr } from '@/lib/i18n';
export function NotebookById({
  pid,
  notebookId,
  writable,
}: {
  pid: string;
  notebookId: string;
  writable: boolean;
}) {
  const meta = useNotebook(pid, notebookId);
  const collab = useCollabDoc(notebookId);
  const kernelAvailable = meta.data ? meta.data.kernel.status !== 'unavailable' : true;

  // 远端把内核状态写进 Y.Doc；这里只在首次加载时用 REST 判断服务器有没有配内核
  const warned = useRef(false);
  useEffect(() => {
    if (meta.data && !kernelAvailable && !warned.current) {
      warned.current = true;
      toast({
        tone: 'warning',
        title: tr('服务器还没配置 Python 内核'),
        description: tr('可以编辑和查看，但暂时不能运行。'),
      });
    }
  }, [meta.data, kernelAvailable]);

  if (meta.isError)
    return (
      <EmptyState
        framed
        icon={AlertTriangle}
        title={
          meta.error instanceof ApiRequestError && meta.error.status === 404
            ? tr('内容已移除')
            : tr('Notebook 没有加载出来')
        }
        description={meta.error.message}
        action={
          meta.error instanceof ApiRequestError && meta.error.status === 404 ? (
            <Link className="text-accent underline" to={`/p/${pid}/research`}>
              {tr('打开研究空间')}
            </Link>
          ) : (
            <Button onClick={() => void meta.refetch()}>{tr('重试')}</Button>
          )
        }
      />
    );
  if (!collab || !collab.ready) {
    if (collab?.status === 'denied') {
      return (
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('没有权限打开这个 Notebook')}
          description={tr('请确认你还是这个项目的成员。')}
        />
      );
    }
    return <NotebookSkeleton />;
  }
  return (
    <NotebookView
      pid={pid}
      notebookId={notebookId}
      doc={collab.doc}
      provider={collab.provider}
      peers={collab.peers}
      writable={writable}
      kernelAvailable={kernelAvailable}
      title={meta.data?.title ?? 'Notebook'}
    />
  );
}

function NotebookSkeleton() {
  return (
    <div role="status" aria-label={tr('正在打开 Notebook')} className="flex flex-col gap-3">
      <Skeleton className="h-8 w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-5 w-14" />
          <Skeleton className="h-16 flex-1" />
        </div>
      ))}
    </div>
  );
}
