import { clientId } from '@/lib/client-id';
import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Page,
  ResearchItemSummary,
  ResearchRelation,
  ResearchRecipe,
  ResearchRun,
  ResearchRunStatus,
  ResearchRunStaleness,
  ResearchProcessingExecution,
  ResearchRunStep,
  Review,
} from '@srh/shared';
import { Button, Dialog, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { recordRoot, researchApi } from '../data';
import { draftKey, type StoredItemDraft } from '../lib/workspace-draft';
import {
  connectedFlow,
  flowDefinitions,
  itemInputIds,
  outputDependencies,
  outputSummary,
} from '../lib/workspace-flow';
import { contentApi } from '../content-data';
import { hasPendingTable, tableSyncKey } from '../lib/workspace-table-sync';
import {
  readLocal,
  workspaceApi,
  workspaceKey,
  workspaceStorageKey,
  writeLocal,
} from '../workspace-data';
import { locale, tr } from '@/lib/i18n';

const STATUS: Record<ResearchRunStatus, string> = {
  queued: tr('排队中'),
  running: tr('运行中'),
  waiting: tr('等待人工确认'),
  succeeded: tr('已完成'),
  failed: tr('失败'),
  cancelled: tr('已停止'),
  interrupted: tr('已中断'),
};
const ORIGIN = {
  ai_draft: tr('AI 草稿'),
  computation: tr('计算产物'),
  member_report: tr('成员记录'),
} as const;
const active = (status: ResearchRunStatus) => status === 'queued' || status === 'running';
const newKey = () => clientId();

export default function WorkspaceExecution({
  pid,
  recordId,
  userId,
  items,
  initialItemIds = [],
  writable,
  onClose,
  onOpenItem,
}: {
  pid: string;
  recordId: string;
  userId: string;
  items: ResearchItemSummary[];
  initialItemIds?: string[];
  relations?: ResearchRelation[];
  writable: boolean;
  onClose: () => void;
  onOpenItem: (id: string) => void;
}) {
  const qc = useQueryClient();
  const root = `${recordRoot(pid, recordId)}`;
  const runsKey = ['p', pid, 'research', 'runs', recordId] as const;
  const recipesKey = ['p', pid, 'research', 'recipes', recordId] as const;
  const runPages = useInfiniteQuery({
    queryKey: runsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      api.get<Page<ResearchRun>>(`${root}/runs`, {
        signal,
        query: { limit: 10, cursor: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some(
          (run) => active(run.status) || (run.status === 'waiting' && run.cancelRequested),
        ),
      )
        ? 2000
        : false,
  });
  const recipePages = useInfiniteQuery({
    queryKey: recipesKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      api.get<Page<ResearchRecipe>>(`${root}/recipes`, {
        signal,
        query: { limit: 10, cursor: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const runs = {
    ...runPages,
    data: runPages.data ? { items: runPages.data.pages.flatMap((page) => page.items) } : undefined,
  };
  const recipes = {
    ...recipePages,
    data: recipePages.data
      ? { items: recipePages.data.pages.flatMap((page) => page.items) }
      : undefined,
  };
  const actions = items.filter((item) => item.kind === 'action');
  const inputs = items.filter((item) => item.kind !== 'action' && item.kind !== 'group');
  const [selected, setSelected] = useState<string[]>(() =>
    initialItemIds.filter((id) => actions.some((item) => item.id === id)),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [runKey, setRunKey] = useState(newKey);
  const [instantiateKey, setInstantiateKey] = useState(newKey);
  const selectedItems = useQueries({
    queries: selected.map((id) => ({
      queryKey: ['p', pid, 'research', 'execution-item', recordId, id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        workspaceApi.item(pid, recordId, id, signal),
    })),
  });
  const tableInputIds = [
    ...new Set(
      selectedItems
        .flatMap((query) => (query.data?.action ? itemInputIds(query.data.action) : []))
        .filter((id) => items.some((item) => item.id === id && item.kind === 'table')),
    ),
  ];
  const tableQueries = useQueries({
    queries: tableInputIds.map((id) => ({
      queryKey: ['p', pid, 'research', recordId, 'preflight-table', id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        contentApi.table(pid, recordId, id, { limit: 1, signal }),
    })),
  });
  const loadingSelection =
    selectedItems.some((query) => query.isPending || query.isFetching) ||
    tableQueries.some((query) => query.isPending || query.isFetching);
  const loadedItems = selectedItems.flatMap((query) => (query.data ? [query.data] : []));
  const definitions = flowDefinitions(selected, loadedItems, {});
  const runItems = runs.data?.items ?? [];
  const recipe = recipes.data?.items.find((item) => item.id === recipeId);
  const recipeInputs = [
    ...new Set(recipe?.definitions.flatMap((definition) => itemInputIds(definition.action)) ?? []),
  ];
  const request = async (
    operation: () => Promise<unknown>,
    onFailure?: (cause: unknown, message: string) => void,
  ) => {
    setPending(true);
    setError('');
    try {
      await operation();
      await Promise.all([
        qc.invalidateQueries({ queryKey: runsKey }),
        qc.invalidateQueries({ queryKey: recipesKey }),
        qc.invalidateQueries({ queryKey: workspaceKey(pid, recordId), exact: true }),
        qc.invalidateQueries({ queryKey: ['p', pid, 'research', recordId, 'artifacts'] }),
      ]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : tr('操作没有完成，请重试。');
      setError(message);
      onFailure?.(cause, message);
    } finally {
      setPending(false);
    }
  };
  const check = () => {
    if (!selected.length) return tr('先选择要运行的操作。');
    if (
      selectedItems.some(
        (query) => query.isPending || query.isFetching || query.isError || !query.data,
      )
    )
      return tr('操作配置尚未加载，请重试。');
    if (tableQueries.some((query) => query.isError || !query.data))
      return tr('无法读取表格输入版本，请重试。');
    const loaded = selectedItems.map((query) => query.data!);
    if (loaded.some((item) => !item.action)) return tr('有操作尚未配置，请先打开操作。');
    if (loaded.some((item) => item.action?.kind === 'notebook' && !item.action.notebookId))
      return tr('Notebook 操作需要选择 Notebook。');
    const missingChart = loaded.find(
      (item) => item.action?.operation === 'chart' && !item.action.chart,
    );
    if (missingChart)
      return tr('{title} 尚未配置绘图列，请打开步骤完成配置。', { title: missingChart.title });
    const incompleteGroups = loaded.find(
      (item) =>
        item.action?.operation === 'transform_table' &&
        !!item.action.transform?.groupBy?.length &&
        !item.action.transform.aggregates?.length,
    );
    if (incompleteGroups)
      return tr('{title} 已选择分组列，请添加计数、求和或均值。', {
        title: incompleteGroups.title,
      });
    const emptySelection = loaded.find((item) =>
      item.action?.inputs?.some(
        (input) => input.source.kind === 'item' && input.source.blockIds?.length === 0,
      ),
    );
    if (emptySelection)
      return tr('{title} 的草稿输入没有选择内容块。', { title: emptySelection.title });
    const missingUpstream = loaded.find(
      (item) => item.action && outputDependencies(item.action).some((id) => !selected.includes(id)),
    );
    if (missingUpstream)
      return tr('{title} 需要先运行上游，或在配置中选择固定产物版本。', {
        title: missingUpstream.title,
      });
    const allIds = [
      ...selected,
      ...loaded.flatMap((item) => (item.action ? itemInputIds(item.action) : [])),
    ];
    if (allIds.some((id) => readLocal<StoredItemDraft>(draftKey(userId, pid, recordId, id))?.dirty))
      return tr('操作或输入有未保存的本机草稿，请先打开内容并保存。');
    if (allIds.some((id) => hasPendingTable(tableSyncKey(userId, pid, recordId, id))))
      return tr('表格存在未同步或旧会话的修改，请打开表格等待同步后再运行。');
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      if (
        (definitions.find((definition) => definition.itemId === id)?.dependsOn ?? []).some(
          (dep) => !visit(dep),
        )
      )
        return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (selected.some((id) => !visit(id))) return tr('执行依赖存在循环，请调整依赖。');
    return '';
  };
  const selectConnected = async () => {
    if (!selected.length) {
      setError(tr('先选择一个处理步骤。'));
      return;
    }
    setPending(true);
    setError('');
    try {
      const loaded = await Promise.all(
        actions.map((item) => workspaceApi.item(pid, recordId, item.id)),
      );
      setSelected(connectedFlow(selected, loaded));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('无法读取流程，请重试。'));
    } finally {
      setPending(false);
    }
  };
  const start = (replan = false) => {
    setStepErrors({});
    const issue = check();
    if (issue) {
      setError(issue);
      setStepErrors(Object.fromEntries(selected.map((id) => [id, issue])));
      return;
    }
    void request(
      async () => {
        await api.post<ResearchRun>(`${root}/runs`, {
          steps: definitions,
          idempotencyKey: runKey,
          ...(replan ? { replan: true } : {}),
        });
        setRunKey(newKey());
      },
      (cause, message) => {
        const reportedId =
          cause instanceof ApiRequestError && typeof cause.details?.stepId === 'string'
            ? cause.details.stepId
            : undefined;
        const notebookSteps =
          cause instanceof ApiRequestError && cause.status === 501
            ? loadedItems.filter((item) => item.action?.kind === 'notebook').map((item) => item.id)
            : [];
        const affected =
          reportedId && selected.includes(reportedId)
            ? [reportedId]
            : notebookSteps.length
              ? notebookSteps
              : selected;
        setStepErrors(Object.fromEntries(affected.map((id) => [id, message])));
      },
    );
  };
  const publish = () => {
    const issue = check();
    if (issue) {
      setError(issue);
      return;
    }
    if (!name.trim()) {
      setError(tr('请填写 方案名称。'));
      return;
    }
    void request(async () => {
      await api.post<ResearchRecipe>(`${root}/recipes`, { title: name.trim(), steps: definitions });
      setName('');
    });
  };
  const instantiate = () => {
    if (!recipe) return;
    if (recipeInputs.some((id) => !inputs.some((input) => input.id === (bindings[id] ?? id)))) {
      setError(tr('请选择每项有效输入。'));
      return;
    }
    if (
      recipeInputs.some(
        (id) =>
          readLocal<StoredItemDraft>(draftKey(userId, pid, recordId, bindings[id] ?? id))?.dirty,
      )
    ) {
      setError(tr('有输入的本机草稿尚未保存。'));
      return;
    }
    void request(async () => {
      await api.post<ResearchRun>(`${root}/recipes/${recipe.id}/instantiate`, {
        version: recipe.version,
        bindings: Object.fromEntries(recipeInputs.map((id) => [id, bindings[id] ?? id])),
        idempotencyKey: instantiateKey,
      });
      setInstantiateKey(newKey());
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={tr('运行与结果')}
      size="lg"
    >
      <div className="space-y-7">
        <section className="space-y-3" aria-label={tr('运行记录')}>
          <h3 className="text-small font-semibold">{tr('运行记录')}</h3>
          {runs.isPending ? (
            <Skeleton className="h-20" />
          ) : runs.isError ? (
            <p role="alert" className="text-small text-danger">
              {tr('运行记录没有加载出来。')}
              <Button size="sm" variant="ghost" onClick={() => void runs.refetch()}>
                {tr('重试')}
              </Button>
            </p>
          ) : !runItems.length ? (
            <p className="text-small text-fg-muted">{tr('还没有运行记录')}</p>
          ) : (
            runItems.map((run) => (
              <RunResult
                key={run.id}
                pid={pid}
                recordId={recordId}
                userId={userId}
                run={run}
                items={items}
                writable={writable}
                pending={pending}
                onOpenItem={(id) => {
                  onClose();
                  onOpenItem(id);
                }}
                onCancel={() => void request(() => api.post(`${root}/runs/${run.id}/cancel`))}
                onRetry={() => void request(() => api.post(`${root}/runs/${run.id}/retry`))}
                onAnswer={(stepId, questionId, answer, baseVersion, key) =>
                  void request(() =>
                    api.post(`${root}/runs/${run.id}/steps/${stepId}/answer`, {
                      questionId,
                      answer,
                      baseVersion,
                      idempotencyKey: key,
                    }),
                  )
                }
                onConfirm={(stepId, note, itemIds) => {
                  if (
                    itemIds.some(
                      (id) =>
                        readLocal<StoredItemDraft>(draftKey(userId, pid, recordId, id))?.dirty,
                    )
                  ) {
                    setError(tr('候选内容有未保存草稿，请先保存后再确认。'));
                    return;
                  }
                  if (
                    itemIds.some((id) => hasPendingTable(tableSyncKey(userId, pid, recordId, id)))
                  ) {
                    setError(tr('候选表格存在未同步或旧会话的修改，请打开表格等待同步后再确认。'));
                    return;
                  }
                  void request(() =>
                    api.post(`${root}/runs/${run.id}/steps/${stepId}/confirm`, {
                      note,
                      ...(itemIds.length ? { itemIds } : {}),
                    }),
                  );
                }}
              />
            ))
          )}
        </section>
        {runPages.hasNextPage && (
          <Button
            size="sm"
            variant="secondary"
            loading={runPages.isFetchingNextPage}
            onClick={() => void runPages.fetchNextPage()}
          >
            {tr('加载更早运行')}
          </Button>
        )}
        <WorkspaceAudit pid={pid} recordId={recordId} />
        {writable && (
          <section className="space-y-3" aria-label={tr('配置运行')}>
            <h3 className="text-small font-semibold">{tr('选择单步或连通流程')}</h3>
            <Button
              size="sm"
              variant="secondary"
              disabled={!selected.length || pending}
              onClick={() => void selectConnected()}
            >
              {tr('选择相连流程')}
            </Button>
            {!actions.length ? (
              <p className="text-small text-fg-muted">{tr('还没有操作。返回总览新建操作。')}</p>
            ) : (
              actions.map((item) => (
                <div key={item.id} className="rounded-md border border-line p-3 text-small">
                  <div className="flex min-h-8 items-center gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, item.id]
                              : selected.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span className="font-medium">{item.title}</span>
                      <span className="text-fg-muted">
                        {item.actionKind === 'ai'
                          ? 'AI'
                          : item.actionKind === 'notebook'
                            ? 'Notebook'
                            : tr('人工检查')}
                      </span>
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onClose();
                        onOpenItem(item.id);
                      }}
                    >
                      {tr('配置')}
                    </Button>
                  </div>
                  {stepErrors[item.id] && (
                    <p role="alert" className="ml-5 mt-2 text-danger">
                      {stepErrors[item.id]}
                    </p>
                  )}
                </div>
              ))
            )}
            {selectedItems.some((query) => query.isPending) && (
              <p className="text-caption text-fg-muted">{tr('正在检查配置…')}</p>
            )}
            {selectedItems.map((query, index) => {
              const definition = query.data;
              const action = definition?.action;
              if (!definition || !action) return null;
              const inputIds = itemInputIds(action);
              const upstream =
                action.inputs?.flatMap((input) =>
                  input.source.kind === 'output' ? [input.source] : [],
                ) ?? [];
              const names = inputIds.map((id) => {
                const input = items.find((item) => item.id === id);
                return input?.title ?? tr('不可用内容');
              });
              return (
                <div key={definition.id} className="text-caption text-fg-muted">
                  <p>
                    {actions.find((item) => item.id === selected[index])?.title}
                    {tr('：')}
                    {names.length
                      ? tr('输入 {names}', { names: names.join(tr('、')) })
                      : upstream.length
                        ? tr('使用下方上游产物')
                        : tr('未指定输入')}
                  </p>
                  {!!inputIds.length && (
                    <p>
                      {tr('输入版本：')}
                      {inputIds
                        .map((id) => {
                          const input = items.find((item) => item.id === id);
                          const tableIndex = tableInputIds.indexOf(id);
                          const tableVersion =
                            tableIndex >= 0
                              ? tableQueries[tableIndex]?.data?.sourceVersion
                              : undefined;
                          return input
                            ? `${input.title} · ${tableVersion ?? input.version}`
                            : tr('不可用');
                        })
                        .join(tr('、'))}
                    </p>
                  )}
                  {upstream.map((input) => (
                    <p key={`${input.stepId}:${input.outputKey}`}>
                      {tr('上游：')}
                      {items.find((item) => item.id === input.stepId)?.title ??
                        tr('不可用步骤')} · {input.outputKey} ·{' '}
                      {input.artifactVersionId
                        ? tr('固定版本 {artifactVersionId}', {
                            artifactVersionId: input.artifactVersionId,
                          })
                        : tr('本次流程产物')}
                    </p>
                  ))}
                  <p>
                    {tr('预计产物：')}
                    {action.outputs
                      ?.map((output) =>
                        tr('{value}（{value2}）', {
                          value: output.title || output.key,
                          value2: (
                            { note: tr('笔记'), table: tr('表格'), figure: tr('数据图表') } as const
                          )[output.kind],
                        }),
                      )
                      .join(tr('、')) ||
                      (action.processing?.mode === 'auto' ? tr('自动决定') : tr('成员记录或笔记'))}
                  </p>
                  {action.kind === 'notebook' && (
                    <p>{action.notebookId ? tr('已选 Notebook') : tr('未选择 Notebook')}</p>
                  )}
                </div>
              );
            })}
            <p className="text-caption text-fg-muted">
              {tr('执行依赖由处理输入自动确定；普通关联不会触发执行。单步使用固定的上游产物版本。')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                loading={pending}
                disabled={!selected.length || loadingSelection}
                onClick={() => start()}
              >
                {tr('检查并启动')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || loadingSelection}
                onClick={() => start(true)}
              >
                {tr('重新规划')}
              </Button>
              <Input
                aria-label={tr('方案名称')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tr('方案名称')}
                wrapperClassName="w-44"
              />
              <Button disabled={!selected.length || loadingSelection || pending} onClick={publish}>
                {tr('保存方案')}
              </Button>
            </div>
          </section>
        )}
        {writable && !!recipes.data?.items.length && (
          <section className="space-y-3" aria-label={tr('复用方案')}>
            <h3 className="text-small font-semibold">{tr('复用方案')}</h3>
            <Select
              aria-label={tr('选择方案')}
              value={recipeId}
              onChange={(e) => {
                setRecipeId(e.target.value);
                setBindings({});
              }}
            >
              <option value="">{tr('选择方案')}</option>
              {recipes.data.items.map((item) => (
                <option key={`${item.id}:${item.version}`} value={item.id}>
                  {tr('{title} · 第 {version} 版', { title: item.title, version: item.version })}
                </option>
              ))}
            </Select>
            {recipe && (
              <>
                <p className="text-caption text-fg-muted">
                  {recipe.definitions.map((definition) => definition.title).join(' → ')}
                </p>
                {recipeInputs.map((id) => (
                  <label key={id} className="block space-y-1 text-small">
                    {tr('替换输入：')}
                    {items.find((item) => item.id === id)?.title ?? id}
                    <Select
                      value={bindings[id] ?? (inputs.some((input) => input.id === id) ? id : '')}
                      onChange={(e) => setBindings((old) => ({ ...old, [id]: e.target.value }))}
                    >
                      {!inputs.some((input) => input.id === id) && (
                        <option value="">{tr('原输入不可用，请选择')}</option>
                      )}
                      {inputs.map((input) => (
                        <option key={input.id} value={input.id}>
                          {input.title}
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
                <Button loading={pending} onClick={instantiate}>
                  {tr('用当前输入启动')}
                </Button>
              </>
            )}
          </section>
        )}
        {recipePages.hasNextPage && (
          <Button
            size="sm"
            variant="secondary"
            loading={recipePages.isFetchingNextPage}
            onClick={() => void recipePages.fetchNextPage()}
          >
            {tr('加载更多方案')}
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

function RunResult({
  pid,
  recordId,
  userId,
  run,
  items,
  writable,
  pending,
  onOpenItem,
  onCancel,
  onRetry,
  onConfirm,
  onAnswer,
}: {
  pid: string;
  recordId: string;
  userId: string;
  run: ResearchRun;
  items: ResearchItemSummary[];
  writable: boolean;
  pending: boolean;
  onOpenItem: (id: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onConfirm: (id: string, note: string, itemIds: string[]) => void;
  onAnswer: (
    stepId: string,
    questionId: string,
    answer: string,
    baseVersion: number,
    key: string,
  ) => void;
}) {
  const notesKey = `${workspaceStorageKey(userId, pid, recordId)}:run:${run.id}:notes`;
  const [notes, setNotes] = useState<Record<string, string>>(
    () => readLocal<Record<string, string>>(notesKey) ?? {},
  );
  const [localError, setLocalError] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerKeys, setAnswerKeys] = useState<Record<string, string>>({});
  const candidateKey = `${notesKey}:candidates`;
  const [candidates, setCandidates] = useState<Record<string, string[]>>(
    () => readLocal<Record<string, string[]>>(candidateKey) ?? {},
  );
  const stale = useQuery({
    queryKey: ['p', pid, 'research', 'run-staleness', recordId, run.id],
    queryFn: ({ signal }) =>
      api.get<ResearchRunStaleness>(`${recordRoot(pid, recordId)}/runs/${run.id}/staleness`, {
        signal,
      }),
    refetchInterval: active(run.status) ? 2000 : false,
  });
  const fixedArtifactIds = writable
    ? [
        ...new Set(
          run.steps
            .filter(
              (step) =>
                step.status === 'waiting' && (step.definition.action.outputs?.length ?? 0) > 0,
            )
            .flatMap((step) =>
              (step.definition.action.inputs ?? []).flatMap((input) =>
                input.source.kind === 'output' && input.source.artifactVersionId
                  ? [input.source.artifactVersionId]
                  : [],
              ),
            ),
        ),
      ]
    : [];
  const fixedArtifacts = useQueries({
    queries: fixedArtifactIds.map((artifactId) => ({
      queryKey: ['p', pid, 'research', 'artifact', artifactId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        contentApi.artifact(pid, artifactId, signal),
    })),
  });

  return (
    <article className="space-y-3 rounded-lg border border-line bg-surface p-4 text-small">
      <div className="flex flex-wrap items-center gap-2">
        <strong>
          {run.status === 'waiting' &&
          run.steps.some((step) => step.waitingFor?.kind === 'clarification')
            ? tr('等待补充信息')
            : STATUS[run.status]}
        </strong>
        {run.cancelRequested && (active(run.status) || run.status === 'waiting') && (
          <span className="text-fg-muted">{tr('正在停止')}</span>
        )}
        <span className="text-caption text-fg-muted">
          {new Date(run.createdAt).toLocaleString(locale())}
        </span>
        {writable && (active(run.status) || run.status === 'waiting') && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || run.cancelRequested}
            onClick={onCancel}
          >
            {tr('停止')}
          </Button>
        )}
        {writable && (run.status === 'failed' || run.status === 'interrupted') && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={onRetry}>
            {tr('继续失败步骤')}
          </Button>
        )}
      </div>
      {run.steps.map((step) => {
        const processing = step.attempts.at(-1)?.processing;
        if (!processing) return null;
        const question = step.waitingFor;
        const answer = question ? (answers[question.questionId] ?? '') : '';
        return (
          <div key={step.definition.itemId} className="space-y-2 rounded-md bg-subtle p-3">
            <p>
              {step.definition.title} ·{' '}
              {processing.phase === 'planning'
                ? tr('正在规划')
                : processing.phase === 'executing'
                  ? tr('正在处理')
                  : processing.phase === 'waiting'
                    ? tr('等待补充信息')
                    : processing.phase === 'succeeded'
                      ? tr('处理完成')
                      : tr('处理失败')}
            </p>
            {processing.plan && <p className="text-fg-muted">{processing.plan.summary}</p>}
            {processing.plan && (
              <p className="text-caption text-fg-muted">
                {processing.reused ? tr('沿用最近成功的处理方案') : tr('本次安排处理方案')}
              </p>
            )}
            {processing.steps.length > 0 && (
              <ul className="space-y-1 text-caption text-fg-muted">
                {processing.steps.map((part) => (
                  <li key={part.id}>
                    {part.title} ·{' '}
                    {
                      (
                        {
                          queued: tr('等待'),
                          running: tr('进行中'),
                          succeeded: tr('完成'),
                          failed: tr('失败'),
                        } as const
                      )[part.status]
                    }
                    {part.error && ` · ${part.error}`}
                  </li>
                ))}
              </ul>
            )}
            {(processing.plan || processing.answers.length > 0) && (
              <ProcessingDetails processing={processing} step={step} run={run} />
            )}
            {question && writable && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  {question.question}
                  <Textarea
                    value={answer}
                    rows={3}
                    onChange={(event) => {
                      setAnswers((old) => ({ ...old, [question.questionId]: event.target.value }));
                      setAnswerKeys((old) => {
                        const next = { ...old };
                        delete next[question.questionId];
                        return next;
                      });
                    }}
                  />
                </label>
                {question.choices?.map((choice) => (
                  <Button
                    key={choice}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setAnswers((old) => ({ ...old, [question.questionId]: choice }));
                      setAnswerKeys((old) => {
                        const next = { ...old };
                        delete next[question.questionId];
                        return next;
                      });
                    }}
                  >
                    {choice}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending || !answer.trim()}
                  onClick={() => {
                    const key = answerKeys[question.questionId] ?? newKey();
                    setAnswerKeys((old) => ({ ...old, [question.questionId]: key }));
                    onAnswer(
                      step.definition.itemId,
                      question.questionId,
                      answer.trim(),
                      processing.version,
                      key,
                    );
                  }}
                >
                  {tr('提交回答')}
                </Button>
              </div>
            )}
            {question && !writable && <p>{question.question}</p>}
          </div>
        );
      })}
      {stale.data?.stale && (
        <div role="status" className="rounded-md bg-warning-soft p-2 text-warning">
          {tr('输入已变化，结果待复核。')}
          {stale.data.inputs
            .filter((input) => input.state !== 'current')
            .map((input) => (
              <p key={input.itemId}>
                {items.find((item) => item.id === input.itemId)?.title ?? input.itemId}
                {tr('：')}
                {input.reason ?? (input.state === 'changed' ? tr('已变化') : tr('不可用'))}
              </p>
            ))}
        </div>
      )}
      {stale.isError && (
        <p className="text-caption text-fg-muted">
          {tr('无法检查输入是否变化。')}
          <Button size="sm" variant="ghost" onClick={() => void stale.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      )}
      {run.steps.map((step) => {
        const successful = step.attempts.filter((attempt) => attempt.status === 'succeeded');
        const all = successful.flatMap((attempt) =>
          attempt.outputs.map((output) => ({ attempt: attempt.number, output })),
        );
        const keys = [...new Set(all.map(({ output }) => output.outputKey ?? output.title))];
        const latestAttempt = step.attempts.at(-1);
        return (
          <div
            key={step.definition.itemId}
            className="space-y-2 border-l-2 border-line-strong pl-3"
          >
            <p className="font-medium">
              {step.definition.title} ·{' '}
              {step.status === 'waiting' && step.waitingFor?.kind === 'clarification'
                ? tr('等待补充信息')
                : STATUS[step.status]}
            </p>
            {latestAttempt?.error && (
              <p role="alert" className="text-danger">
                {latestAttempt.error}
              </p>
            )}
            {keys.map((key) => {
              const history = all.filter(
                ({ output }) => (output.outputKey ?? output.title) === key,
              );
              const latest = history.at(-1);
              if (!latest) return null;
              return (
                <div key={key} className="space-y-1">
                  <div>
                    {tr('{title} · {value} · 第{value2}{value3} 版', {
                      title: latest.output.title,
                      value: ORIGIN[latest.output.origin],
                      value2: ' ',
                      value3: latest.output.artifact?.version ?? latest.output.version,
                    })}
                  </div>
                  <p className="whitespace-pre-wrap">{outputSummary(latest.output)}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenItem(latest.output.itemId)}
                  >
                    {tr('打开最新结果与依据')}
                  </Button>
                  {history.length > 1 && (
                    <details>
                      <summary className="cursor-pointer text-fg-muted">{tr('此前版本')}</summary>
                      {history
                        .slice(0, -1)
                        .reverse()
                        .map(({ attempt, output }) => (
                          <div
                            key={`${attempt}:${output.itemId}:${output.version}`}
                            className="mt-1"
                          >
                            {tr('第 ')}
                            {output.artifact?.version ?? output.version}
                            {tr(' 版 ·')} {ORIGIN[output.origin]}{' '}
                            {output.artifact && (
                              <a
                                className="text-accent-text hover:underline"
                                href={contentApi.artifactUrl(pid, output.artifact.id)}
                              >
                                {tr('下载固定版本')}
                              </a>
                            )}
                          </div>
                        ))}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {run.steps
        .filter((step) => step.status === 'waiting' && step.definition.action.kind === 'human')
        .map((step) => {
          const action = step.definition.action;
          const bindings = action.inputs;
          const itemIds =
            bindings === undefined
              ? action.inputItemIds
              : bindings.flatMap((input) =>
                  input.source.kind === 'item' && !input.source.blockIds
                    ? [input.source.itemId]
                    : [],
                );
          const outputs = action.outputs ?? [];
          const fixedSources = (outputs.length ? (bindings ?? []) : []).flatMap((input) =>
            input.source.kind === 'output' && input.source.artifactVersionId ? [input.source] : [],
          );
          const fixedForStep = [
            ...new Set(fixedSources.map((source) => source.artifactVersionId!)),
          ].flatMap((id) => {
            const query = fixedArtifacts[fixedArtifactIds.indexOf(id)];
            return query ? [{ id, query }] : [];
          });
          const fixedLoading = fixedForStep.some(
            ({ query }) => query.isFetching || query.isPending,
          );
          const fixedErrors = fixedForStep.filter(({ query }) => query.isError);
          const fixedMismatch = fixedSources.some((source) => {
            const artifact =
              fixedArtifacts[fixedArtifactIds.indexOf(source.artifactVersionId!)]?.data;
            return (
              artifact &&
              (artifact.id !== source.artifactVersionId ||
                artifact.projectId !== pid ||
                artifact.recordId !== recordId ||
                artifact.stepId !== source.stepId ||
                artifact.outputKey !== source.outputKey)
            );
          });
          const available = new Map<
            string,
            { itemId: string; kind: 'note' | 'table'; title: string; version: string | number }
          >();
          const addCandidate = (entry: {
            itemId: string;
            kind: string | undefined;
            title: string;
            version: string | number;
          }) => {
            if ((entry.kind === 'note' || entry.kind === 'table') && !available.has(entry.itemId))
              available.set(entry.itemId, { ...entry, kind: entry.kind });
          };
          for (const source of fixedSources) {
            const artifact =
              fixedArtifacts[fixedArtifactIds.indexOf(source.artifactVersionId!)]?.data;
            if (
              artifact &&
              artifact.id === source.artifactVersionId &&
              artifact.projectId === pid &&
              artifact.recordId === recordId &&
              artifact.stepId === source.stepId &&
              artifact.outputKey === source.outputKey
            )
              addCandidate({
                itemId: artifact.itemId,
                kind: artifact.kind,
                title: items.find((item) => item.id === artifact.itemId)?.title ?? artifact.summary,
                version: artifact.version,
              });
          }
          for (const snapshot of run.inputSnapshots) {
            if (snapshot.artifact && itemIds.includes(snapshot.item.id))
              addCandidate({
                itemId: snapshot.item.id,
                kind: snapshot.item.kind,
                title: snapshot.item.title,
                version: snapshot.artifact.version,
              });
          }
          for (const upstream of run.steps) {
            if (
              bindings === undefined &&
              !step.definition.dependsOn.includes(upstream.definition.itemId)
            )
              continue;
            const successful = upstream.attempts
              .filter((attempt) => attempt.status === 'succeeded')
              .at(-1);
            for (const output of successful?.outputs ?? []) {
              const declared =
                bindings === undefined ||
                bindings.some(
                  (input) =>
                    input.source.kind === 'output' &&
                    !input.source.artifactVersionId &&
                    input.source.stepId === upstream.definition.itemId &&
                    input.source.outputKey === output.outputKey,
                );
              if (declared && output.artifact)
                addCandidate({
                  itemId: output.itemId,
                  kind: output.artifact.kind,
                  title: output.title,
                  version: output.version,
                });
            }
          }
          const selected = outputs.map(
            (_, index) => candidates[step.definition.itemId]?.[index] ?? '',
          );
          const selectionValid =
            selected.every((id, index) => available.get(id)?.kind === outputs[index]?.kind) &&
            new Set(selected).size === selected.length;
          return (
            <div key={step.definition.itemId} className="space-y-2 rounded-md bg-subtle p-3">
              <p>{tr('{title} · 等待人工检查', { title: step.definition.title })}</p>
              {step.definition.action.instructions && (
                <p className="whitespace-pre-wrap text-fg-muted">
                  {step.definition.action.instructions}
                </p>
              )}
              {writable && (
                <>
                  {fixedLoading && <p role="status">{tr('正在读取固定上游版本…')}</p>}
                  {fixedErrors.map(({ id, query }) => (
                    <p key={id} role="alert" className="text-danger">
                      {tr('固定上游版本没有加载出来。')}
                      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
                        {tr('重试')}
                      </Button>
                    </p>
                  ))}
                  {fixedMismatch && (
                    <p role="alert" className="text-danger">
                      {tr('固定上游版本与本步骤的输入声明不匹配，请检查步骤配置。')}
                    </p>
                  )}
                  {outputs.map((output, index) => {
                    const choices = [...available.values()].filter(
                      (entry) => entry.kind === output.kind,
                    );
                    const selectedId = selected[index] ?? '';
                    return (
                      <div key={output.key} className="space-y-1">
                        <label className="block space-y-1">
                          {tr('待确认的')}
                          {
                            (
                              {
                                note: tr('笔记'),
                                table: tr('表格'),
                                figure: tr('数据图表'),
                              } as const
                            )[output.kind]
                          }
                          <Select
                            value={selectedId}
                            onChange={(event) =>
                              setCandidates((old) => {
                                const values = [...(old[step.definition.itemId] ?? [])];
                                values[index] = event.target.value;
                                const next = { ...old, [step.definition.itemId]: values };
                                setLocalError(!writeLocal(candidateKey, next));
                                return next;
                              })
                            }
                          >
                            <option value="">{tr('选择候选内容')}</option>
                            {choices.map((entry) => (
                              <option key={`${entry.itemId}:${entry.version}`} value={entry.itemId}>
                                {tr('{title} · 第 {version} 版', {
                                  title: entry.title,
                                  version: entry.version,
                                })}
                              </option>
                            ))}
                          </Select>
                        </label>
                        {choices.some((choice) => choice.itemId === selectedId) && (
                          <Button size="sm" variant="ghost" onClick={() => onOpenItem(selectedId)}>
                            {tr('打开候选内容修改')}
                          </Button>
                        )}
                        {!choices.length && !fixedLoading && !fixedErrors.length && (
                          <p className="text-caption text-fg-muted">
                            {tr('此步骤没有匹配类型的输入或上游产物。')}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {selected.every(Boolean) && new Set(selected).size !== selected.length && (
                    <p className="text-caption text-danger">
                      {tr('每个输出需要选择不同的候选内容。')}
                    </p>
                  )}
                  <Textarea
                    aria-label={tr('{title}检查记录', { title: step.definition.title })}
                    value={notes[step.definition.itemId] ?? ''}
                    rows={3}
                    onChange={(e) =>
                      setNotes((old) => {
                        const next = { ...old, [step.definition.itemId]: e.target.value };
                        setLocalError(!writeLocal(notesKey, next));
                        return next;
                      })
                    }
                    placeholder={tr('填写检查记录')}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={
                      pending ||
                      fixedLoading ||
                      fixedErrors.length > 0 ||
                      !!fixedMismatch ||
                      !notes[step.definition.itemId]?.trim() ||
                      !selectionValid
                    }
                    onClick={() =>
                      onConfirm(
                        step.definition.itemId,
                        notes[step.definition.itemId]!.trim(),
                        selected,
                      )
                    }
                  >
                    {tr('确认检查')}
                  </Button>
                </>
              )}
            </div>
          );
        })}
      {localError && (
        <p role="alert" className="text-danger">
          {tr('检查记录无法保存在本机，请保持页面打开并提交。')}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-fg-muted">{tr('查看步骤与依据')}</summary>
        <div className="mt-2 space-y-3">
          {run.steps.map((step) => (
            <div key={step.definition.itemId}>
              <p>
                {step.definition.title} ·{' '}
                {step.status === 'waiting' && step.waitingFor?.kind === 'clarification'
                  ? tr('等待补充信息')
                  : STATUS[step.status]}
              </p>
              {step.attempts.map((attempt) => (
                <div key={attempt.number} className="ml-3 mt-1 text-caption text-fg-muted">
                  {tr('第 ')}
                  {attempt.number}
                  {tr(' 次 · ')}
                  {STATUS[attempt.status]}
                  {attempt.error && <p className="text-danger">{attempt.error}</p>}
                  {attempt.logs.length > 0 && (
                    <pre className="whitespace-pre-wrap">{attempt.logs.join('\n')}</pre>
                  )}
                </div>
              ))}
            </div>
          ))}
          {run.inputSnapshots.map((input) => (
            <div key={input.item.id} className="text-caption text-fg-muted">
              {tr('依据：')}
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={() => onOpenItem(input.item.id)}
              >
                {items.find((item) => item.id === input.item.id)?.title ?? input.item.title}
              </button>{' '}
              {tr('· 固定版本 ')}
              {input.contentVersion ?? input.item.version}
              <p className="mt-1 whitespace-pre-wrap">{input.content}</p>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function ProcessingDetails({
  processing,
  step,
  run,
}: {
  processing: ResearchProcessingExecution;
  step: ResearchRunStep;
  run: ResearchRun;
}) {
  const plan = processing.plan;
  const columns = new Map(
    run.inputSnapshots.flatMap((snapshot) =>
      snapshot.item.payload?.kind === 'table'
        ? (snapshot.item.payload.columns ?? []).map((column) => [column.id, column.name] as const)
        : [],
    ),
  );
  const column = (id: string) => columns.get(id) ?? id;
  const input = (key: string) => {
    const match = /^input:(\d+)$/.exec(key);
    if (match)
      return (
        step.definition.action.inputs?.[Number(match[1]) - 1]?.name ??
        tr('输入 {value}', { value: match[1] })
      );
    return plan?.steps.find((entry) => entry.id === key)?.title ?? key;
  };
  const operation = {
    organize: tr('整理为笔记'),
    extract_table: tr('提取成表'),
    transform_table: tr('表格处理'),
    chart: tr('绘制数据图表'),
  } as const;
  const operators = {
    eq: tr('等于'),
    ne: tr('不等于'),
    gt: tr('大于'),
    gte: tr('大于等于'),
    lt: tr('小于'),
    lte: tr('小于等于'),
    contains: tr('包含'),
    missing: tr('缺失'),
    present: tr('非缺失'),
  } as const;
  return (
    <details className="text-small">
      <summary className="cursor-pointer">{tr('处理详情')}</summary>
      <div className="mt-2 space-y-3">
        {plan?.steps.map((entry, index) => (
          <div key={entry.id} className="space-y-1">
            <p>
              {index + 1}. {entry.title} · {operation[entry.operation]}
            </p>
            <p>{tr('输入顺序：{value}', { value: entry.inputKeys.map(input).join(' → ') })}</p>
            {entry.instructions && (
              <p className="whitespace-pre-wrap">
                {tr('要求：{instructions}', { instructions: entry.instructions })}
              </p>
            )}
            {entry.transform && (
              <div className="text-fg-muted">
                <p>
                  {tr('保留列：')}
                  {entry.transform.select?.length
                    ? entry.transform.select.map(column).join(tr('、'))
                    : tr('全部列')}
                </p>
                {!!entry.transform.filters?.length && (
                  <p>
                    {tr('筛选：')}
                    {entry.transform.filters
                      .map(
                        (filter) =>
                          `${column(filter.columnId)} ${operators[filter.operator]}${filter.value === undefined ? '' : ` ${String(filter.value)}`}`,
                      )
                      .join(tr('；'))}
                  </p>
                )}
                {!!entry.transform.sort?.length && (
                  <p>
                    {tr('排序：')}
                    {entry.transform.sort
                      .map(
                        (sort) =>
                          `${column(sort.columnId)} ${sort.direction === 'asc' ? tr('升序') : tr('降序')}`,
                      )
                      .join(tr('；'))}
                  </p>
                )}
                {!!entry.transform.deduplicateBy?.length && (
                  <p>
                    {tr('去重列：')}
                    {entry.transform.deduplicateBy.map(column).join(tr('、'))}
                  </p>
                )}
                {!!entry.transform.groupBy?.length && (
                  <p>
                    {tr('分组列：')}
                    {entry.transform.groupBy.map(column).join(tr('、'))}
                  </p>
                )}
                {!!entry.transform.aggregates?.length && (
                  <p>
                    {tr('聚合：')}
                    {entry.transform.aggregates
                      .map(
                        (aggregate) =>
                          `${({ count: tr('计数'), sum: tr('求和'), mean: tr('均值') } as const)[aggregate.op]}${aggregate.columnId ? tr('（{value}）', { value: column(aggregate.columnId) }) : ''} → ${aggregate.as}`,
                      )
                      .join(tr('；'))}
                  </p>
                )}
              </div>
            )}
            {entry.chart && (
              <div className="text-fg-muted">
                <p>
                  {tr('图表类型：')}
                  {
                    ({ bar: tr('柱状图'), line: tr('折线图'), scatter: tr('散点图') } as const)[
                      entry.chart.kind
                    ]
                  }
                </p>
                {entry.chart.title && <p>{tr('标题：{title}', { title: entry.chart.title })}</p>}
                <p>
                  {tr('横轴：')}
                  {column(entry.chart.xColumn)}
                  {entry.chart.xLabel ? tr('（{xLabel}）', { xLabel: entry.chart.xLabel }) : ''}
                </p>
                <p>
                  {tr('纵轴：')}
                  {entry.chart.yColumns.map(column).join(tr('、'))}
                  {entry.chart.yLabel ? tr('（{yLabel}）', { yLabel: entry.chart.yLabel }) : ''}
                </p>
                <p>
                  {tr('缺失值：')}
                  {entry.chart.missing === 'omit' ? tr('跳过') : tr('报错')}
                </p>
              </div>
            )}
          </div>
        ))}
        {processing.answers.length > 0 && (
          <div className="space-y-2">
            <p className="font-medium">{tr('已回答的问题')}</p>
            {processing.answers.map((answer, index) => (
              <div key={`${answer.questionId}:${index}`}>
                <p>{tr('问题：{question}', { question: answer.question })}</p>
                <p className="whitespace-pre-wrap">
                  {tr('回答：{answer}', { answer: answer.answer })}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function WorkspaceAudit({ pid, recordId }: { pid: string; recordId: string }) {
  const reviews = useQuery({
    queryKey: ['p', pid, 'research', 'record-reviews', recordId],
    queryFn: ({ signal }) =>
      api.get<Review[]>(`/projects/${pid}/reviews`, {
        signal,
        query: { targetKind: 'research_record', targetId: recordId },
      }),
  });
  const findings = useQuery({
    queryKey: ['p', pid, 'research', 'record-findings', recordId],
    queryFn: ({ signal }) => researchApi.findings(pid, recordId, signal),
  });
  const status = {
    open: tr('审阅中'),
    approved: tr('审阅通过'),
    changes_requested: tr('要求修改'),
    closed: tr('审阅已关闭'),
  } as const;
  return (
    <section className="space-y-2" aria-label={tr('审阅与结论')}>
      <h3 className="text-small font-semibold">{tr('审阅与结论')}</h3>
      {reviews.isPending ? (
        <p className="text-caption text-fg-muted">{tr('正在读取审阅…')}</p>
      ) : reviews.isError ? (
        <p className="text-caption text-danger">
          {tr('无法读取审阅状态。')}
          <Button size="sm" variant="ghost" onClick={() => void reviews.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      ) : reviews.data.length ? (
        <ul className="space-y-1 text-small">
          {reviews.data.map((review) => (
            <li key={review.id}>
              <Link
                className="text-accent-text hover:underline"
                to={`/p/${pid}/reviews/${review.id}`}
              >
                {review.title}
              </Link>{' '}
              · {status[review.status]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-fg-muted">{tr('尚无审阅')}</p>
      )}
      {findings.isPending ? (
        <p className="text-caption text-fg-muted">{tr('正在读取结论…')}</p>
      ) : findings.isError ? (
        <p className="text-caption text-danger">
          {tr('无法读取结论。')}
          <Button size="sm" variant="ghost" onClick={() => void findings.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      ) : findings.data.length ? (
        <ul className="space-y-2 text-small">
          {findings.data.map((finding) => (
            <li key={finding.id}>
              <p>{finding.statement}</p>
              <span className="text-caption text-fg-muted">
                {finding.humanConfirmed ? tr('人工已确认') : tr('未确认')}
                {tr(' · 支持依据')} {finding.supportingExcerptIds.length}
                {tr(' · 反例 ')}
                {finding.counterExcerptIds.length}
                {tr(' · 背景 ')}
                {finding.contextExcerptIds.length}
                {finding.needsReview ? tr(' · 依据更新待复核') : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-fg-muted">{tr('尚无结论')}</p>
      )}
      <Link
        className="text-small text-accent-text hover:underline"
        to={`/p/${pid}/research/${recordId}?section=findings`}
      >
        {tr('管理结论与依据')}
      </Link>
    </section>
  );
}
