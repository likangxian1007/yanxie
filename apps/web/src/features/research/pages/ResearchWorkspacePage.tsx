import { clientId } from '@/lib/client-id';
import { workspaceAutoLayout } from '../lib/workspace-graph';
import { useWorkspaceLayout } from '../lib/useWorkspaceLayout';
import { dataConnections, inputBinding, latestWorkspaceItems } from '../lib/workspace-dataflow';
import { workspaceDataWouldCycle } from '../lib/workspace-layout-geometry';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Ellipsis,
  LayoutGrid,
  List,
  Microscope,
  Plus,
  Search,
  Undo2,
} from 'lucide-react';
import type {
  ResearchItem,
  ResearchItemKind,
  ResearchItemSummary,
  ResearchPosition,
  ResearchResourceRef,
} from '@srh/shared';
import { Page, PageActions, PageTitle } from '@/components/layout/Page';
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  Menu,
  MenuItem,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { ApiRequestError } from '@/lib/api';
import { useMediaQuery } from '@/lib/use-media-query';
import { researchApi, researchKey, useResearchEvents } from '../data';
import { ResourcePicker } from '../components/ResourcePicker';
import { WorkspaceItemEditor } from '../components/WorkspaceItemEditor';
import type { EvidenceView } from '../components/WorkspaceEvidenceDialog';
import {
  readLocal,
  useWorkspace,
  workspaceApi,
  workspaceKey,
  workspaceStorageKey,
  writeLocal,
  type WorkspaceSnapshot,
} from '../workspace-data';
import { tr } from '@/lib/i18n';

const WorkspaceCanvas = lazy(() => import('../components/WorkspaceCanvas'));
const WorkspaceExecution = lazy(() => import('../components/WorkspaceExecution'));
const WorkspaceEvidenceDialog = lazy(() => import('../components/WorkspaceEvidenceDialog'));
const RequestReviewDialog = lazy(() =>
  import('@/features/reviews/components/RequestReviewDialog').then((m) => ({
    default: m.RequestReviewDialog,
  })),
);
const LABEL: Record<ResearchItemKind, string> = {
  note: tr('笔记'),
  resource: tr('材料'),
  action: tr('处理步骤'),
  draft: tr('混合草稿'),
  table: tr('数据表'),
  figure: tr('图像'),
  group: tr('分组'),
};
type ViewState = {
  selected: string[];
  viewport: { x: number; y: number; zoom: number } | null;
  view: 'canvas' | 'list';
};
const defaultView: ViewState = { selected: [], viewport: null, view: 'canvas' };
type Undo = { label: string; layout?: boolean; apply: () => Promise<void> };

export function ResearchWorkspacePage() {
  const pid = useProjectId();
  const { recordId = '' } = useParams();
  const user = useMeUser();
  const writable = canWrite(useMyRole(pid));
  const query = useWorkspace(pid, recordId, user?.id);
  useResearchEvents(pid);
  if (!user || query.isPending)
    return (
      <Page width="full">
        <PageTitle>{tr('研究')}</PageTitle>
        <Skeleton className="h-48" />
      </Page>
    );
  if (query.isError)
    return (
      <Page width="full">
        <PageTitle>{tr('研究')}</PageTitle>
        <EmptyState
          framed
          icon={AlertTriangle}
          title={tr('研究没有加载出来')}
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>{tr('重试')}</Button>}
        />
      </Page>
    );
  return (
    <Workspace
      key={`${user.id}:${pid}:${recordId}`}
      pid={pid}
      recordId={recordId}
      userId={user.id}
      writable={writable}
      snapshot={query.data}
    />
  );
}

function Workspace({
  pid,
  recordId,
  userId,
  writable,
  snapshot,
}: {
  pid: string;
  recordId: string;
  userId: string;
  writable: boolean;
  snapshot: WorkspaceSnapshot & { offline: boolean };
}) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const rawSection = params.get('section');
  const evidenceSection: EvidenceView | null = rawSection
    ? ['materials', 'evidence', 'coding', 'findings'].includes(rawSection)
      ? (rawSection as EvidenceView)
      : 'history'
    : null;
  const showEvidence = (view: EvidenceView | null) => {
    const next = new URLSearchParams(params);
    if (view) next.set('section', view);
    else next.delete('section');
    setParams(next);
  };
  const compact = useMediaQuery('(max-width: 1279px)');
  const storageKey = `${workspaceStorageKey(userId, pid, recordId)}:view`;
  const [view, setView] = useState<ViewState>(() => ({
    ...defaultView,
    ...readLocal<Partial<ViewState>>(storageKey),
  }));
  const [search, setSearch] = useState('');
  const [newKind, setNewKind] = useState<ResearchItemKind | null>(null);
  const [groupDialog, setGroupDialog] = useState(false);
  const [relationDialog, setRelationDialog] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<{
    fromItemId: string;
    toItemId: string;
  } | null>(null);
  const [connectionKind, setConnectionKind] = useState<'note' | 'table' | 'figure'>('note');
  const [recordDialog, setRecordDialog] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [executionSelection, setExecutionSelection] = useState<string[]>([]);
  const focusOrigin = useRef<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Undo[]>([]);
  const rawItems = useMemo(
    () => snapshot.items.filter((item) => !item.archivedAt),
    [snapshot.items],
  );
  const latestLayoutItems = useRef(rawItems);
  const saveLayout = useCallback(
    async (input: Parameters<typeof workspaceApi.layout>[2]) => {
      const result = await workspaceApi.layout(pid, recordId, input);
      qc.setQueryData<WorkspaceSnapshot & { offline: boolean }>(
        workspaceKey(pid, recordId),
        (old) =>
          old
            ? {
                ...old,
                items: old.items.map((item) => {
                  const next = result.items.find((entry) => entry.id === item.id);
                  return next && next.positionVersion >= item.positionVersion
                    ? { ...item, position: next.position, positionVersion: next.positionVersion }
                    : item;
                }),
              }
            : old,
      );
      return result;
    },
    [pid, recordId, qc],
  );
  const layout = useWorkspaceLayout({
    items: rawItems,
    save: saveLayout,
    onSaved: ({ before, after }) => {
      setUndo((entries) => [
        ...entries.slice(-19),
        {
          label: tr('移动布局'),
          layout: true,
          apply: async () => {
            const moves = before.map((entry) => {
              const current = latestLayoutItems.current.find((item) => item.id === entry.id);
              const saved = after.find((item) => item.id === entry.id)!;
              if (
                !current ||
                current.position.x !== saved.position.x ||
                current.position.y !== saved.position.y
              )
                throw new Error(tr('布局已有后续改动，请先核对当前位置再撤销。'));
              return {
                itemId: entry.id,
                position: entry.position,
                basePositionVersion: current.positionVersion,
              };
            });
            await saveLayout({ idempotencyKey: clientId(), moves });
          },
        },
      ]);
    },
  });
  const allItems = layout.items;
  useEffect(() => {
    latestLayoutItems.current = allItems;
  }, [allItems]);
  const items = useMemo(() => {
    const latest = latestWorkspaceItems(allItems);
    const explicit = new Set(
      snapshot.relations.filter((r) => !r.archivedAt).flatMap((r) => [r.fromItemId, r.toItemId]),
    );
    for (const item of allItems)
      for (const input of item.actionInputs ?? [])
        if (input.source.kind === 'item') explicit.add(input.source.itemId);
    const ids = new Set(latest.map((item) => item.id));
    return allItems.filter((item) => ids.has(item.id) || explicit.has(item.id));
  }, [allItems, snapshot.relations]);
  const flows = useMemo(() => dataConnections(items), [items]);
  const relations = snapshot.relations.filter((relation) => !relation.archivedAt);
  const focused = params.get('item');
  const selected = view.selected.filter((id) => allItems.some((item) => item.id === id));
  const filtered = items.filter((item) =>
    `${item.title} ${item.preview}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: workspaceKey(pid, recordId), exact: true }),
    [pid, recordId, qc],
  );
  const updateView = useCallback(
    (patch: Partial<ViewState>) =>
      setView((previous) => {
        const next = { ...previous, ...patch };
        writeLocal(storageKey, next);
        return next;
      }),
    [storageKey],
  );
  const select = useCallback(
    (ids: string[]) =>
      setView((previous) => {
        if (JSON.stringify(previous.selected) === JSON.stringify(ids)) return previous;
        const next = { ...previous, selected: ids };
        writeLocal(storageKey, next);
        return next;
      }),
    [storageKey],
  );
  const openItem = useCallback(
    (
      id: string,
      locator?: {
        start?: number;
        end?: number;
        segment?: number;
        blockId?: string;
        version?: string | number | null;
      },
    ) => {
      if (!focused && focusOrigin.current === null) focusOrigin.current = [...view.selected];
      const next = new URLSearchParams(params);
      next.set('item', id);
      for (const key of ['offset', 'start', 'end', 'version', 'block']) next.delete(key);
      if (locator) {
        if (locator.segment !== undefined) next.set('offset', String(locator.segment));
        if (locator.start !== undefined) next.set('start', String(locator.start));
        if (locator.end !== undefined) next.set('end', String(locator.end));
        if (locator.blockId) next.set('block', locator.blockId);
        if (locator.version != null) next.set('version', String(locator.version));
      }
      setParams(next);
      select([id]);
    },
    [params, select, setParams, focused, view.selected],
  );
  const closeItem = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const key of ['item', 'offset', 'start', 'end', 'version', 'block']) next.delete(key);
    setParams(next);
    if (focusOrigin.current) {
      select(focusOrigin.current);
      focusOrigin.current = null;
    }
  }, [params, setParams, select]);
  const previousFocus = useRef(focused);
  useEffect(() => {
    if (previousFocus.current && !focused && focusOrigin.current !== null) {
      select(focusOrigin.current);
      focusOrigin.current = null;
    }
    previousFocus.current = focused;
  }, [focused, select]);
  const rememberUndo = (entry: Undo) => setUndo((entries) => [...entries.slice(-19), entry]);
  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('操作没有完成，请重试。'));
    } finally {
      await refresh();
      setPending(false);
    }
  };
  const create = async (
    kind: ResearchItemKind,
    title: string,
    resource: ResearchResourceRef | null,
    key: string,
  ) =>
    run(async () => {
      const item = await workspaceApi.createItem(pid, recordId, {
        kind,
        title,
        resource,
        ...(kind === 'draft' ? { payload: { kind: 'draft' as const, blocks: [] } } : {}),
        ...(kind === 'figure' ? { payload: { kind: 'figure' as const } } : {}),
        ...(kind === 'action'
          ? {
              action: {
                kind: 'ai',
                processing: { mode: 'auto', expectedOutputs: [] },
                instructions: '',
                inputItemIds: [],
                notebookId: null,
                cellIds: [],
                model: null,
                effort: null,
                profile: null,
              },
            }
          : {}),
        idempotencyKey: key,
      });
      rememberUndo({
        label: tr('新建'),
        apply: () => workspaceApi.archiveItem(pid, recordId, item.id, item.version),
      });
      setNewKind(null);
      openItem(item.id);
    });
  const move = (id: string, position: ResearchPosition) => {
    if (writable) layout.moveMany([{ id, position }]);
  };
  const connect = (from: string, to: string, label = '') => {
    if (!writable || from === to) return;
    void run(async () => {
      const relation = await workspaceApi.createRelation(pid, recordId, {
        fromItemId: from,
        toItemId: to,
        label,
        idempotencyKey: clientId(),
      });
      rememberUndo({
        label: tr('关联'),
        apply: () => workspaceApi.archiveRelation(pid, recordId, relation.id, relation.version),
      });
      setRelationDialog(false);
    });
  };
  const connectData = (connection: {
    fromItemId: string;
    toItemId: string;
    outputKey?: string;
    createOutputKind?: 'note' | 'table' | 'figure';
  }) => {
    if (!writable) return;
    void run(async () => {
      if (workspaceDataWouldCycle(flows, connection.fromItemId, connection.toItemId))
        throw new Error(tr('处理流程不能形成环。'));
      const source = allItems.find((item) => item.id === connection.fromItemId);
      const target = allItems.find((item) => item.id === connection.toItemId);
      if (!source || !target) throw new Error(tr('连接内容已不可用，请重新选择。'));
      let sourceForBinding = source;
      if (source.kind === 'action') {
        const sourceItem = await workspaceApi.item(pid, recordId, source.id);
        if (sourceItem.action?.processing?.mode === 'auto' && !sourceItem.action.outputs?.length) {
          if (!connection.createOutputKind) {
            setPendingConnection({ fromItemId: source.id, toItemId: target.id });
            return;
          }
          const output = { key: connection.createOutputKind, kind: connection.createOutputKind };
          await workspaceApi.updateItem(pid, recordId, source.id, {
            baseVersion: sourceItem.version,
            action: { ...sourceItem.action, outputs: [output] },
          });
          sourceForBinding = { ...source, actionOutputs: [output] };
          connection.outputKey = output.key;
          setPendingConnection(null);
        }
      }
      const current = await workspaceApi.item(pid, recordId, target.id);
      if (!current.action) throw new Error(tr('请将数据连接到处理步骤。'));
      const inputs =
        current.action.inputs ??
        current.action.inputItemIds.map((id, index) => ({
          name: tr('输入 {value}', { value: index + 1 }),
          source: { kind: 'item' as const, itemId: id },
        }));
      if (
        inputs.some((input) =>
          input.source.kind === 'item'
            ? input.source.itemId === source.id
            : input.source.stepId === source.id &&
              input.source.outputKey === (connection.outputKey ?? 'result'),
        )
      )
        return;
      const binding = inputBinding(sourceForBinding, target, inputs, connection.outputKey);
      const sourceKind =
        source.kind === 'action'
          ? (sourceForBinding.actionOutputs?.length
              ? sourceForBinding.actionOutputs
              : [{ key: 'result', kind: 'note' }]
            ).find((out) => out.key === (connection.outputKey ?? 'result'))?.kind
          : source.kind;
      if (
        ['transform_table', 'chart'].includes(current.action.operation ?? '') &&
        sourceKind !== 'table'
      )
        throw new Error(tr('这个处理步骤需要数据表输入，请先提取为表格。'));
      const next = [...inputs, binding];
      await workspaceApi.updateItem(pid, recordId, target.id, {
        baseVersion: current.version,
        action: {
          ...current.action,
          inputs: next,
          inputItemIds: next.flatMap((input) =>
            input.source.kind === 'item' ? [input.source.itemId] : [],
          ),
        },
      });
    });
  };
  const disconnectData = (id: string) => {
    const connection = flows.find((flow) => flow.id === id);
    if (!connection || !writable) return;
    void run(async () => {
      const current = await workspaceApi.item(pid, recordId, connection.toItemId);
      if (!current.action) return;
      const inputs = (current.action.inputs ?? []).filter(
        (input) => input.name !== connection.inputName,
      );
      await workspaceApi.updateItem(pid, recordId, current.id, {
        baseVersion: current.version,
        action: {
          ...current.action,
          inputs,
          inputItemIds: inputs.flatMap((input) =>
            input.source.kind === 'item' ? [input.source.itemId] : [],
          ),
        },
      });
    });
  };
  const group = (groupId: string) =>
    void run(async () => {
      const changed: { before: ResearchItem; after: ResearchItem }[] = [];
      try {
        for (const id of selected.filter((id) => id !== groupId)) {
          const before = await workspaceApi.item(pid, recordId, id);
          const after = await workspaceApi.updateItem(pid, recordId, id, {
            baseVersion: before.version,
            parentId: groupId || null,
          });
          changed.push({ before, after });
        }
      } finally {
        if (changed.length)
          rememberUndo({
            label: tr('分组'),
            apply: async () => {
              for (const { before, after } of changed)
                await workspaceApi.updateItem(pid, recordId, before.id, {
                  baseVersion: after.version,
                  parentId: before.parentId,
                });
            },
          });
      }
      setGroupDialog(false);
    });
  const arrange = () => {
    if (writable)
      layout.moveMany(
        workspaceAutoLayout(items).map(({ item, position }) => ({ id: item.id, position })),
      );
  };
  const undoLast = () => {
    const entry = undo.at(-1);
    if (!entry || layout.saving || layout.issues.length) return;
    if (entry.layout) {
      void entry
        .apply()
        .then(() => setUndo((entries) => entries.slice(0, -1)))
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : tr('撤销没有保存，请重试。')),
        );
      return;
    }
    void run(async () => {
      await entry.apply();
      setUndo((entries) => entries.slice(0, -1));
    });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : document.body;
      if (event.defaultPrevented || target.closest('[role="dialog"],[role="menu"]')) return;
      if (focused && event.key === 'Escape') {
        event.preventDefault();
        closeItem();
        return;
      }
      if (
        focused ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && undo.length) {
        event.preventDefault();
        undoLast();
      } else if (
        event.key === 'Enter' &&
        selected.length === 1 &&
        !target.closest('button,a,summary,[role="button"],[role="link"]')
      ) {
        event.preventDefault();
        openItem(selected[0]!);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  return (
    <Page width="full" className="min-w-0">
      <PageTitle>{snapshot.record.title}</PageTitle>
      <PageActions>
        <Link
          to={`/p/${pid}/research`}
          className="inline-flex items-center gap-1 text-small text-accent-text hover:underline"
        >
          <ArrowLeft size={16} />
          {tr('研究列表')}
        </Link>
        <Menu
          label={tr('更多研究操作')}
          trigger={
            <Button variant="ghost" leftIcon={<Ellipsis size={16} />}>
              {tr('更多')}
            </Button>
          }
        >
          <MenuItem onSelect={() => setRecordDialog(true)}>{tr('编辑名称与问题')}</MenuItem>
          <MenuItem onSelect={() => showEvidence('findings')}>{tr('依据与分析')}</MenuItem>
          <MenuItem onSelect={() => showEvidence('history')}>{tr('历史内容')}</MenuItem>
          <MenuItem onSelect={() => setReviewOpen(true)}>{tr('请求审阅')}</MenuItem>
          {(['markdown', 'json', 'csv'] as const).map((format) => (
            <MenuItem
              key={format}
              onSelect={() => {
                window.location.href = researchApi.exportUrl(pid, recordId, format);
              }}
            >
              {tr('导出 {value}', {
                value: format === 'markdown' ? 'Markdown' : format.toUpperCase(),
              })}
            </MenuItem>
          ))}
        </Menu>
      </PageActions>
      {snapshot.offline && (
        <p role="status" className="mb-3 rounded-md bg-warning-soft p-2 text-small text-fg">
          {tr('当前离线，显示本机缓存。笔记草稿会留在本机，联网后可保存。')}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-small text-danger">
          {error}
        </p>
      )}
      {focused ? (
        <WorkspaceItemEditor
          key={focused}
          {...{
            pid,
            recordId,
            userId,
            itemId: focused,
            items: allItems,
            relations,
            writable,
            onOpen: openItem,
            onClose: closeItem,
            onCreated: openItem,
          }}
        />
      ) : (
        <>
          {snapshot.record.question && (
            <div className="mb-4 border-l-2 border-accent pl-3 text-small text-fg-muted">
              {snapshot.record.question}
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {writable && (
              <Menu
                label={tr('添加研究内容')}
                trigger={
                  <Button size="sm" variant="primary" leftIcon={<Plus size={16} />}>
                    {tr('添加')}
                  </Button>
                }
              >
                {(['draft', 'note', 'table', 'figure', 'resource', 'action', 'group'] as const).map(
                  (kind) => (
                    <MenuItem key={kind} onSelect={() => setNewKind(kind)}>
                      {LABEL[kind]}
                    </MenuItem>
                  ),
                )}
              </Menu>
            )}
            <Button
              size="sm"
              onClick={() => {
                setExecutionSelection([]);
                setExecutionOpen(true);
              }}
            >
              {tr('运行与结果')}
            </Button>
            {selected.length > 0 &&
              selected.every(
                (id) => allItems.find((item) => item.id === id)?.kind === 'action',
              ) && (
                <Button
                  size="sm"
                  onClick={() => {
                    setExecutionSelection(selected);
                    setExecutionOpen(true);
                  }}
                >
                  {tr('运行选中步骤')}
                </Button>
              )}
            <span className="flex-1" />
            {!compact && (
              <>
                <Button
                  size="sm"
                  variant={view.view === 'canvas' ? 'subtle' : 'ghost'}
                  aria-pressed={view.view === 'canvas'}
                  leftIcon={<LayoutGrid size={15} />}
                  onClick={() => updateView({ view: 'canvas' })}
                >
                  {tr('画布')}
                </Button>
                <Button
                  size="sm"
                  variant={view.view === 'list' ? 'subtle' : 'ghost'}
                  aria-pressed={view.view === 'list'}
                  leftIcon={<List size={15} />}
                  onClick={() => updateView({ view: 'list' })}
                >
                  {tr('列表')}
                </Button>
              </>
            )}
          </div>
          {items.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input
                aria-label={tr('搜索研究内容')}
                leading={<Search size={15} />}
                placeholder={tr('搜索内容')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                wrapperClassName="w-full sm:w-56"
              />
              {selected.length > 0 && (
                <span className="text-caption text-fg-muted">
                  {tr('已选 {count} 项', { count: selected.length })}
                </span>
              )}
              {writable && (
                <>
                  {selected.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setGroupDialog(true)}
                    >
                      {tr('分组')}
                    </Button>
                  )}
                  {selected.length === 2 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setRelationDialog(true)}
                    >
                      {tr('关联')}
                    </Button>
                  )}

                  <Button size="sm" variant="ghost" disabled={pending} onClick={arrange}>
                    {tr('整理布局')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<Undo2 size={15} />}
                    disabled={!undo.length || pending || layout.saving || !!layout.issues.length}
                    onClick={undoLast}
                  >
                    {tr('撤销{value}', { value: undo.at(-1) ? ` ${undo.at(-1)!.label}` : '' })}
                  </Button>
                </>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <EmptyState
              framed
              icon={Microscope}
              title={tr('开始一项研究')}
              action={
                writable ? (
                  <Button variant="primary" onClick={() => setNewKind('draft')}>
                    {tr('添加混合草稿')}
                  </Button>
                ) : undefined
              }
            />
          ) : compact || view.view === 'list' || !!search ? (
            <WorkspaceList
              items={filtered}
              all={items}
              selected={selected}
              onSelect={select}
              onOpen={openItem}
            />
          ) : (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <WorkspaceCanvas
                items={items}
                relations={relations}
                selected={selected}
                viewport={view.viewport}
                writable={writable}
                onSelect={select}
                onOpen={openItem}
                onMove={move}
                onMoveMany={(moves) => {
                  if (writable) layout.moveMany(moves);
                }}
                dataConnections={flows}
                onDataConnect={connectData}
                onDataDisconnect={disconnectData}
                onConnect={connect}
                onViewport={(viewport) => updateView({ viewport })}
              />
            </Suspense>
          )}
          {relations.length > 0 && (
            <details className="mt-4 text-small">
              <summary className="cursor-pointer text-fg-muted">
                {tr('关联 {count}', { count: relations.length })}
              </summary>
              <ul className="mt-2 space-y-1">
                {relations.map((relation) => (
                  <li key={relation.id} className="flex flex-wrap items-center gap-2">
                    {items.find((item) => item.id === relation.fromItemId)?.title} →{' '}
                    {items.find((item) => item.id === relation.toItemId)?.title}
                    {relation.label && ` · ${relation.label}`}
                    {writable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(async () => {
                            await workspaceApi.archiveRelation(
                              pid,
                              recordId,
                              relation.id,
                              relation.version,
                            );
                            rememberUndo({
                              label: tr('移除关联'),
                              apply: async () => {
                                await workspaceApi.createRelation(pid, recordId, {
                                  fromItemId: relation.fromItemId,
                                  toItemId: relation.toItemId,
                                  label: relation.label,
                                  idempotencyKey: clientId(),
                                });
                              },
                            });
                          })
                        }
                      >
                        {tr('移除')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {layout.saving && (
        <p role="status" className="mt-3 text-caption text-fg-muted">
          {tr('正在保存布局…')}
        </p>
      )}
      {layout.issues.map((issue) => (
        <div
          key={issue.id}
          role="alert"
          className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3 text-small"
        >
          <p className="text-warning">{issue.message}</p>
          {issue.positions.map((position) => (
            <p key={position.itemId} className="text-caption text-fg-muted">
              {tr('{title}：本地 ({Math}, {Math2}) · 服务器 ({Math3}, {Math4})', {
                title: position.title,
                Math: Math.round(position.local.x),
                Math2: Math.round(position.local.y),
                Math3: Math.round(position.remote.x),
                Math4: Math.round(position.remote.y),
              })}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {issue.status === 'conflict' ? (
              <>
                <Button size="sm" onClick={() => layout.resolveMine(issue.id)}>
                  {tr('保留本地位置')}
                </Button>
                <Button size="sm" onClick={() => layout.resolveTheirs(issue.id)}>
                  {tr('采用服务器位置')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => layout.retry(issue.id)}>
                {tr('重试保存布局')}
              </Button>
            )}
          </div>
        </div>
      ))}
      {flows.length > 0 && !focused && (
        <details className="mt-3 text-small">
          <summary className="cursor-pointer text-fg-muted">
            {tr('处理连接 {count}', { count: flows.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {flows.map((flow) => (
              <li key={flow.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {allItems.find((item) => item.id === flow.fromItemId)?.title} →{' '}
                  {allItems.find((item) => item.id === flow.toItemId)?.title} · {flow.inputName}
                </span>
                {writable && (
                  <Button size="sm" variant="ghost" onClick={() => disconnectData(flow.id)}>
                    {tr('移除连接')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {pendingConnection && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingConnection(null);
          }}
          title={tr('选择连接的产物类型')}
        >
          <div className="space-y-3">
            <p className="text-small text-fg-muted">
              {tr('此步骤的产物尚未指定。选择类型后会建立稳定的具名输出。')}
            </p>
            <label className="block space-y-1 text-small">
              {tr('产物类型')}
              <Select
                value={connectionKind}
                onChange={(event) =>
                  setConnectionKind(event.target.value as 'note' | 'table' | 'figure')
                }
              >
                <option value="note">{tr('笔记')}</option>
                <option value="table">{tr('数据表')}</option>
                <option value="figure">{tr('数据图表')}</option>
              </Select>
            </label>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() =>
                connectData({ ...pendingConnection, createOutputKind: connectionKind })
              }
            >
              {tr('建立连接')}
            </Button>
          </div>
        </Dialog>
      )}
      {newKind && (
        <NewItemDialog
          kind={newKind}
          pid={pid}
          pending={pending}
          onClose={() => setNewKind(null)}
          onCreate={(title, resource, key) => void create(newKind, title, resource, key)}
        />
      )}
      {groupDialog && (
        <GroupDialog
          items={items}
          selected={selected}
          onClose={() => setGroupDialog(false)}
          onGroup={group}
          pending={pending}
        />
      )}
      {relationDialog && (
        <RelationDialog
          selected={selected
            .map((id) => items.find((item) => item.id === id))
            .filter((item): item is ResearchItemSummary => !!item)}
          onClose={() => setRelationDialog(false)}
          onConnect={connect}
        />
      )}
      {recordDialog && (
        <RecordDialog
          pid={pid}
          userId={userId}
          record={snapshot.record}
          writable={writable}
          onClose={() => setRecordDialog(false)}
        />
      )}
      {reviewOpen && (
        <Suspense fallback={null}>
          <RequestReviewDialog
            open
            onOpenChange={setReviewOpen}
            defaultTarget={{ kind: 'research_record', id: recordId, title: snapshot.record.title }}
          />
        </Suspense>
      )}
      {evidenceSection && (
        <Suspense fallback={<Skeleton className="h-24" />}>
          <WorkspaceEvidenceDialog
            pid={pid}
            recordId={recordId}
            view={evidenceSection}
            writable={writable}
            onView={showEvidence}
            onClose={() => showEvidence(null)}
          />
        </Suspense>
      )}
      {executionOpen && (
        <Suspense fallback={<Skeleton className="h-24" />}>
          <WorkspaceExecution
            {...{ pid, recordId, userId, items: allItems, relations, writable }}
            initialItemIds={executionSelection}
            onClose={() => setExecutionOpen(false)}
            onOpenItem={openItem}
          />
        </Suspense>
      )}
    </Page>
  );
}

function WorkspaceList({
  items,
  all,
  selected,
  onSelect,
  onOpen,
}: {
  items: ResearchItemSummary[];
  all: ResearchItemSummary[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onOpen: (id: string) => void;
}) {
  if (!items.length)
    return <p className="py-8 text-center text-small text-fg-muted">{tr('没有匹配内容')}</p>;
  return (
    <ul
      className="divide-y divide-line rounded-lg border border-line bg-surface"
      aria-label={tr('研究内容列表')}
    >
      {items.map((item) => (
        <li key={item.id} className="flex min-w-0 items-center gap-3 px-3 py-2 hover:bg-subtle">
          <input
            type="checkbox"
            aria-label={tr('选择 {title}', { title: item.title })}
            checked={selected.includes(item.id)}
            onChange={(e) =>
              onSelect(
                e.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id),
              )
            }
          />
          <button
            type="button"
            onClick={() => onOpen(item.id)}
            className="min-w-0 flex-1 py-1 text-left"
          >
            <span className="block truncate text-small font-medium text-fg">{item.title}</span>
            <span className="block truncate text-caption text-fg-muted">
              {LABEL[item.kind]}
              {item.parentId &&
                ` · ${all.find((group) => group.id === item.parentId)?.title ?? tr('分组')}`}
              {item.preview && ` · ${item.preview}`}
            </span>
          </button>
          <Button size="sm" variant="ghost" onClick={() => onOpen(item.id)}>
            {tr('打开')}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function NewItemDialog({
  kind,
  pid,
  pending,
  onClose,
  onCreate,
}: {
  kind: ResearchItemKind;
  pid: string;
  pending: boolean;
  onClose: () => void;
  onCreate: (title: string, resource: ResearchResourceRef | null, key: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [resource, setResource] = useState<ResearchResourceRef | null>(null);
  const [key] = useState(() => clientId());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('新建{value}', { value: LABEL[kind] })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={(kind === 'resource' || kind === 'figure') && !resource?.id}
            onClick={() =>
              onCreate(
                title.trim() ||
                  (kind === 'resource'
                    ? tr('关联资料')
                    : tr('未命名{value}', { value: LABEL[kind] })),
                resource,
                key,
              )
            }
          >
            {tr('创建')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1.5 text-small">
          {tr('名称')}
          <Input
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder={tr('未命名{value}', { value: LABEL[kind] })}
          />
        </label>
        {(kind === 'resource' || kind === 'figure') && (
          <ResourcePicker
            pid={pid}
            value={resource}
            onChange={setResource}
            label={kind === 'figure' ? tr('图像文件') : tr('材料')}
            fixedKind={kind === 'figure' ? 'file' : undefined}
            allowUpload
            onUploadTitle={(name) =>
              setTitle((current) => (current.trim() ? current : name.slice(0, 200)))
            }
          />
        )}
      </div>
    </Dialog>
  );
}
function GroupDialog({
  items,
  selected,
  onClose,
  onGroup,
  pending,
}: {
  items: ResearchItemSummary[];
  selected: string[];
  onClose: () => void;
  onGroup: (id: string) => void;
  pending: boolean;
}) {
  const [group, setGroup] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('移动到分组')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button variant="primary" loading={pending} onClick={() => onGroup(group)}>
            {tr('应用')}
          </Button>
        </>
      }
    >
      <Select aria-label={tr('选择分组')} value={group} onChange={(e) => setGroup(e.target.value)}>
        <option value="">{tr('移出分组')}</option>
        {items
          .filter((item) => item.kind === 'group' && !selected.includes(item.id))
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
      </Select>
    </Dialog>
  );
}
function RelationDialog({
  selected,
  onClose,
  onConnect,
}: {
  selected: ResearchItemSummary[];
  onClose: () => void;
  onConnect: (from: string, to: string, label: string) => void;
}) {
  const [from, setFrom] = useState(selected[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const to = selected.find((item) => item.id !== from)?.id ?? '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('关联内容')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('取消')}
          </Button>
          <Button variant="primary" onClick={() => onConnect(from, to, label)}>
            {tr('建立关联')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select aria-label={tr('关联起点')} value={from} onChange={(e) => setFrom(e.target.value)}>
          {selected.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <p className="text-small text-fg-muted">
          {tr('关联到：{title}', { title: selected.find((item) => item.id === to)?.title })}
        </p>
        <Input
          aria-label={tr('关联说明')}
          value={label}
          maxLength={200}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={tr('关系说明（可选）')}
        />
      </div>
    </Dialog>
  );
}
type RecordInfoDraft = {
  title: string;
  question: string;
  baseVersion: number;
  backup?: { title: string; question: string };
};
function RecordDialog({
  pid,
  userId,
  record,
  writable,
  onClose,
}: {
  pid: string;
  userId: string;
  record: WorkspaceSnapshot['record'];
  writable: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = `${workspaceStorageKey(userId, pid, record.id)}:record-draft`;
  const [draft, setDraft] = useState<RecordInfoDraft>(
    () =>
      readLocal<RecordInfoDraft>(key) ?? {
        title: record.title,
        question: record.question,
        baseVersion: record.version,
      },
  );
  const [conflict, setConflict] = useState<WorkspaceSnapshot['record'] | null>(() =>
    draft.baseVersion !== record.version ? record : null,
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const edit = (patch: Partial<RecordInfoDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!writeLocal(key, next)) setError(tr('无法保存本机草稿，请保持页面打开。'));
  };
  const save = async (base = draft.baseVersion) => {
    setPending(true);
    setError('');
    try {
      await researchApi.updateRecord(pid, record.id, {
        baseVersion: base,
        title: draft.title.trim(),
        question: draft.question,
      });
      writeLocal(key, null);
      await qc.invalidateQueries({ queryKey: researchKey(pid) });
      onClose();
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409 && cause.details?.current) {
        setConflict(cause.details.current as WorkspaceSnapshot['record']);
        setError(tr('研究信息已被其他人修改，请比较后选择。'));
      } else setError(cause instanceof Error ? cause.message : tr('没有保存，请重试。'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('研究信息')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('关闭')}
          </Button>
          {writable && (
            <Button
              variant="primary"
              disabled={!draft.title.trim() || !!conflict}
              loading={pending}
              onClick={() => void save()}
            >
              {tr('保存')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1.5 text-small">
          {tr('名称')}
          <Input
            value={draft.title}
            disabled={!writable}
            maxLength={200}
            onChange={(e) => edit({ title: e.target.value })}
          />
        </label>
        <label className="block space-y-1.5 text-small">
          {tr('研究问题')}
          <Textarea
            value={draft.question}
            disabled={!writable}
            rows={4}
            onChange={(e) => edit({ question: e.target.value })}
          />
        </label>
        {conflict && (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-warning bg-warning-soft p-3 text-small"
          >
            <p>{tr('服务器版本已变化，本机草稿仍保留。')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <b>{tr('本机草稿')}</b>
                <p className="whitespace-pre-wrap">
                  {draft.title}
                  {'\n'}
                  {draft.question}
                </p>
              </div>
              <div>
                <b>{tr('服务器版本')}</b>
                <p className="whitespace-pre-wrap">
                  {conflict.title}
                  {'\n'}
                  {conflict.question}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  edit({
                    title: conflict.title,
                    question: conflict.question,
                    baseVersion: conflict.version,
                    backup: { title: draft.title, question: draft.question },
                  });
                  setConflict(null);
                }}
              >
                {tr('采用服务器版本')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save(conflict.version)}>
                {tr('用本机草稿保存')}
              </Button>
            </div>
          </div>
        )}
        {draft.backup && !conflict && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              edit({
                title: draft.backup!.title,
                question: draft.backup!.question,
                backup: { title: draft.title, question: draft.question },
              })
            }
          >
            {tr('恢复冲突前草稿')}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
