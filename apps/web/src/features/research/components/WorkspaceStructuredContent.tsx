import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { accessAtLeast } from '@srh/shared';
import type {
  DocumentMeta,
  EvidenceExcerpt,
  ResearchArtifactVersion,
  ResearchDraftBlock,
  ResearchItem,
  ResearchItemPayload,
  ResearchItemSummary,
  ResearchResourceRef,
  ResearchTableColumn,
} from '@srh/shared';
import { Button, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { clientId } from '@/lib/client-id';
import { useCollabDoc } from '@/features/docs/collab/useCollabDoc';
import { effectiveAccess } from '@/features/sharing/api';
import { researchApi } from '../data';
import { lineageCurrentState } from '../lib/workspace-lineage';
import {
  clearClosedTableSessions,
  clearOrphanedTableSessions,
  clearTablePending,
  closeTableSession,
  markTablePending,
  rememberTableSynced,
  tableSyncKey,
  tableSyncLockName,
} from '../lib/workspace-table-sync';
import { contentApi } from '../content-data';
import { ResourcePicker } from './ResourcePicker';
import { locale, tr } from '@/lib/i18n';

const SheetEditor = lazy(() =>
  import('@/features/docs/editors/sheet').then((m) => ({ default: m.SheetEditor })),
);
type DraftPayload = Extract<ResearchItemPayload, { kind: 'draft' }>;
type TablePayload = Extract<ResearchItemPayload, { kind: 'table' }>;
type FigurePayload = Extract<ResearchItemPayload, { kind: 'figure' }>;

export function DraftContent({
  pid,
  recordId,
  payload,
  disabled,
  onChange,
  focusBlockId,
  focusStart,
  focusEnd,
}: {
  pid: string;
  recordId: string;
  payload: DraftPayload;
  disabled: boolean;
  onChange: (payload: DraftPayload) => void;
  focusBlockId?: string | null;
  focusStart?: number;
  focusEnd?: number;
}) {
  const [resource, setResource] = useState<ResearchResourceRef | null>(null);
  const blocksRef = useRef(new Map<string, HTMLElement>());
  const fieldsRef = useRef(new Map<string, HTMLTextAreaElement>());
  useEffect(() => {
    if (!focusBlockId) return;
    blocksRef.current.get(focusBlockId)?.scrollIntoView({ block: 'center' });
    const field = fieldsRef.current.get(focusBlockId);
    if (
      field &&
      Number.isInteger(focusStart) &&
      Number.isInteger(focusEnd) &&
      focusStart! >= 0 &&
      focusEnd! > focusStart! &&
      focusEnd! <= field.value.length
    ) {
      field.focus();
      field.setSelectionRange(focusStart!, focusEnd!);
    }
  }, [focusBlockId, focusStart, focusEnd]);
  const [excerptId, setExcerptId] = useState('');
  const excerpts = useQuery({
    queryKey: ['p', pid, 'research', 'record', recordId, 'excerpts'],
    queryFn: ({ signal }) => researchApi.excerpts(pid, recordId, signal),
  });
  const update = (blocks: ResearchDraftBlock[]) => onChange({ kind: 'draft', blocks });
  const resourceHref = (resource: ResearchResourceRef) =>
    resource.kind === 'file'
      ? contentApi.fileUrl(pid, resource.id)
      : resource.kind === 'document'
        ? `/p/${encodeURIComponent(pid)}/docs/${encodeURIComponent(resource.id)}`
        : resource.kind === 'link' && /^https?:\/\//iu.test(resource.id)
          ? resource.id
          : null;
  const replace = (index: number, block: ResearchDraftBlock) =>
    update(payload.blocks.map((old, i) => (i === index ? block : old)));
  const move = (index: number, direction: -1 | 1) => {
    const blocks = [...payload.blocks];
    const other = index + direction;
    if (other < 0 || other >= blocks.length) return;
    [blocks[index], blocks[other]] = [blocks[other]!, blocks[index]!];
    update(blocks);
  };
  return (
    <div className="space-y-4">
      <p className="text-small text-fg-muted">
        {tr('按顺序收集文字、材料和固定摘录。处理步骤可选择全部或部分内容块。')}
      </p>
      {!payload.blocks.length && <p className="text-small text-fg-muted">{tr('还没有内容块')}</p>}
      {focusBlockId && !payload.blocks.some((block) => block.id === focusBlockId) && (
        <p role="status" className="text-small text-warning">
          {tr('原内容块已变化或不可用，请查看固定来源。')}
        </p>
      )}
      {payload.blocks.map((block, index) => (
        <section
          key={block.id}
          ref={(element) => {
            if (element) blocksRef.current.set(block.id, element);
            else blocksRef.current.delete(block.id);
          }}
          className={`space-y-2 rounded-lg border p-3 ${focusBlockId === block.id ? 'border-accent' : 'border-line'}`}
          aria-label={tr('内容块 {value}', { value: index + 1 })}
        >
          <div className="flex flex-wrap items-center gap-2 text-small">
            <strong>
              {tr('第 ')}
              {index + 1}
              {tr(' 块 ·')}{' '}
              {block.kind === 'text'
                ? tr('文字')
                : block.kind === 'resource'
                  ? tr('材料')
                  : tr('摘录')}
            </strong>
            {block.kind === 'resource' && (
              <span className="text-fg-muted">{tr('引用原材料，未保存原件副本')}</span>
            )}
            {!disabled && (
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  {tr('上移')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === payload.blocks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  {tr('下移')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update(payload.blocks.filter((_, i) => i !== index))}
                >
                  {tr('删除')}
                </Button>
              </div>
            )}
          </div>
          {block.kind === 'text' ? (
            <Textarea
              ref={(element) => {
                if (element) fieldsRef.current.set(block.id, element);
                else fieldsRef.current.delete(block.id);
              }}
              aria-label={tr('第 {value} 块文字', { value: index + 1 })}
              rows={4}
              readOnly={disabled}
              value={block.text}
              onChange={(event) => replace(index, { ...block, text: event.target.value })}
            />
          ) : block.kind === 'resource' ? (
            <>
              <p className="text-small">
                {block.title || `${block.resource.kind} · ${block.resource.id}`}
                {resourceHref(block.resource) && (
                  <a
                    className="ml-2 text-accent-text hover:underline"
                    href={resourceHref(block.resource)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tr('打开原材料')}
                  </a>
                )}
              </p>
              <DraftResourceControl
                pid={pid}
                resource={block.resource}
                disabled={disabled}
                label={tr('第 {value} 块材料', { value: index + 1 })}
                onChange={(value) =>
                  replace(index, { ...block, resource: value, title: undefined })
                }
              />
            </>
          ) : (
            <ExcerptBlock
              pid={pid}
              excerpt={excerpts.data?.find((entry) => entry.id === block.excerptId)}
            />
          )}
        </section>
      ))}
      {!disabled && (
        <div className="space-y-3">
          <Button
            size="sm"
            onClick={() => update([...payload.blocks, { id: clientId(), kind: 'text', text: '' }])}
          >
            {tr('添加文字')}
          </Button>
          <div className="space-y-2">
            <span className="text-small font-medium">{tr('添加材料或链接')}</span>
            <ResourcePicker
              pid={pid}
              value={resource}
              onChange={setResource}
              label={tr('添加材料')}
              allowUpload
            />
            <Button
              size="sm"
              disabled={!resource?.id}
              onClick={() => {
                if (resource?.id) {
                  update([...payload.blocks, { id: clientId(), kind: 'resource', resource }]);
                  setResource(null);
                }
              }}
            >
              {tr('加入草稿')}
            </Button>
          </div>
          <div className="space-y-2">
            <label className="block text-small font-medium" htmlFor="draft-excerpt">
              {tr('添加已有摘录')}
            </label>
            <Select
              id="draft-excerpt"
              value={excerptId}
              onChange={(event) => setExcerptId(event.target.value)}
            >
              <option value="">
                {excerpts.isPending
                  ? tr('正在加载…')
                  : excerpts.isError
                    ? tr('摘录加载失败')
                    : tr('选择摘录')}
              </option>
              {excerpts.data?.map((excerpt) => (
                <option value={excerpt.id} key={excerpt.id}>
                  {excerpt.quote.slice(0, 100)}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={!excerptId}
              onClick={() => {
                update([...payload.blocks, { id: clientId(), kind: 'excerpt', excerptId }]);
                setExcerptId('');
              }}
            >
              {tr('加入摘录')}
            </Button>
            {excerpts.isError && (
              <Button size="sm" variant="ghost" onClick={() => void excerpts.refetch()}>
                {tr('重试')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftResourceControl({
  pid,
  resource,
  disabled,
  label,
  onChange,
}: {
  pid: string;
  resource: ResearchResourceRef;
  disabled: boolean;
  label: string;
  onChange: (resource: ResearchResourceRef) => void;
}) {
  const [candidate, setCandidate] = useState<ResearchResourceRef | null>(resource);
  const changed =
    !!candidate?.id && (candidate.id !== resource.id || candidate.kind !== resource.kind);
  return (
    <div className="space-y-2">
      <ResourcePicker
        pid={pid}
        value={candidate}
        disabled={disabled}
        label={label}
        onChange={setCandidate}
      />
      {!disabled && changed && (
        <Button
          size="sm"
          onClick={() => {
            if (candidate?.id) onChange(candidate);
          }}
        >
          {tr('替换材料')}
        </Button>
      )}
    </div>
  );
}

function ExcerptBlock({ pid, excerpt }: { pid: string; excerpt?: EvidenceExcerpt }) {
  if (!excerpt) return <p className="text-small text-fg-muted">{tr('摘录不可用，请检查来源。')}</p>;
  const locator =
    excerpt.locator.kind === 'pdf'
      ? tr('第 {page} 页', { page: excerpt.locator.page })
      : excerpt.locator.kind === 'text'
        ? tr('第 {paragraph} 段', { paragraph: excerpt.locator.paragraph })
        : excerpt.locator.kind === 'sheet'
          ? `${excerpt.locator.sheet}!${excerpt.locator.range}`
          : excerpt.locator.note;
  return (
    <div className="space-y-1 text-small">
      <p className="whitespace-pre-wrap">{excerpt.quote}</p>
      <p className="text-caption text-fg-muted">
        {locator} · {excerpt.verification === 'verified' ? tr('与保存快照匹配') : tr('待核对')}
        {tr(' · 快照')} {excerpt.snapshotId}
      </p>
      <Link
        className="text-accent-text hover:underline"
        to={`/p/${pid}/research-sources/${excerpt.sourceId}`}
      >
        {tr('查看原材料与引用版本')}
      </Link>
    </div>
  );
}

export function TableContent({
  pid,
  recordId,
  userId,
  item,
  items,
  payload,
  disabled,
  onChange,
  onOpen,
}: {
  pid: string;
  recordId: string;
  userId: string;
  item: ResearchItem;
  items: ResearchItemSummary[];
  payload: TablePayload;
  disabled: boolean;
  onChange: (payload: TablePayload) => void;
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
}) {
  const [lineageOpen, setLineageOpen] = useState(false);
  const [lineageLimit, setLineageLimit] = useState(50);
  const documentId = item.resource?.kind === 'document' ? item.resource.id : '';
  const table = useQuery({
    queryKey: ['p', pid, 'research', recordId, 'table', item.id, payload.sheetId],
    queryFn: ({ signal }) =>
      contentApi.table(pid, recordId, item.id, { sheetId: payload.sheetId, limit: 1, signal }),
    enabled: !!documentId,
  });
  const lineage = payload.lineage ?? [];
  const excerpts = useQuery({
    queryKey: ['p', pid, 'research', 'record', recordId, 'excerpts'],
    queryFn: ({ signal }) => researchApi.excerpts(pid, recordId, signal),
    enabled: lineage.some((entry) => entry.excerptId),
  });
  const lineagePages = useInfiniteQuery({
    queryKey: ['p', pid, 'research', recordId, 'table-lineage', item.id, payload.sheetId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      contentApi.table(pid, recordId, item.id, {
        sheetId: payload.sheetId,
        cursor: pageParam,
        limit: 200,
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!documentId && lineageOpen,
  });
  const pages = lineagePages.data?.pages ?? [];
  const consistent = pages.every((page) => page.hash === pages[0]?.hash);
  const currentRows = consistent ? pages.flatMap((page) => page.rows) : [];
  const rowNumbers = new Map(currentRows.map((row, index) => [row.id, index + 2]));
  const rowsById = new Map(currentRows.map((row) => [row.id, row]));
  const columns =
    table.data?.columns.map((column) => ({
      ...column,
      ...payload.columns?.find((entry) => entry.id === column.id),
      name: column.name,
    })) ??
    payload.columns ??
    [];
  const patchColumn = (column: ResearchTableColumn) => {
    const current = payload.columns ?? [];
    onChange({
      ...payload,
      columns: [...current.filter((entry) => entry.id !== column.id), column],
    });
  };
  return (
    <div className="space-y-4">
      <TableOrigin pid={pid} recordId={recordId} itemId={item.id} />
      {documentId && (
        <a
          className="text-small text-accent-text hover:underline"
          href={contentApi.tableExportUrl(pid, recordId, item.id, payload.sheetId)}
        >
          {tr('下载当前表格 CSV')}
        </a>
      )}
      {!documentId ? (
        <p role="alert" className="text-small text-danger">
          {tr('工作簿不可用，请检查表格来源。')}
        </p>
      ) : (
        <CollaborativeTable
          pid={pid}
          documentId={documentId}
          disabled={disabled}
          pendingKey={tableSyncKey(userId, pid, recordId, item.id)}
        />
      )}
      {table.isError && (
        <p role="alert" className="text-small text-danger">
          {tr('列信息没有加载出来。')}
          <Button size="sm" variant="ghost" onClick={() => void table.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-small font-medium">
          {tr('列说明、单位与缺失值')}
        </summary>
        <div className="mt-3 space-y-3">
          <Button size="sm" variant="ghost" onClick={() => void table.refetch()}>
            {tr('刷新表格列')}
          </Button>
          {!columns.length && (
            <p className="text-small text-fg-muted">{tr('在表格首行填写列名后，可设置列说明。')}</p>
          )}
          {columns.map((column) => (
            <div
              key={column.id}
              className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2"
            >
              <strong className="break-words text-small sm:col-span-2">{column.name}</strong>
              <label className="space-y-1 text-small">
                {tr('类型')}
                <Select
                  value={column.type ?? 'text'}
                  disabled={disabled}
                  onChange={(e) =>
                    patchColumn({ ...column, type: e.target.value as ResearchTableColumn['type'] })
                  }
                >
                  <option value="text">{tr('文字')}</option>
                  <option value="number">{tr('数字')}</option>
                  <option value="boolean">{tr('布尔值')}</option>
                  <option value="date">{tr('日期')}</option>
                </Select>
              </label>
              <label className="space-y-1 text-small">
                {tr('单位')}
                <Input
                  value={column.unit ?? ''}
                  disabled={disabled}
                  onChange={(e) => patchColumn({ ...column, unit: e.target.value })}
                />
              </label>
              <label className="space-y-1 text-small">
                {tr('列说明')}
                <Input
                  value={column.description ?? ''}
                  disabled={disabled}
                  onChange={(e) => patchColumn({ ...column, description: e.target.value })}
                />
              </label>
              <label className="space-y-1 text-small">
                {tr('缺失值标记（逗号分隔）')}
                <MissingValueInput
                  values={column.missingValues ?? []}
                  disabled={disabled}
                  onChange={(missingValues) => patchColumn({ ...column, missingValues })}
                />
              </label>
            </div>
          ))}
        </div>
      </details>
      {!!lineage.length && (
        <details onToggle={(event) => setLineageOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-small font-medium">
            {tr('单元格来源与待核对项')}
          </summary>
          <p className="mt-2 text-caption text-fg-muted">
            {tr(
              '定位匹配只表示摘录可在当时的来源中找到；固定运行快照保留当时依据。修改表格后可重新读取当前值。',
            )}
          </p>
          {lineageOpen && (
            <>
              {lineagePages.isPending && (
                <p className="text-caption text-fg-muted">{tr('正在读取当前表格以核对…')}</p>
              )}
              {lineagePages.isError && (
                <p role="alert" className="text-danger">
                  {tr('无法读取当前表格。')}
                  <Button size="sm" variant="ghost" onClick={() => void lineagePages.refetch()}>
                    {tr('重试')}
                  </Button>
                </p>
              )}
              {!consistent && (
                <p role="alert" className="text-danger">
                  {tr('读取期间表格发生变化，请重新读取后核对。')}
                  <Button size="sm" variant="ghost" onClick={() => void lineagePages.refetch()}>
                    {tr('重新读取')}
                  </Button>
                </p>
              )}
              <ul className="mt-2 space-y-2 text-small">
                {lineage.slice(0, lineageLimit).map((source, index) => {
                  const locator =
                    source.locator && typeof source.locator === 'object'
                      ? (source.locator as { start?: unknown; end?: unknown; cellValue?: unknown })
                      : null;
                  const row = rowsById.get(source.rowId);
                  const changed = lineageCurrentState(source, row) === 'modified';
                  const status = changed
                    ? tr('已修改，待核对')
                    : source.verification === 'matched'
                      ? tr('来源摘录与原文匹配，单元格值仍需核对')
                      : tr('来源待核对');
                  return (
                    <li
                      key={`${source.rowId}:${source.columnId}:${index}`}
                      className="rounded-md border border-line p-2"
                    >
                      {tr('行 ')}
                      {rowNumbers.get(source.rowId) ?? tr('标识 {rowId}', { rowId: source.rowId })}
                      {tr(' · 列')}{' '}
                      {columns.find((c) => c.id === source.columnId)?.name ?? source.columnId} ·{' '}
                      {status}
                      {!row && <span>{tr(' · 当前行尚未读取')}</span>}
                      {source.blockId && (
                        <span className="break-all">
                          {tr(' · 草稿块 {blockId}', { blockId: source.blockId })}
                        </span>
                      )}
                      {source.quote && <p className="whitespace-pre-wrap">{source.quote}</p>}
                      {source.itemId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const start =
                              typeof locator?.start === 'number' ? locator.start : undefined;
                            const end = typeof locator?.end === 'number' ? locator.end : undefined;
                            const sourceKind = items.find(
                              (entry) => entry.id === source.itemId,
                            )?.kind;
                            const segment =
                              source.blockId || sourceKind !== 'resource' || start === undefined
                                ? 0
                                : Math.floor(start / 20000) * 20000;
                            onOpen(source.itemId!, {
                              blockId: source.blockId,
                              segment,
                              ...(start === undefined ? {} : { start: start - segment }),
                              ...(end === undefined ? {} : { end: end - segment }),
                            });
                          }}
                        >
                          {tr('查看原文位置')}
                        </Button>
                      )}
                      {source.excerptId &&
                        (() => {
                          const excerpt = excerpts.data?.find(
                            (entry) => entry.id === source.excerptId,
                          );
                          return excerpt ? (
                            <Link
                              className="ml-2 text-accent-text hover:underline"
                              to={`/p/${pid}/research-sources/${excerpt.sourceId}`}
                            >
                              {tr('查看摘录来源')}
                            </Link>
                          ) : null;
                        })()}
                    </li>
                  );
                })}
              </ul>
              {lineage.length > lineageLimit && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLineageLimit((limit) => limit + 50)}
                >
                  {tr('加载更多来源')}
                </Button>
              )}
              {lineagePages.data && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={lineagePages.isFetching}
                  onClick={() => void lineagePages.refetch()}
                >
                  {tr('重新读取当前值')}
                </Button>
              )}
              {lineagePages.hasNextPage && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={lineagePages.isFetchingNextPage || !consistent}
                  onClick={() => void lineagePages.fetchNextPage()}
                >
                  {tr('读取更多表格行以核对')}
                </Button>
              )}
            </>
          )}
        </details>
      )}
      <ArtifactHistory
        pid={pid}
        recordId={recordId}
        itemId={item.id}
        producer={items.find((entry) => entry.id === item.id)}
      />
    </div>
  );
}

function MissingValueInput({
  values,
  disabled,
  onChange,
}: {
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const serialized = values.join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? serialized}
      disabled={disabled}
      onFocus={() => setDraft(serialized)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = event.currentTarget.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        setDraft(null);
        if (JSON.stringify(next) !== JSON.stringify(values)) onChange(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function TableOrigin({ pid, recordId, itemId }: { pid: string; recordId: string; itemId: string }) {
  const versions = useQuery({
    queryKey: ['p', pid, 'research', recordId, 'artifacts', itemId, 'origin'],
    queryFn: async ({ signal }) => {
      const seen: ResearchArtifactVersion[] = [];
      let cursor: string | undefined;
      do {
        const page = await contentApi.artifacts(pid, recordId, itemId, cursor, signal);
        seen.push(...page.items);
        if (seen.some((version) => version.origin === 'ai_draft' && version.stepId)) break;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return seen;
    },
  });
  if (versions.isPending)
    return <p className="text-caption text-fg-muted">{tr('正在读取表格来源…')}</p>;
  if (versions.isError)
    return (
      <p role="alert" className="text-small text-danger">
        {tr('无法读取表格来源与确认状态。')}
        <Button size="sm" variant="ghost" onClick={() => void versions.refetch()}>
          {tr('重试')}
        </Button>
      </p>
    );
  if (!versions.data.some((version) => version.origin === 'ai_draft' && version.stepId))
    return null;
  const confirmed = versions.data.some(
    (version) => version.origin === 'member_report' && version.stepId,
  );
  return (
    <p className="rounded-md bg-subtle p-2 text-small text-fg-muted">
      {tr('AI 来源 · ')}
      {confirmed ? tr('存在人工确认版本；当前表格可能继续修改') : tr('未人工确认')}
      {tr('。来源定位与人工确认分别记录。')}
    </p>
  );
}

function CollaborativeTable({
  pid,
  documentId,
  disabled,
  pendingKey,
}: {
  pid: string;
  documentId: string;
  disabled: boolean;
  pendingKey: string;
}) {
  const meta = useQuery({
    queryKey: ['p', pid, 'research-table-document', documentId],
    queryFn: ({ signal }) =>
      api.get<DocumentMeta>(`/projects/${pid}/docs/${documentId}`, { signal }),
  });
  const collab = useCollabDoc(documentId);
  const provider = collab?.provider;
  const localLoaded = collab?.localLoaded ?? false;
  const localLoadedRef = useRef(false);
  const reconcileRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    localLoadedRef.current = localLoaded;
    reconcileRef.current?.();
  }, [localLoaded]);
  useEffect(() => {
    if (!provider || disabled) return;
    const session = provider.sessionId;
    let active = true;
    let lockHeld = false;
    let releaseLock: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const mark = () =>
      markTablePending(
        pendingKey,
        session,
        Y.encodeSnapshot(Y.snapshot(provider.document)),
        lockHeld,
      );
    if (navigator.locks) {
      void navigator.locks
        .request(tableSyncLockName(pendingKey, session), { ifAvailable: true }, async (lock) => {
          if (!lock || !active) return;
          lockHeld = true;
          if (provider.unsyncedChanges > 0) mark();
          await held;
        })
        .catch(() => undefined);
    }
    const safe = () =>
      provider.isSynced &&
      provider.unsyncedChanges === 0 &&
      provider.configuration.websocketProvider.status === 'connected' &&
      navigator.onLine !== false;
    const reconcile = () => {
      if (!active) return;
      if (provider.unsyncedChanges > 0) mark();
      else if (safe() && localLoadedRef.current) {
        const vector = Y.encodeSnapshot(Y.snapshot(provider.document));
        rememberTableSynced(pendingKey, vector);
        clearTablePending(pendingKey, session);
        clearClosedTableSessions(pendingKey, session, vector);
        void clearOrphanedTableSessions(pendingKey, session, vector);
      }
    };
    reconcileRef.current = reconcile;
    const onUnsynced = ({ number }: { number: number }) => {
      if (number > 0) mark();
      else reconcile();
    };
    provider.on('unsyncedChanges', onUnsynced);
    provider.on('synced', reconcile);
    provider.on('status', reconcile);
    reconcile();
    return () => {
      active = false;
      closeTableSession(pendingKey, session);
      releaseLock?.();
      reconcileRef.current = null;
      provider.off('unsyncedChanges', onUnsynced);
      provider.off('synced', reconcile);
      provider.off('status', reconcile);
    };
  }, [provider, pendingKey, disabled]);
  if ((!meta.data && meta.isError) || collab?.status === 'denied')
    return (
      <div role="alert" className="text-small text-danger">
        {tr('无法连接协作表格。')}
        <Button size="sm" variant="ghost" onClick={() => void meta.refetch()}>
          {tr('重试')}
        </Button>
      </div>
    );
  if (!meta.data || !collab || !(collab.ready ?? collab.synced))
    return <Skeleton className="h-64" />;
  if (meta.data.kind !== 'sheet')
    return (
      <p role="alert" className="text-small text-danger">
        {tr('关联的文档不是表格。')}
      </p>
    );
  const syncLabel =
    collab.sync === 'offline'
      ? tr('离线，本机表格修改等待同步')
      : collab.sync === 'reconnecting'
        ? tr('连接中断，正在重连')
        : collab.sync === 'unsynced' || (collab.unsynced ?? 0) > 0
          ? tr('表格修改尚未同步')
          : collab.sync === 'synced'
            ? tr('表格已同步')
            : tr('正在连接表格');
  return (
    <div className="space-y-2">
      <p role="status" className="text-caption text-fg-muted">
        {syncLabel}
      </p>
      <div className="flex h-[500px] min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line">
        <Suspense fallback={<Skeleton className="h-64" />}>
          <SheetEditor
            projectId={pid}
            docId={documentId}
            meta={meta.data}
            collab={collab}
            editable={
              accessAtLeast(effectiveAccess(meta.data.access, !disabled), 'edit') &&
              !meta.data.archivedAt
            }
          />
        </Suspense>
      </div>
    </div>
  );
}

export function FigureContent({
  pid,
  recordId,
  item,
  items,
  payload,
  disabled,
  onChange,
}: {
  pid: string;
  recordId: string;
  item: ResearchItem;
  items: ResearchItemSummary[];
  payload: FigurePayload;
  disabled: boolean;
  onChange: (payload: FigurePayload) => void;
}) {
  const [imageError, setImageError] = useState(false);
  const fileId =
    payload.svgFileId ??
    payload.pngFileId ??
    (item.resource?.kind === 'file' ? item.resource.id : undefined);
  const data = useQuery({
    queryKey: ['p', pid, 'research-artifact', payload.dataArtifactId],
    queryFn: ({ signal }) => contentApi.artifact(pid, payload.dataArtifactId!, signal),
    enabled: !!payload.dataArtifactId,
  });
  return (
    <div className="space-y-4">
      {fileId ? (
        <>
          <img
            src={contentApi.fileUrl(pid, fileId)}
            alt={payload.caption || item.title}
            className="max-h-[60vh] max-w-full object-contain"
            onError={() => setImageError(true)}
          />
          {imageError && (
            <p role="alert" className="text-small text-danger">
              {tr('无法预览图像，请检查文件是否可用。')}
            </p>
          )}
          <div className="flex gap-3 text-small">
            {payload.svgFileId && (
              <a
                className="text-accent-text hover:underline"
                href={contentApi.fileUrl(pid, payload.svgFileId, true)}
              >
                {tr('下载 SVG')}
              </a>
            )}
            {payload.pngFileId && (
              <a
                className="text-accent-text hover:underline"
                href={contentApi.fileUrl(pid, payload.pngFileId, true)}
              >
                {tr('下载 PNG')}
              </a>
            )}
            {!payload.svgFileId && !payload.pngFileId && (
              <a
                className="text-accent-text hover:underline"
                href={contentApi.fileUrl(pid, fileId, true)}
              >
                {tr('下载原图')}
              </a>
            )}
          </div>
        </>
      ) : (
        <p className="text-small text-fg-muted">{tr('图像文件不可用')}</p>
      )}
      <label className="block space-y-1 text-small">
        {tr('图注')}
        <Textarea
          rows={3}
          value={payload.caption ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ ...payload, caption: e.target.value })}
        />
      </label>
      {payload.chart && (
        <p className="text-small text-fg-muted">
          {
            ({ bar: tr('柱状图'), line: tr('折线图'), scatter: tr('散点图') } as const)[
              payload.chart.kind
            ]
          }
          {tr(' · 横轴 ')}
          {payload.chart.xLabel || payload.chart.xColumn}
          {tr(' · 纵轴')} {payload.chart.yLabel || payload.chart.yColumns.join(tr('、'))}
          {tr(' · 缺失值')}
          {payload.chart.missing === 'omit' ? tr('忽略') : tr('报错')}
        </p>
      )}
      {payload.dataArtifactId && (
        <p className="text-small text-fg-muted">
          {tr('固定数据：')}
          {data.isPending
            ? tr('正在读取…')
            : data.isError
              ? tr('不可用')
              : tr('第 {value} 版 · {value2}', {
                  value: data.data?.version ?? tr('未知'),
                  value2: data.data?.summary ?? '',
                })}{' '}
          {data.data && (
            <a
              href={contentApi.artifactUrl(pid, data.data.id)}
              className="text-accent-text hover:underline"
            >
              {tr('下载数据快照')}
            </a>
          )}
        </p>
      )}
      <ArtifactHistory
        pid={pid}
        recordId={recordId}
        itemId={item.id}
        producer={items.find((entry) => entry.id === item.id)}
      />
    </div>
  );
}

export function ArtifactHistory({
  pid,
  recordId,
  itemId,
  producer,
  isStep = false,
}: {
  pid: string;
  recordId: string;
  itemId: string;
  producer?: Pick<ResearchItemSummary, 'producerStepId' | 'producerOutputKey'> | undefined;
  isStep?: boolean;
}) {
  return (
    <div className="space-y-2">
      <ArtifactHistoryList
        pid={pid}
        recordId={recordId}
        itemId={itemId}
        title={isStep ? tr('历史产物版本') : tr('本条目版本与人工确认')}
      />
      {producer?.producerStepId && producer.producerOutputKey && (
        <ArtifactHistoryList
          pid={pid}
          recordId={recordId}
          itemId={producer.producerStepId}
          outputKey={producer.producerOutputKey}
          title={tr('该步骤同输出历史')}
        />
      )}
    </div>
  );
}

function ArtifactHistoryList({
  pid,
  recordId,
  itemId,
  outputKey,
  title,
}: {
  pid: string;
  recordId: string;
  itemId: string;
  outputKey?: string | undefined;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ResearchArtifactVersion | null>(null);
  const versions = useInfiniteQuery({
    queryKey: ['p', pid, 'research', recordId, 'artifacts', itemId, 'pages'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      contentApi.artifacts(pid, recordId, itemId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
  });
  const artifacts = (versions.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (artifact) =>
      outputKey === undefined || (artifact.stepId === itemId && artifact.outputKey === outputKey),
  );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-small font-medium">{title}</summary>
      <div className="mt-2 space-y-2 text-small">
        {versions.isPending ? (
          tr('正在读取…')
        ) : versions.isError ? (
          <p role="alert" className="text-danger">
            {tr('历史版本不可用。')}
            <Button size="sm" variant="ghost" onClick={() => void versions.refetch()}>
              {tr('重试')}
            </Button>
          </p>
        ) : artifacts.length ? (
          artifacts.map((artifact) => (
            <div key={artifact.id} className="break-words rounded-md border border-line p-2">
              <span>
                {tr('条目 ')}
                {artifact.itemId}
                {tr(' · 条目内第 ')}
                {artifact.version}
                {tr(' 版 · 运行')} {artifact.runId ?? tr('无')} ·{' '}
                {new Date(artifact.createdAt).toLocaleString(locale())} ·{' '}
                {artifact.origin === 'ai_draft'
                  ? tr('AI 草稿，待人工确认')
                  : artifact.origin === 'computation'
                    ? tr('计算产物')
                    : tr('成员记录')}{' '}
                · {artifact.summary}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(artifact)}>
                {tr('查看固定版本')}
              </Button>
              <a
                className="ml-2 text-accent-text hover:underline"
                href={contentApi.artifactUrl(pid, artifact.id)}
              >
                {tr('下载')}
              </a>
            </div>
          ))
        ) : (
          <p className="text-fg-muted">
            {versions.hasNextPage
              ? tr('已加载的记录中没有匹配产物，可继续加载。')
              : tr('暂无历史产物')}
          </p>
        )}
        {versions.hasNextPage && (
          <Button
            size="sm"
            loading={versions.isFetchingNextPage}
            onClick={() => void versions.fetchNextPage()}
          >
            {tr('加载更多')}
          </Button>
        )}
        {selected && (
          <ArtifactVersionDetail pid={pid} artifact={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </details>
  );
}
function ArtifactVersionDetail({
  pid,
  artifact,
  onClose,
}: {
  pid: string;
  artifact: ResearchArtifactVersion;
  onClose: () => void;
}) {
  const table = useQuery({
    queryKey: ['p', pid, 'research', 'artifact-table', artifact.id],
    queryFn: ({ signal }) => contentApi.artifactTable(pid, artifact.id, signal),
    enabled: artifact.kind === 'table',
  });
  const note = useQuery({
    queryKey: ['p', pid, 'research', 'artifact-note', artifact.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(contentApi.artifactUrl(pid, artifact.id), {
        signal,
        credentials: 'include',
      });
      if (!response.ok) throw new Error(tr('无法读取固定笔记'));
      return response.text();
    },
    enabled: artifact.kind === 'note',
  });
  const tableData = table.data;
  const metadata =
    artifact.metadata && typeof artifact.metadata === 'object'
      ? (artifact.metadata as {
          action?: {
            chart?: { kind?: string; xLabel?: string; yLabel?: string; missing?: string };
          };
          pngArtifactId?: string;
        })
      : null;
  return (
    <section
      className="space-y-2 rounded-lg border border-line bg-subtle p-3"
      aria-label={tr('固定产物版本')}
    >
      <div className="flex justify-between gap-2">
        <strong>
          {tr('条目 {itemId} · 条目内第 {version} 版 · 只读', {
            itemId: artifact.itemId,
            version: artifact.version,
          })}
        </strong>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {tr('关闭')}
        </Button>
      </div>
      <p>
        {tr('来源：')}
        {artifact.origin === 'ai_draft'
          ? tr('AI 草稿，待人工确认')
          : artifact.origin === 'computation'
            ? tr('实际计算')
            : tr('成员记录')}{' '}
        {tr('· 运行 ')}
        {artifact.runId ?? tr('无')} · {new Date(artifact.createdAt).toLocaleString(locale())}
      </p>
      {artifact.kind === 'figure' && (
        <>
          <img
            src={contentApi.artifactPreviewUrl(pid, artifact.id)}
            alt={tr('{summary}，固定版本', { summary: artifact.summary })}
            className="max-h-[50vh] max-w-full object-contain"
          />
          {metadata?.pngArtifactId && (
            <a
              href={contentApi.artifactUrl(pid, metadata.pngArtifactId)}
              className="text-accent-text hover:underline"
            >
              {tr('下载此版本 PNG')}
            </a>
          )}
          {metadata?.action?.chart && (
            <p>
              {tr('图表配置：')}
              {metadata.action.chart.kind}
              {tr(' · 横轴')} {metadata.action.chart.xLabel || tr('使用列名')}
              {tr(' · 纵轴')} {metadata.action.chart.yLabel || tr('使用列名')}
              {tr(' · 缺失值')}{' '}
              {metadata.action.chart.missing === 'error' ? tr('报错') : tr('忽略')}
            </p>
          )}
        </>
      )}
      {artifact.kind === 'note' &&
        (note.isPending ? (
          <p>{tr('正在读取固定笔记…')}</p>
        ) : note.isError ? (
          <p role="alert" className="text-danger">
            {tr('无法读取固定笔记。')}
            <Button size="sm" variant="ghost" onClick={() => void note.refetch()}>
              {tr('重试')}
            </Button>
          </p>
        ) : (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
            {note.data}
          </pre>
        ))}
      {artifact.kind === 'table' &&
        (table.isPending ? (
          <p>{tr('正在读取固定表格…')}</p>
        ) : table.isError || !tableData ? (
          <p role="alert" className="text-danger">
            {tr('无法读取固定表格。')}
            <Button size="sm" variant="ghost" onClick={() => void table.refetch()}>
              {tr('重试')}
            </Button>
          </p>
        ) : (
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  {tableData.columns.map((column) => (
                    <th className="border-b border-line p-2" key={column.id}>
                      {column.name}
                      {column.unit ? tr('（{unit}）', { unit: column.unit }) : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.rows.slice(0, 20).map((row) => (
                  <tr key={row.id}>
                    {tableData.columns.map((column) => (
                      <td className="border-b border-line p-2" key={column.id}>
                        {String(row.cells[column.id] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {tableData.totalRows > 20 && (
              <p className="text-caption text-fg-muted">
                {tr('预览前 20 行；下载可查看全部 {totalRows} 行。', {
                  totalRows: tableData.totalRows,
                })}
              </p>
            )}
          </div>
        ))}
      {!!artifact.inputs.length && (
        <div className="break-all">
          {tr('固定输入：')}
          {artifact.inputs.map((id) => (
            <a
              key={id}
              href={contentApi.artifactUrl(pid, id)}
              className="ml-2 text-accent-text hover:underline"
            >
              {id}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
