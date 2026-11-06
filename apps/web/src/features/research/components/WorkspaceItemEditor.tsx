import { clientId } from '@/lib/client-id';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type {
  ResearchAction,
  ResearchItem,
  ResearchItemContent,
  ResearchItemSummary,
  ResearchRelation,
} from '@srh/shared';
import { Button, Input, Markdown, Skeleton, Textarea } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { withBase } from '@/lib/base-path';
import { useHarness } from '@/lib/harness';
import { SessionControls } from '@/features/harness/components/SessionControls';
import { isEffort, sessionView } from '@/features/harness/model-utils';
import { ResourcePicker } from './ResourcePicker';
import { ExcerptActions } from './ExcerptActions';
import { WorkspaceActionEditor } from './WorkspaceActionEditor';
import {
  ArtifactHistory,
  DraftContent,
  FigureContent,
  TableContent,
} from './WorkspaceStructuredContent';
import {
  draftKey,
  itemDraft,
  itemDraftText,
  restoreItemDraft,
  type ItemDraft,
  type StoredItemDraft,
} from '../lib/workspace-draft';
import { itemKey, readLocal, workspaceApi, workspaceKey, writeLocal } from '../workspace-data';
import { tr } from '@/lib/i18n';

const defaultAction = (): ResearchAction => ({
  kind: 'ai',
  processing: { mode: 'auto', expectedOutputs: [] },
  instructions: '',
  inputItemIds: [],
  notebookId: null,
  cellIds: [],
  model: null,
  effort: null,
  profile: null,
});

type EditorState = {
  base: ResearchItem;
  draft: ItemDraft;
  dirty: boolean;
  conflict: ResearchItem | null;
  backup?: ItemDraft;
};
type SaveState = 'saved' | 'local' | 'saving' | 'offline' | 'conflict' | 'error';

export function WorkspaceItemEditor({
  pid,
  recordId,
  userId,
  itemId,
  items,
  relations = [],
  writable,
  onOpen,
  onClose,
  onCreated,
}: {
  pid: string;
  recordId: string;
  userId: string;
  itemId: string;
  items: ResearchItemSummary[];
  relations?: ResearchRelation[];
  writable: boolean;
  onOpen: (
    id: string,
    locator?: {
      start?: number;
      end?: number;
      segment?: number;
      blockId?: string;
      version?: string | number | null;
    },
  ) => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const key = draftKey(userId, pid, recordId, itemId);
  const query = useQuery({
    queryKey: itemKey(pid, recordId, itemId),
    queryFn: async ({ signal }) => {
      try {
        return await workspaceApi.item(pid, recordId, itemId, signal);
      } catch (error) {
        const cached = readLocal<StoredItemDraft>(key);
        if (
          !signal.aborted &&
          error instanceof ApiRequestError &&
          error.isNetworkError &&
          cached?.base
        )
          return cached.base;
        throw error;
      }
    },
  });
  if (query.isPending) return <Skeleton className="h-64" />;
  if (query.isError)
    return (
      <div role="alert" className="space-y-3 text-small text-danger">
        <p>{tr('内容没有加载出来：{message}', { message: query.error.message })}</p>
        <Button onClick={() => void query.refetch()}>{tr('重试')}</Button>
      </div>
    );
  return (
    <ItemEditor
      key={itemId}
      {...{
        pid,
        recordId,
        userId,
        itemId,
        items,
        relations,
        writable,
        onOpen,
        onClose,
        onCreated,
        storageKey: key,
        server: query.data,
      }}
    />
  );
}

function ItemEditor({
  pid,
  recordId,
  userId,
  itemId,
  items,
  writable,
  onOpen,
  onClose,
  onCreated,
  storageKey,
  server,
}: {
  pid: string;
  recordId: string;
  userId: string;
  itemId: string;
  items: ResearchItemSummary[];
  relations: ResearchRelation[];
  writable: boolean;
  onOpen: (
    id: string,
    locator?: {
      start?: number;
      end?: number;
      segment?: number;
      blockId?: string;
      version?: string | number | null;
    },
  ) => void;
  onClose: () => void;
  onCreated: (id: string) => void;
  storageKey: string;
  server: ResearchItem;
}) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const rawOffset = params.get('offset');
  const offset = Math.max(
    0,
    rawOffset === null
      ? (readLocal<number>(`${storageKey}:resource-offset`) ?? 0)
      : Number(rawOffset) || 0,
  );
  useEffect(() => {
    writeLocal(`${storageKey}:resource-offset`, offset);
  }, [storageKey, offset]);
  const [state, setState] = useState<EditorState>(() => {
    const stored = readLocal<StoredItemDraft>(storageKey);
    return {
      ...restoreItemDraft(server, stored),
      ...(stored?.backup ? { backup: stored.backup } : {}),
    };
  });
  const stateRef = useRef(state);
  const inFlight = useRef(false);
  const [saveState, setSaveState] = useState<SaveState>(
    state.conflict ? 'conflict' : state.dirty ? 'local' : 'saved',
  );
  const [message, setMessage] = useState('');
  const [localOk, setLocalOk] = useState(true);
  const [reading, setReading] = useState(false);
  const [closing, setClosing] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteStart = params.has('start') ? Number(params.get('start')) : undefined;
  const noteEnd = params.has('end') ? Number(params.get('end')) : undefined;
  const locatingNote =
    state.base.kind === 'note' && noteStart !== undefined && noteEnd !== undefined;
  const contentVersionRef = useRef<string | number | null | undefined>(undefined);
  const [contentSelection, setContentSelection] = useState<{
    quote: string;
    start: number;
    end: number;
    key: string;
  } | null>(null);
  const [excerptPending, setExcerptPending] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const content = useQuery({
    queryKey: [...itemKey(pid, recordId, itemId), 'content', offset],
    queryFn: ({ signal }) => workspaceApi.content(pid, recordId, itemId, offset, signal),
    enabled: server.kind === 'resource' || !!server.evidenceRef,
  });
  const persist = useCallback(
    (next: EditorState) => {
      stateRef.current = next;
      setState(next);
      const saved = writeLocal(storageKey, {
        base: next.base,
        draft: next.draft,
        dirty: next.dirty,
        ...(next.backup ? { backup: next.backup } : {}),
      } satisfies StoredItemDraft);
      setLocalOk(saved);
      if (!saved && next.dirty) setMessage(tr('无法保存本地草稿，请保持页面打开并重试保存。'));
    },
    [storageKey],
  );
  useEffect(() => {
    persist(stateRef.current);
  }, [persist]);
  const edit = (patch: Partial<ItemDraft>) => {
    const next = {
      ...stateRef.current,
      draft: { ...stateRef.current.draft, ...patch },
      dirty: true,
    };
    persist(next);
    if (!next.conflict) setSaveState('local');
  };
  const save = useCallback(
    async (override?: ResearchItem) => {
      const current = stateRef.current;
      if (inFlight.current || (current.conflict && !override)) return false;
      if (!current.dirty) return true;
      if (!current.draft.title.trim()) {
        setSaveState('error');
        setMessage(tr('名称不能为空。'));
        return false;
      }
      inFlight.current = true;
      setSaveState('saving');
      setMessage('');
      const submitted = structuredClone(current.draft);
      const base = override ?? current.base;
      try {
        const updated = await workspaceApi.updateItem(pid, recordId, itemId, {
          baseVersion: base.version,
          ...submitted,
          title: submitted.title.trim(),
        });
        const latest = stateRef.current;
        const changedDuringSave = JSON.stringify(latest.draft) !== JSON.stringify(submitted);
        const next: EditorState = {
          ...latest,
          base: updated,
          draft: changedDuringSave ? latest.draft : itemDraft(updated),
          dirty: changedDuringSave,
          conflict: null,
        };
        persist(next);
        setSaveState(changedDuringSave ? 'local' : 'saved');
        qc.setQueryData(itemKey(pid, recordId, itemId), updated);
        void qc.invalidateQueries({ queryKey: workspaceKey(pid, recordId), exact: true });
        return !changedDuringSave;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          let latest = error.details?.current as ResearchItem | undefined;
          if (!latest?.id) {
            try {
              latest = await workspaceApi.item(pid, recordId, itemId);
            } catch {
              /* 保留草稿，用户可重试 */
            }
          }
          if (latest) persist({ ...stateRef.current, conflict: latest });
          setSaveState('conflict');
          setMessage(
            latest
              ? tr('内容已被其他人修改，请比较后选择。')
              : tr('内容发生冲突，无法读取新版本。草稿仍在本机。'),
          );
        } else {
          setSaveState(
            error instanceof ApiRequestError && error.isNetworkError ? 'offline' : 'error',
          );
          setMessage(error instanceof Error ? error.message : tr('保存失败，请重试。'));
        }
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [itemId, pid, recordId, persist, qc],
  );
  useEffect(() => {
    if (
      !writable ||
      !state.dirty ||
      state.conflict ||
      saveState === 'offline' ||
      saveState === 'error' ||
      saveState === 'saving'
    )
      return;
    const timer = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(timer);
  }, [state, writable, save, saveState]);
  useEffect(() => {
    const online = () => {
      if (stateRef.current.dirty && !stateRef.current.conflict) {
        setSaveState('local');
      }
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);
  useEffect(() => {
    // 有本地编辑时不能以查询刷新覆盖；检测远程版本变化供用户比较。
    const current = stateRef.current;
    if (server.version === current.base.version) return;
    if (current.dirty) {
      persist({ ...current, conflict: server });
      setSaveState('conflict');
    } else {
      persist({ ...current, base: server, draft: itemDraft(server), conflict: null });
      setSaveState('saved');
    }
  }, [server, persist]);
  const setAction = (patch: Partial<ResearchAction>) =>
    edit({ action: { ...(state.draft.action ?? defaultAction()), ...patch } });
  useEffect(() => {
    const previous = readLocal<number>(`${storageKey}:scroll`);
    if (noteRef.current && previous !== null) noteRef.current.scrollTop = previous;
  }, [storageKey]);
  useEffect(() => {
    const field = noteRef.current;
    if (
      !locatingNote ||
      !field ||
      !Number.isInteger(noteStart) ||
      !Number.isInteger(noteEnd) ||
      noteStart! < 0 ||
      noteEnd! <= noteStart! ||
      noteEnd! > field.value.length
    )
      return;
    field.focus();
    field.setSelectionRange(noteStart!, noteEnd!);
  }, [locatingNote, noteStart, noteEnd, reading]);
  useEffect(() => {
    if (!content.data) return;
    if (
      contentVersionRef.current !== undefined &&
      contentVersionRef.current !== content.data.version
    )
      setMessage(tr('原材料版本已变化，分段内容可能不一致，请回到开头重读。'));
    contentVersionRef.current = content.data.version;
  }, [content.data]);
  const rememberSelection = () => {
    const root = contentRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const before = range.cloneRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const quote = range.toString();
    if (quote.trim())
      setContentSelection({ quote, start, end: start + quote.length, key: clientId() });
  };
  const makeExcerpt = async () => {
    if (!contentSelection || !content.data) return;
    if (contentSelection.quote.length > 20000) {
      setMessage(tr('摘录不能超过 20000 字，请缩小选择范围。'));
      return;
    }
    setExcerptPending(true);
    setMessage('');
    try {
      const item = await workspaceApi.createItem(pid, recordId, {
        kind: 'note',
        title: tr('摘录：{title}', { title: state.base.title }).slice(0, 200),
        body: contentSelection.quote,
        origin: {
          itemId,
          sourceVersion: content.data.version,
          quote: contentSelection.quote,
          locator: {
            kind: 'text',
            start: contentSelection.start,
            end: contentSelection.end,
            segment: offset,
          },
        },
        position: { x: state.base.position.x + 260, y: state.base.position.y },
        idempotencyKey: contentSelection.key,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: workspaceKey(pid, recordId), exact: true }),
        qc.invalidateQueries({ queryKey: ['p', pid, 'research', 'record', recordId] }),
      ]);
      onCreated(item.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : tr('摘录没有保存，请重试。'));
    } finally {
      setExcerptPending(false);
    }
  };
  const statusLabel: Record<SaveState, string> = {
    saved: state.base.kind === 'table' ? tr('名称与列说明已保存') : tr('已保存'),
    local: localOk ? tr('草稿已保存在本机') : tr('草稿未能保存在本机'),
    saving: tr('正在保存'),
    offline: localOk ? tr('离线，草稿保存在本机') : tr('离线，草稿未能保存在本机'),
    conflict: tr('需要处理冲突'),
    error: tr('保存失败'),
  };
  const origin = state.base.origin;
  return (
    <section className="mx-auto w-full max-w-[820px] space-y-5" aria-label={tr('聚焦内容')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          disabled={closing || saveState === 'saving'}
          onClick={() => {
            if (stateRef.current.conflict || saveState === 'conflict') return;
            if (!stateRef.current.dirty) {
              onClose();
              return;
            }
            setClosing(true);
            void save()
              .then((saved) => {
                if (saved && !stateRef.current.dirty && !stateRef.current.conflict) onClose();
              })
              .finally(() => setClosing(false));
          }}
        >
          {tr('← 返回总览')}
        </Button>
        <div className="flex items-center gap-2 text-caption text-fg-muted" role="status">
          {statusLabel[saveState]}
          {state.dirty && !state.conflict && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSaveState('local');
                void save();
              }}
            >
              {tr('立即保存')}
            </Button>
          )}
        </div>
      </div>
      <Input
        aria-label={tr('内容名称')}
        value={state.draft.title}
        disabled={!writable}
        maxLength={200}
        onChange={(e) => edit({ title: e.target.value })}
        className="text-h2 font-semibold"
      />
      {origin && (
        <div className="rounded-lg border border-line bg-subtle p-3 text-small text-fg-muted">
          {tr('摘录 · 未核验 · 来源版本 ')}
          {origin.sourceVersion ?? tr('未知')}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onOpen(origin.itemId, { ...origin.locator, version: origin.sourceVersion })
            }
          >
            {tr('回到原材料')}
          </Button>
        </div>
      )}
      {state.base.kind === 'note' && (
        <div className="space-y-3">
          {writable && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setReading((current) => !current)}>
                {reading ? tr('继续编辑') : tr('阅读预览')}
              </Button>
            </div>
          )}
          {locatingNote && (
            <p role="status" className="text-caption text-fg-muted">
              {tr('正在查看当前笔记中的原文位置；若正文已变化，请核对固定快照。')}
            </p>
          )}
          {reading || (!writable && !locatingNote) ? (
            <div className="min-h-[45vh] text-prose">
              <Markdown>{state.draft.body || tr('暂无正文')}</Markdown>
            </div>
          ) : (
            <Textarea
              ref={noteRef}
              onScroll={(e) => writeLocal(`${storageKey}:scroll`, e.currentTarget.scrollTop)}
              aria-label={tr('笔记正文')}
              value={state.draft.body}
              readOnly={!writable}
              rows={18}
              maxLength={200000}
              onChange={(e) => edit({ body: e.target.value })}
              className="min-h-[45vh] resize-y text-prose leading-7"
              placeholder={tr('开始记录…')}
            />
          )}
        </div>
      )}
      {state.base.kind === 'group' && (
        <div className="space-y-4">
          <Textarea
            aria-label={tr('分组说明')}
            value={state.draft.body}
            disabled={!writable}
            rows={8}
            onChange={(e) => edit({ body: e.target.value })}
            placeholder={tr('分组说明')}
          />
          <ul
            aria-label={tr('分组内容')}
            className="divide-y divide-line rounded-lg border border-line"
          >
            {items
              .filter((item) => item.parentId === itemId)
              .map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full px-3 py-3 text-left text-small hover:bg-subtle"
                    onClick={() => onOpen(item.id)}
                  >
                    <span className="font-medium">{item.title}</span>
                    {item.preview && (
                      <span className="mt-1 block truncate text-fg-muted">{item.preview}</span>
                    )}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {state.base.kind === 'draft' && (
        <DraftContent
          pid={pid}
          recordId={recordId}
          payload={
            state.draft.payload?.kind === 'draft'
              ? state.draft.payload
              : { kind: 'draft', blocks: [] }
          }
          focusBlockId={params.get('block')}
          focusStart={params.has('start') ? Number(params.get('start')) : undefined}
          focusEnd={params.has('end') ? Number(params.get('end')) : undefined}
          disabled={!writable}
          onChange={(payload) => edit({ payload })}
        />
      )}
      {state.base.kind === 'table' && (
        <TableContent
          pid={pid}
          recordId={recordId}
          item={state.base}
          items={items}
          userId={userId}
          payload={state.draft.payload?.kind === 'table' ? state.draft.payload : { kind: 'table' }}
          disabled={!writable}
          onChange={(payload) => edit({ payload })}
          onOpen={onOpen}
        />
      )}
      {state.base.kind === 'figure' && (
        <FigureContent
          pid={pid}
          recordId={recordId}
          item={state.base}
          items={items}
          payload={
            state.draft.payload?.kind === 'figure' ? state.draft.payload : { kind: 'figure' }
          }
          disabled={!writable}
          onChange={(payload) => edit({ payload })}
        />
      )}
      {state.base.kind === 'note' && (
        <ArtifactHistory
          pid={pid}
          recordId={recordId}
          itemId={itemId}
          producer={items.find((entry) => entry.id === itemId)}
        />
      )}
      {state.base.kind === 'action' && (
        <div className="space-y-4">
          <WorkspaceActionEditor
            pid={pid}
            recordId={recordId}
            itemId={itemId}
            items={items}
            action={state.draft.action ?? defaultAction()}
            disabled={!writable}
            onChange={setAction}
          />
          {state.draft.action?.kind === 'ai' &&
            !['transform_table', 'chart'].includes(state.draft.action.operation ?? '') && (
              <ActionModelControls
                pid={pid}
                action={state.draft.action}
                disabled={!writable}
                onChange={setAction}
              />
            )}
          {state.draft.action?.kind === 'notebook' && (
            <>
              <div className="space-y-1.5 text-small">
                Notebook
                <ResourcePicker
                  pid={pid}
                  fixedKind="notebook"
                  label="Notebook"
                  disabled={!writable}
                  value={
                    state.draft.action.notebookId
                      ? { kind: 'notebook', id: state.draft.action.notebookId }
                      : null
                  }
                  onChange={(value) => setAction({ notebookId: value?.id || null, cellIds: [] })}
                />
              </div>
              {state.draft.action.notebookId && (
                <NotebookCells
                  pid={pid}
                  id={state.draft.action.notebookId}
                  cellIds={state.draft.action.cellIds}
                  disabled={!writable}
                  onChange={(cellIds) => setAction({ cellIds })}
                />
              )}
            </>
          )}
          <ArtifactHistory pid={pid} recordId={recordId} itemId={itemId} isStep />
        </div>
      )}
      {(state.base.kind === 'resource' || state.base.evidenceRef) && (
        <ResourceContent
          data={content.data}
          pending={content.isPending}
          error={content.error}
          retry={() => void content.refetch()}
          contentRef={contentRef}
          onSelect={rememberSelection}
          start={Number(params.get('start'))}
          end={Number(params.get('end'))}
          expectedVersion={params.get('version')}
          onNext={(nextOffset) => {
            const next = new URLSearchParams(params);
            next.set('offset', String(nextOffset));
            next.delete('start');
            next.delete('end');
            next.delete('version');
            setParams(next, { replace: true });
            setContentSelection(null);
          }}
          offset={offset}
          scrollKey={`${storageKey}:resource-scroll:${offset}`}
        />
      )}
      {contentSelection && writable && (
        <div className="flex flex-wrap items-center gap-2 text-small">
          <span className="text-fg-muted">
            {tr('已选择 {count} 字', { count: contentSelection.quote.length })}
          </span>
          <Button variant="secondary" loading={excerptPending} onClick={() => void makeExcerpt()}>
            {tr('摘录选中文字')}
          </Button>
        </div>
      )}
      {state.base.evidenceRef?.kind === 'excerpt' && (
        <ExcerptActions
          pid={pid}
          recordId={recordId}
          excerptId={state.base.evidenceRef.id}
          writable={writable}
        />
      )}
      {state.conflict && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-warning bg-warning-soft p-4 text-small"
        >
          <p>{tr('其他人已保存新版本，本机草稿仍保留。比较后选择如何继续。')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <b>{tr('本机草稿')}</b>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                {state.draft.title}
                {'\n'}
                {itemDraftText(state.draft)}
              </pre>
            </div>
            <div>
              <b>{tr('服务器版本')}</b>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                {state.conflict.title}
                {'\n'}
                {itemDraftText(itemDraft(state.conflict))}
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                const current = stateRef.current;
                if (!current.conflict) return;
                const next = {
                  base: current.conflict,
                  draft: itemDraft(current.conflict),
                  dirty: false,
                  conflict: null,
                  backup: current.draft,
                };
                persist(next);
                setSaveState('saved');
              }}
            >
              {tr('采用服务器版本')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                if (stateRef.current.conflict) void save(stateRef.current.conflict);
              }}
            >
              {tr('用本机草稿保存')}
            </Button>
          </div>
        </div>
      )}
      {state.backup && !state.conflict && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const current = stateRef.current;
            const backup = current.backup;
            if (!backup) return;
            persist({ ...current, draft: backup, dirty: true, backup: current.draft });
            setSaveState('local');
          }}
        >
          {tr('恢复冲突前草稿')}
        </Button>
      )}
      {message && (
        <p role="alert" className="text-small text-danger">
          {message}
        </p>
      )}
    </section>
  );
}

function ResourceContent({
  data,
  pending,
  error,
  retry,
  contentRef,
  onSelect,
  start,
  end,
  offset,
  expectedVersion,
  scrollKey,
  onNext,
}: {
  data?: ResearchItemContent;
  pending: boolean;
  error: Error | null;
  retry: () => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  start: number;
  end: number;
  offset: number;
  expectedVersion: string | null;
  scrollKey: string;
  onNext: (offset: number) => void;
}) {
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (markRef.current) markRef.current.scrollIntoView({ block: 'center' });
    else if (contentRef.current) contentRef.current.scrollTop = readLocal<number>(scrollKey) ?? 0;
  }, [data, start, end, scrollKey, contentRef]);
  if (pending) return <Skeleton className="h-40" />;
  if (error)
    return (
      <div role="alert" className="text-small text-danger">
        {tr('原材料没有加载出来。')}
        <Button size="sm" variant="ghost" onClick={retry}>
          {tr('重试')}
        </Button>
      </div>
    );
  if (!data) return null;
  const text = data.text ?? '';
  const changed = expectedVersion !== null && String(data.version) !== expectedVersion;
  const highlighted =
    !changed &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    end > start &&
    start >= 0 &&
    end <= text.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
        <span>
          {data.title}
          {tr(' · 版本 ')}
          {data.version ?? tr('未知')}
        </span>
        {data.href && (
          <a
            href={withBase(data.href)}
            className="text-accent-text hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {tr('打开原材料')}
          </a>
        )}
      </div>
      {data.unavailableReason && (
        <p className="text-small text-fg-muted">{data.unavailableReason}</p>
      )}
      {data.summary && <p className="text-small text-fg-muted">{data.summary}</p>}
      {changed && (
        <p role="status" className="text-small text-warning">
          {tr('原材料版本已变化，原定位可能不再对应当前内容。')}
        </p>
      )}
      {text && (
        <div
          ref={contentRef}
          onScroll={(event) => writeLocal(scrollKey, event.currentTarget.scrollTop)}
          onMouseUp={onSelect}
          onKeyUp={onSelect}
          className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-5 text-prose leading-7"
        >
          {highlighted ? (
            <>
              {text.slice(0, start)}
              <mark ref={markRef} className="bg-accent-soft text-fg">
                {text.slice(start, end)}
              </mark>
              {text.slice(end)}
            </>
          ) : (
            text
          )}
        </div>
      )}
      <div className="flex gap-2">
        {offset > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onNext(0)}>
            {tr('回到开头')}
          </Button>
        )}
        {data.nextOffset !== null && (
          <Button size="sm" variant="secondary" onClick={() => onNext(data.nextOffset!)}>
            {tr('下一段')}
          </Button>
        )}
      </div>
    </div>
  );
}

function NotebookCells({
  pid,
  id,
  cellIds,
  disabled,
  onChange,
}: {
  pid: string;
  id: string;
  cellIds: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const query = useQuery({
    queryKey: ['p', pid, 'research-notebook-cells', id],
    queryFn: ({ signal }) =>
      api.get<{ cells: { id: string; cell_type: string; source: string | string[] }[] }>(
        `/projects/${pid}/notebooks/${id}/export`,
        { signal, query: { format: 'ipynb' } },
      ),
  });
  const cells = (query.data?.cells ?? []).filter((cell) => cell.cell_type === 'code');
  return (
    <fieldset className="space-y-2">
      <legend className="text-small font-medium">{tr('代码单元格')}</legend>
      {query.isPending ? (
        <p className="text-caption text-fg-muted">{tr('正在读取单元格…')}</p>
      ) : query.isError ? (
        <p role="alert" className="text-small text-danger">
          {tr('单元格没有加载出来。')}
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      ) : !cells.length ? (
        <p className="text-small text-fg-muted">{tr('没有代码单元格')}</p>
      ) : (
        <>
          <label className="flex min-h-9 items-center gap-2 text-small">
            <input
              type="radio"
              name={`cells-${id}`}
              checked={!cellIds.length}
              disabled={disabled}
              onChange={() => onChange([])}
            />
            {tr('全部代码单元格')}
          </label>
          <label className="flex min-h-9 items-center gap-2 text-small">
            <input
              type="radio"
              name={`cells-${id}`}
              checked={!!cellIds.length}
              disabled={disabled}
              onChange={() => onChange(cells.map((cell) => cell.id))}
            />
            {tr('选择单元格')}
          </label>
          {cellIds.length > 0 &&
            cells.map((cell, index) => (
              <label key={cell.id} className="flex min-h-9 items-start gap-2 text-small">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={disabled || (cellIds.length === 1 && cellIds.includes(cell.id))}
                  checked={cellIds.includes(cell.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...cellIds, cell.id]
                        : cellIds.filter((entry) => entry !== cell.id),
                    )
                  }
                />
                <span>
                  {tr('第 ')}
                  {index + 1}
                  {tr(' 段 ·')}{' '}
                  {(Array.isArray(cell.source) ? cell.source.join('') : cell.source).slice(
                    0,
                    100,
                  ) || tr('空代码')}
                </span>
              </label>
            ))}
        </>
      )}
    </fieldset>
  );
}

function ActionModelControls({
  pid,
  action,
  disabled,
  onChange,
}: {
  pid: string;
  action: ResearchAction;
  disabled: boolean;
  onChange: (patch: Partial<ResearchAction>) => void;
}) {
  const harness = useHarness(pid);
  const [open, setOpen] = useState(false);
  const catalog = harness.data?.catalog;
  const profiles = harness.data?.profiles ?? [];
  const view = sessionView(catalog, profiles, {
    model: action.model ?? '',
    effort: isEffort(action.effort) ? action.effort : null,
    profile: action.profile,
  });
  return (
    <div className="space-y-1">
      <p className="text-small font-medium">{tr('模型与科研角色')}</p>
      <SessionControls
        catalog={catalog}
        profiles={profiles}
        view={view}
        disabled={disabled}
        open={open}
        onOpenChange={setOpen}
        focus="model"
        error={harness.isError ? tr('模型配置没有加载出来。') : null}
        onRetry={() => void harness.refetch()}
        onSelectModel={(model) =>
          onChange({
            model: model.id,
            effort:
              action.effort && !model.efforts.some((effort) => effort === action.effort)
                ? null
                : action.effort,
          })
        }
        onSelectEffort={(effort) => onChange({ effort })}
        onSelectProfile={(profile) => onChange({ profile: profile?.slug ?? null })}
      />
      <p className="text-caption text-fg-muted">{tr('未指定时使用项目默认配置。')}</p>
    </div>
  );
}
