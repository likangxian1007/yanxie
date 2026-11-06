import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { PaperNote } from '@srh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, Input, Select, Textarea } from '@/components/ui';
import { useCollabDoc, type CollabDoc } from '@/features/docs/collab/useCollabDoc';
import { useYTextBinding } from '@/features/docs/editors/shared/bindYText';
import { useReader } from '../lib/reader';
import { isPersonalLibrary, type LibraryScope } from '../lib/scope';
import { noteApi, notesKey, usePaperNotes } from '../notes-api';
import { useUpdatePaper } from '../api';
import { tr, trServer } from '@/lib/i18n';

export function NotesPanel() {
  const { paper, editable, scope } = useReader();
  const writable = editable && !paper.archivedAt;
  const personal = isPersonalLibrary(scope);
  const notes = usePaperNotes(scope, paper.id);
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState<{ title: string; kind: 'note' | 'brief'; body: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [tag, setTag] = useState('');
  const updatePaper = useUpdatePaper(scope, paper.id);
  const setTags = (tags: string[]) =>
    updatePaper.mutate(
      { tags, baseTagsVersion: paper.tagsVersion },
      { onError: (e) => setError(e.message) },
    );
  const active =
    notes.data?.find((n) => n.id === selected) ?? (selected ? undefined : notes.data?.[0]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div className="flex flex-wrap gap-1">
        {paper.tags.map((value) => (
          <Badge key={value}>
            {value}
            {writable && (
              <button
                type="button"
                className="ml-1 px-1"
                aria-label={tr('去掉标签 {value}', { value })}
                onClick={() => setTags(paper.tags.filter((t) => t !== value))}
              >
                ×
              </button>
            )}
          </Badge>
        ))}
      </div>
      {writable && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = tag.trim();
            if (value && !paper.tags.includes(value)) {
              setTags([...paper.tags, value]);
              setTag('');
            }
          }}
        >
          <Input
            aria-label={tr('新标签')}
            value={tag}
            maxLength={40}
            size="sm"
            placeholder={tr('添加标签')}
            onChange={(e) => setTag(e.target.value)}
            wrapperClassName="min-w-0 flex-1"
          />
          <Button
            size="sm"
            type="submit"
            variant="secondary"
            disabled={!tag.trim() || updatePaper.isPending}
          >
            {tr('添加')}
          </Button>
        </form>
      )}
      {error && !form && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <p className="text-caption text-fg-muted">
        {personal
          ? tr('笔记和团队说明稿仅自己可见；发布时再选择。')
          : tr('项目成员共同编辑，个人原件不受影响。')}
      </p>
      {writable && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setForm({ title: '', kind: 'note', body: '' })}
          >
            {tr('新建笔记')}
          </Button>
          {personal && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setForm({ title: '', kind: 'brief', body: '' })}
            >
              {tr('新建团队说明稿')}
            </Button>
          )}
        </div>
      )}
      {notes.isPending && <p role="status">{tr('正在读取笔记…')}</p>}
      {notes.error && (
        <div role="alert">
          <p>{notes.error.message}</p>
          <Button onClick={() => void notes.refetch()}>{tr('重试')}</Button>
        </div>
      )}
      {notes.data?.length === 0 && (
        <p className="text-small text-fg-muted">
          {tr('还没有独立笔记。可按阅读摘要、实验思路分别创建。')}
        </p>
      )}
      {!!notes.data?.length && (
        <Select
          aria-label={tr('选择笔记')}
          value={active?.id ?? ''}
          onChange={(e) => setSelected(e.target.value)}
        >
          {!active && <option value="">{tr('这份笔记已删除，请选择其他笔记')}</option>}
          {notes.data.map((n) => (
            <option key={n.id} value={n.id}>
              {n.kind === 'brief' ? tr('说明稿 · ') : ''}
              {n.title}
            </option>
          ))}
        </Select>
      )}
      {active && (
        <NoteEditor
          key={active.id}
          note={active}
          scope={scope}
          writable={writable}
          onSelect={setSelected}
        />
      )}
      {paper.note && (
        <details className="rounded-md border border-line p-3 text-small">
          <summary className="cursor-pointer">{tr('旧版笔记（原文保留）')}</summary>
          <p className="mt-2 whitespace-pre-wrap wrap-anywhere">{paper.note}</p>
          {writable && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => setForm({ title: tr('旧版笔记副本'), kind: 'note', body: paper.note })}
            >
              {tr('复制为独立笔记')}
            </Button>
          )}
        </details>
      )}
      {form && (
        <Dialog
          open
          title={form.kind === 'brief' ? tr('新建团队说明稿') : tr('新建笔记')}
          onOpenChange={(open) => {
            if (!open && !pending) {
              setForm(null);
              setError('');
            }
          }}
          footer={
            <Button
              variant="primary"
              disabled={!form.title.trim()}
              loading={pending}
              onClick={async () => {
                setPending(true);
                setError('');
                try {
                  const created = await noteApi.create(scope, paper.id, form);
                  await notes.refetch();
                  setSelected(created.id);
                  setForm(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setPending(false);
                }
              }}
            >
              {tr('创建')}
            </Button>
          }
        >
          <Input
            aria-label={tr('笔记标题')}
            value={form.title}
            maxLength={160}
            autoFocus
            placeholder={tr('例如：方法理解、团队复现说明')}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          {form.kind === 'brief' && (
            <p className="mt-2 text-small text-fg-muted">
              {tr('这是私人草稿，创建后不会自动发布给团队。')}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-danger">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function NoteEditor({
  note,
  scope,
  writable,
  onSelect,
}: {
  note: PaperNote;
  scope: LibraryScope;
  writable: boolean;
  onSelect: (id: string) => void;
}) {
  const collab = useCollabDoc(note.id);
  return collab ? (
    <ConnectedNoteEditor
      note={note}
      scope={scope}
      writable={writable}
      onSelect={onSelect}
      collab={collab}
    />
  ) : (
    <p role="status">{tr('正在连接笔记…')}</p>
  );
}
function ConnectedNoteEditor({
  note,
  scope,
  writable,
  onSelect,
  collab,
}: {
  note: PaperNote;
  scope: LibraryScope;
  writable: boolean;
  onSelect: (id: string) => void;
  collab: CollabDoc;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState<{ value: string; version: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const ytext = collab.doc.getText('body');
  const undo = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    const manager = new Y.UndoManager(ytext, { trackedOrigins: new Set(['library-editor']) });
    undo.current = manager;
    return () => {
      manager.destroy();
      undo.current = null;
    };
  }, [ytext]);
  const ref = useYTextBinding<HTMLTextAreaElement>(ytext, {
    origin: 'library-editor',
    onUndo: () => undo.current?.undo(),
    onRedo: () => undo.current?.redo(),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: notesKey(scope, note.paperId) });
  // 接收确认后主动落库；连接建立并不等于已持久化。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let generation = 0;
    const flush = () => {
      const current = ++generation;
      setSaved(false);
      clearTimeout(timer);
      if (collab.status !== 'connected' || collab.unsynced) return;
      timer = setTimeout(() => {
        void noteApi
          .flush(scope, note.paperId, note.id)
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
    ytext.observe(flush);
    return () => {
      disposed = true;
      clearTimeout(timer);
      ytext.unobserve(flush);
    };
  }, [collab.status, collab.unsynced, scope, note.id, note.paperId, ytext]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const denied = collab.status === 'denied';
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-caption text-fg-muted" role="status">
        {denied
          ? tr('笔记已删除或访问权限已失效，编辑已停止。')
          : collab.status !== 'connected'
            ? tr('连接中或已离线：本机修改将在连接恢复后同步。')
            : saved
              ? tr('已保存到服务器')
              : tr('正在同步并保存…')}
      </div>
      {!isPersonalLibrary(scope) && (
        <p className="text-caption text-fg-muted">
          {tr('正在查看：')}
          {collab.peers.map((p) => p.user.name).join(tr('、')) || tr('正在连接')}
        </p>
      )}
      {note.publishedFrom && (
        <p className="text-caption text-fg-muted">
          {tr(
            '来源：{name} 的个人笔记第 {sourceVersion}{value}版，由 {name2} 发布。团队修改独立保存。',
            {
              name: trServer(note.publishedFrom.author.name),
              sourceVersion: note.publishedFrom.sourceVersion,
              value: ' ',
              name2: trServer(note.publishedFrom.publishedBy.name),
            },
          )}
        </p>
      )}
      <p className="text-caption text-fg-muted">
        {tr('创建：{name} · 最近保存：{name2}', {
          name: trServer(note.createdBy.name),
          name2: trServer(note.updatedBy.name),
        })}
      </p>
      {(collab.ready || collab.synced) && !denied ? (
        <Textarea
          ref={ref}
          aria-label={tr('笔记正文')}
          placeholder={tr('写下摘要、疑问或复现步骤，支持纯文本和 Markdown。')}
          maxLength={100000}
          readOnly={!writable}
          rows={12}
          className="min-h-60"
        />
      ) : (
        !denied && <p role="status">{tr('正在连接笔记…')}</p>
      )}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {writable && !denied && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setTitle({ value: note.title, version: note.version })}
          >
            {tr('重命名')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || collab.status !== 'connected' || Boolean(collab.unsynced)}
            onClick={() =>
              void perform(async () => {
                await noteApi.flush(scope, note.paperId, note.id);
                setSaved(true);
                await refresh();
              })
            }
          >
            {tr('立即保存')}
          </Button>
          {isPersonalLibrary(scope) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || collab.status !== 'connected' || Boolean(collab.unsynced)}
              onClick={() =>
                void perform(async () => {
                  const latest = await noteApi.flush(scope, note.paperId, note.id);
                  const copy = await noteApi.brief(scope, note.paperId, latest);
                  await refresh();
                  onSelect(copy.id);
                })
              }
            >
              {tr('复制为团队说明稿')}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(true)}>
            {tr('删除笔记')}
          </Button>
        </div>
      )}
      {title !== null && (
        <Dialog
          open
          title={tr('重命名笔记')}
          onOpenChange={(open) => {
            if (!open) setTitle(null);
          }}
          footer={
            <Button
              variant="primary"
              loading={busy}
              disabled={!title.value.trim()}
              onClick={() =>
                void perform(async () => {
                  await noteApi.rename(
                    scope,
                    note.paperId,
                    { ...note, version: title.version },
                    title.value,
                  );
                  await refresh();
                  setTitle(null);
                })
              }
            >
              {tr('保存标题')}
            </Button>
          }
        >
          <Input
            aria-label={tr('新的笔记标题')}
            value={title.value}
            maxLength={160}
            onChange={(e) => setTitle({ ...title, value: e.target.value })}
          />
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
      {deleting && (
        <Dialog
          open
          title={tr('删除这份笔记？')}
          description={tr('其他笔记以及已经发布的独立副本不受影响。这份笔记将停止协同编辑。')}
          onOpenChange={setDeleting}
          footer={
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void perform(async () => {
                  await noteApi.remove(scope, note.paperId, note.id);
                  await refresh();
                  setDeleting(false);
                  onSelect('');
                })
              }
            >
              {tr('确认删除')}
            </Button>
          }
        >
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </section>
  );
}
