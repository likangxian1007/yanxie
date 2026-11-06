import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { PaperAnnotation } from '@srh/shared';
import { Button, Textarea } from '@/components/ui';
import { useCollabDoc, type CollabDoc } from '@/features/docs/collab/useCollabDoc';
import { useYTextBinding } from '@/features/docs/editors/shared/bindYText';
import { annotationApi } from '../annotations-api';
import { isPersonalLibrary, type LibraryScope } from '../lib/scope';
import { tr } from '@/lib/i18n';

export function AnnotationBodyEditor(props: {
  annotation: PaperAnnotation;
  scope: LibraryScope;
  writable: boolean;
}) {
  const collab = useCollabDoc(props.annotation.id);
  return collab ? (
    <ConnectedEditor {...props} collab={collab} />
  ) : (
    <p role="status">{tr('正在连接批注…')}</p>
  );
}
function ConnectedEditor({
  annotation,
  scope,
  writable,
  collab,
}: {
  annotation: PaperAnnotation;
  scope: LibraryScope;
  writable: boolean;
  collab: CollabDoc;
}) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const ytext = collab.doc.getText('body');
  const undo = useRef<Y.UndoManager | null>(null);
  const stopped = Boolean(annotation.deletedAt) || collab.status === 'denied';
  useEffect(() => {
    const manager = new Y.UndoManager(ytext, { trackedOrigins: new Set(['library-annotation']) });
    undo.current = manager;
    return () => {
      manager.destroy();
      undo.current = null;
    };
  }, [ytext]);
  const ref = useYTextBinding<HTMLTextAreaElement>(ytext, {
    origin: 'library-annotation',
    onUndo: () => undo.current?.undo(),
    onRedo: () => undo.current?.redo(),
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false,
      generation = 0;
    const flush = () => {
      revision.current++;
      const current = ++generation;
      setSaved(false);
      clearTimeout(timer);
      if (stopped || !writable || collab.status !== 'connected' || collab.unsynced) return;
      timer = setTimeout(() => {
        void annotationApi
          .flush(scope, annotation.paperId, annotation.id)
          .then(() => {
            if (!disposed && generation === current) {
              setSaved(true);
              setError('');
            }
          })
          .catch((e: Error) => {
            if (!disposed && generation === current) setError(e.message);
          });
      }, 700);
    };
    flush();
    ytext.observe(flush);
    return () => {
      disposed = true;
      clearTimeout(timer);
      ytext.unobserve(flush);
    };
  }, [
    collab.status,
    collab.unsynced,
    scope,
    annotation.paperId,
    annotation.id,
    stopped,
    writable,
    ytext,
  ]);
  return (
    <div className="space-y-2">
      <p role="status" className="text-caption text-fg-muted">
        {stopped
          ? tr('标注已删除或权限失效，编辑已停止；可复制本机草稿自行保留。')
          : !writable
            ? tr('论文已归档，批注只读。')
            : collab.status !== 'connected'
              ? tr('已离线或正在连接，本机修改将在连接恢复后同步。')
              : saved
                ? tr('批注已保存到服务器')
                : tr('批注正在同步并保存…')}
      </p>
      {!isPersonalLibrary(scope) && (
        <p className="text-caption text-fg-muted">
          {tr('正在查看：')}
          {collab.status === 'connected'
            ? collab.peers.map((p) => p.user.name).join(tr('、')) || tr('仅自己')
            : tr('连接恢复后显示')}
        </p>
      )}
      {collab.ready || collab.synced ? (
        <Textarea
          ref={ref}
          aria-label={tr('批注正文')}
          rows={4}
          className="bg-surface text-small"
          maxLength={100000}
          readOnly={!writable || stopped}
        />
      ) : (
        <pre className="text-small whitespace-pre-wrap wrap-anywhere">{annotation.body}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        {!stopped && writable && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={collab.status !== 'connected' || Boolean(collab.unsynced)}
            onClick={async () => {
              const savingRevision = revision.current;
              setBusy(true);
              setError('');
              try {
                const stored = await annotationApi.flush(scope, annotation.paperId, annotation.id);
                setSaved(savingRevision === revision.current && stored.body === ytext.toString());
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr('立即保存批注')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                collab.ready || collab.synced ? ytext.toString() : annotation.body,
              );
              setError('');
            } catch {
              setError(tr('复制失败，请手动选择正文复制。'));
            }
          }}
        >
          {tr('复制批注正文')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
