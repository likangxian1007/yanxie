import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { PaperQaTurn, PaperQaRevision } from '@srh/shared';
import { Button, Dialog, Textarea } from '@/components/ui';
import { useCollabDoc, type CollabDoc } from '@/features/docs/collab/useCollabDoc';
import { useYTextBinding } from '@/features/docs/editors/shared/bindYText';
import { qaApi } from '../qa-api';
import type { LibraryScope } from '../lib/scope';
import { tr, trServer } from '@/lib/i18n';
export function QaTurnEditor({
  scope,
  turn,
  editable,
}: {
  scope: LibraryScope;
  turn: PaperQaTurn;
  editable: boolean;
}) {
  const collab = useCollabDoc(turn.id);
  return collab ? (
    <Editor scope={scope} turn={turn} collab={collab} editable={editable} />
  ) : (
    <p role="status">{tr('正在连接共同编辑…')}</p>
  );
}
function Editor({
  scope,
  turn,
  collab,
  editable,
}: {
  scope: LibraryScope;
  turn: PaperQaTurn;
  collab: CollabDoc;
  editable: boolean;
}) {
  const question = collab.doc.getText('question'),
    answer = collab.doc.getText('answer');
  const [saved, setSaved] = useState(false),
    [error, setError] = useState('');
  const undo = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    const manager = new Y.UndoManager([question, answer], {
      trackedOrigins: new Set(['qa-editor']),
    });
    undo.current = manager;
    return () => {
      manager.destroy();
      undo.current = null;
    };
  }, [question, answer]);
  const options = {
    origin: 'qa-editor',
    onUndo: () => undo.current?.undo(),
    onRedo: () => undo.current?.redo(),
  };
  const qref = useYTextBinding<HTMLTextAreaElement>(question, options),
    aref = useYTextBinding<HTMLTextAreaElement>(answer, options);
  useEffect(() => {
    let disposed = false,
      generation = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const current = ++generation;
      setSaved(false);
      clearTimeout(timer);
      if (collab.status !== 'connected' || collab.unsynced) return;
      timer = setTimeout(() => {
        void qaApi
          .flush(scope, turn.paperId, turn.id)
          .then(() => {
            if (!disposed && generation === current) {
              setSaved(true);
              setError('');
            }
          })
          .catch((e: Error) => {
            if (!disposed) setError(e.message);
          });
      }, 700);
    };
    flush();
    question.observe(flush);
    answer.observe(flush);
    return () => {
      disposed = true;
      clearTimeout(timer);
      question.unobserve(flush);
      answer.unobserve(flush);
    };
  }, [scope, turn.id, turn.paperId, question, answer, collab.status, collab.unsynced]);
  const denied = collab.status === 'denied';
  return (
    <div className="space-y-2 border-t border-line pt-2">
      <p role="status" className="text-caption text-fg-muted">
        {denied
          ? tr('问答已删除或权限失效，编辑已停止。')
          : collab.status !== 'connected'
            ? tr('离线或连接中，本机修改将在恢复连接后同步。')
            : saved
              ? tr('已保存到服务器')
              : tr('正在同步并保存…')}
      </p>
      <p className="text-caption text-fg-muted">
        {tr('正在查看：')}
        {collab.peers.map((p) => p.user.name).join(tr('、')) || tr('连接中')}
      </p>
      {!denied && (collab.ready || collab.synced) && (
        <>
          <label className="block text-small">
            {tr('问题正文')}
            <Textarea
              ref={qref}
              aria-label={tr('问题正文')}
              rows={2}
              maxLength={8000}
              readOnly={!editable}
            />
          </label>
          <label className="block text-small">
            {tr('回答正文')}
            <Textarea
              ref={aref}
              aria-label={tr('回答正文')}
              rows={7}
              maxLength={100000}
              readOnly={!editable}
            />
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
export function QaHistory({
  scope,
  turn,
  onClose,
}: {
  scope: LibraryScope;
  turn: PaperQaTurn;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PaperQaRevision[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [more, setMore] = useState(false);
  useEffect(() => {
    let disposed = false;
    void qaApi
      .revisions(scope, turn.paperId, turn.id)
      .then((r) => {
        if (!disposed) {
          setRows(r);
          setMore(r.length === 50);
        }
      })
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [scope, turn.id, turn.paperId]);
  return (
    <Dialog
      open
      title={tr('原始版本与修改记录')}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
    >
      <div className="space-y-3 text-small">
        <p className="text-fg-muted">
          {turn.origin === 'published'
            ? tr('原始版本是发布时选择的公开正文，不包含私人修改历史。')
            : tr('原始版本保留当时提交的问题和模型输出，之后的人工修改另存版本。')}
        </p>
        <details open>
          <summary>{tr('原始版本')}</summary>
          <pre className="whitespace-pre-wrap wrap-anywhere font-sans">
            {turn.originalQuestion}
            {'\n\n'}
            {turn.originalAnswer}
          </pre>
        </details>
        {busy && <p role="status">{tr('正在读取版本…')}</p>}
        {error && <p role="alert">{error}</p>}
        {rows.map((r) => (
          <details key={r.id}>
            <summary>
              v{r.version} · {trServer(r.actor.name)} · {new Date(r.createdAt).toLocaleString()} ·{' '}
              {r.kind === 'edited'
                ? tr('人工修改')
                : r.kind === 'published'
                  ? tr('发布')
                  : tr('生成')}
            </summary>
            <pre className="whitespace-pre-wrap wrap-anywhere font-sans">
              {r.question}
              {'\n\n'}
              {r.answer}
            </pre>
          </details>
        ))}
        {more && (
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await qaApi.revisions(scope, turn.paperId, turn.id, rows.at(-1)?.version);
                setRows([...rows, ...r]);
                setMore(r.length === 50);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr('更早版本')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
