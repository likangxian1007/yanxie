import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResearchAction,
  ResearchActionInput,
  ResearchChartSpec,
  ResearchItemSummary,
  ResearchOperation,
  ResearchTableColumn,
  ResearchTableTransform,
} from '@srh/shared';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { contentApi } from '../content-data';
import { filterValue } from '../lib/workspace-flow';
import { workspaceApi, workspaceKey } from '../workspace-data';
import { locale, tr } from '@/lib/i18n';

const operationLabel: Record<ResearchOperation | 'human' | 'notebook', string> = {
  organize: tr('整理为笔记'),
  extract_table: tr('提取成表'),
  transform_table: tr('表格处理'),
  chart: tr('绘图'),
  human: tr('人工检查'),
  free: tr('自由指令'),
  notebook: 'Notebook',
};
const outputKind = (
  operation: ResearchOperation | 'human' | 'notebook',
): 'note' | 'table' | 'figure' =>
  operation === 'extract_table' || operation === 'transform_table'
    ? 'table'
    : operation === 'chart'
      ? 'figure'
      : 'note';
const operationOf = (action: ResearchAction) =>
  action.kind === 'human'
    ? 'human'
    : action.kind === 'notebook'
      ? 'notebook'
      : (action.operation ?? 'free');

export function WorkspaceActionEditor({
  pid,
  recordId,
  itemId,
  items,
  action,
  disabled,
  onChange,
}: {
  pid: string;
  recordId: string;
  itemId: string;
  items: ResearchItemSummary[];
  action: ResearchAction;
  disabled: boolean;
  onChange: (patch: Partial<ResearchAction>) => void;
}) {
  const qc = useQueryClient();
  const [unknownStep, setUnknownStep] = useState('');
  const [unknownKind, setUnknownKind] = useState<'note' | 'table' | 'figure'>('note');
  const [bindingError, setBindingError] = useState('');
  const [kindChangeError, setKindChangeError] = useState('');
  const [bindingPending, setBindingPending] = useState(false);
  const operation = operationOf(action);
  const auto = action.kind === 'ai' && action.processing?.mode === 'auto';
  const requiresTable = !auto && (operation === 'transform_table' || operation === 'chart');
  const steps = items.filter((item) => item.kind === 'action' && item.id !== itemId);
  const sources =
    action.inputs ??
    action.inputItemIds.map((id, index): ResearchActionInput => ({
      name: tr('输入{value}', { value: index + 1 }),
      source: { kind: 'item', itemId: id },
    }));
  const patchInputs = (inputs: ResearchActionInput[]) =>
    onChange({
      inputs,
      inputItemIds: inputs.flatMap((input) =>
        input.source.kind === 'item' ? [input.source.itemId] : [],
      ),
    });
  const possibleItems = items.filter(
    (item) =>
      item.id !== itemId &&
      item.kind !== 'group' &&
      item.kind !== 'action' &&
      (!requiresTable || item.kind === 'table'),
  );
  const possibleOutputs = steps.flatMap((step) => {
    const outputs = step.actionOutputs ?? [];
    return outputs
      .filter((output) => !requiresTable || output.kind === 'table')
      .map((output) => ({ stepId: step.id, stepTitle: step.title, ...output }));
  });
  const outputReferenced = (key: string) =>
    items.some((item) =>
      item.actionInputs?.some(
        (input) =>
          input.source.kind === 'output' &&
          input.source.stepId === itemId &&
          input.source.outputKey === key,
      ),
    );
  const outputsForKinds = (kinds: Array<'note' | 'table' | 'figure'>) => {
    const outputs = (action.outputs ?? []).filter(
      (output) => kinds.includes(output.kind) || outputReferenced(output.key),
    );
    for (const kind of kinds) {
      if (!outputs.some((output) => output.kind === kind))
        outputs.push({
          key: outputs.some((output) => output.key === kind)
            ? `${kind}_${outputs.length + 1}`
            : kind,
          kind,
        });
    }
    return outputs;
  };
  const sourceValue = (input: ResearchActionInput) =>
    input.source.kind === 'item'
      ? `item:${input.source.itemId}`
      : `output:${input.source.stepId}:${input.source.outputKey}`;
  const sourceLabel = (input: ResearchActionInput) => {
    const source = input.source;
    return source.kind === 'item'
      ? (items.find((item) => item.id === source.itemId)?.title ?? tr('内容不可用'))
      : `${items.find((item) => item.id === source.stepId)?.title ?? tr('步骤不可用')} · ${source.outputKey}`;
  };
  const add = (value: string) => {
    if (!value || (requiresTable && sources.length > 0)) return;
    const [kind, id, ...rest] = value.split(':');
    if (kind === 'unknown' && id) {
      setUnknownStep(id);
      return;
    }
    if (!id || (kind !== 'item' && kind !== 'output')) return;
    const source: ResearchActionInput['source'] =
      kind === 'item'
        ? { kind: 'item', itemId: id }
        : { kind: 'output', stepId: id, outputKey: rest.join(':') };
    if (sources.some((input) => sourceValue(input) === value)) return;
    let ordinal = 1;
    while (sources.some((input) => input.name === `输入${ordinal}`)) ordinal += 1;
    patchInputs([...sources, { name: tr('输入{ordinal}', { ordinal }), source }]);
  };
  const bindUnknown = async () => {
    setBindingPending(true);
    setBindingError('');
    try {
      const source = await workspaceApi.item(pid, recordId, unknownStep);
      if (!source.action) throw new Error(tr('上游步骤不可用。'));
      let output = source.action.outputs?.find((entry) => entry.kind === unknownKind);
      if (!output && source.action.processing?.mode === 'auto') {
        output = {
          key: (source.action.outputs ?? []).some((entry) => entry.key === unknownKind)
            ? `${unknownKind}_${(source.action.outputs ?? []).length + 1}`
            : unknownKind,
          kind: unknownKind,
        };
        await workspaceApi.updateItem(pid, recordId, source.id, {
          baseVersion: source.version,
          action: { ...source.action, outputs: [...(source.action.outputs ?? []), output] },
        });
        await qc.invalidateQueries({ queryKey: workspaceKey(pid, recordId), exact: true });
      }
      if (!output && source.action.processing?.mode !== 'auto')
        output = { key: 'result', kind: 'note' };
      if (!output || (requiresTable && output.kind !== 'table'))
        throw new Error(tr('上游没有匹配类型的产物。'));
      add(`output:${source.id}:${output.key}`);
      setUnknownStep('');
    } catch (error) {
      setBindingError(error instanceof Error ? error.message : tr('无法建立连接，请重试。'));
    } finally {
      setBindingPending(false);
    }
  };
  const tableInput = sources.find((source) => {
    const itemId = source.source.kind === 'item' ? source.source.itemId : '';
    return !!itemId && items.some((item) => item.id === itemId && item.kind === 'table');
  });
  const tableId = tableInput?.source.kind === 'item' ? tableInput.source.itemId : '';
  const upstreamTable = sources.find((source) => source.source.kind === 'output');
  const upstreamId = upstreamTable?.source.kind === 'output' ? upstreamTable.source.stepId : '';
  const artifacts = useQuery({
    queryKey: ['p', pid, 'research', recordId, 'artifacts', upstreamId],
    queryFn: ({ signal }) => contentApi.artifacts(pid, recordId, upstreamId, undefined, signal),
    enabled: (requiresTable || auto) && !tableId && !!upstreamId,
  });
  const upstreamArtifact = artifacts.data?.items.find(
    (artifact) =>
      artifact.kind === 'table' &&
      (!upstreamTable ||
        upstreamTable.source.kind !== 'output' ||
        (artifact.outputKey === upstreamTable.source.outputKey &&
          (!upstreamTable.source.artifactVersionId ||
            artifact.id === upstreamTable.source.artifactVersionId))),
  );
  const artifactId =
    upstreamArtifact?.id ??
    (upstreamTable?.source.kind === 'output' ? upstreamTable.source.artifactVersionId : undefined);
  const activeTableId = tableId || upstreamArtifact?.itemId || '';
  const table = useQuery({
    queryKey: ['p', pid, 'research', recordId, 'table-columns', tableId, artifactId],
    queryFn: ({ signal }) =>
      tableId
        ? contentApi.table(pid, recordId, tableId, { limit: 1, signal })
        : contentApi.artifactTable(pid, artifactId!, signal),
    enabled: (requiresTable || auto) && (!!tableId || !!artifactId),
  });
  const incompatible =
    requiresTable &&
    sources.some((input) => {
      const source = input.source;
      if (source.kind === 'item')
        return items.find((item) => item.id === source.itemId)?.kind !== 'table';
      const step = steps.find((entry) => entry.id === source.stepId);
      const outputs = step?.actionOutputs?.length
        ? step.actionOutputs
        : [{ key: 'result', kind: 'note' as const }];
      return !!step && outputs.find((output) => output.key === source.outputKey)?.kind !== 'table';
    });
  const columns = table.data?.columns ?? [];
  return (
    <div className="space-y-4">
      <label className="block space-y-1.5 text-small">
        {tr('处理动作')}
        <Select
          value={action.kind === 'human' ? 'human' : action.kind === 'notebook' ? 'notebook' : 'ai'}
          disabled={disabled}
          onChange={(e) => {
            const kind = e.target.value as 'ai' | 'human' | 'notebook';
            if (
              items.some((item) =>
                item.actionInputs?.some(
                  (input) => input.source.kind === 'output' && input.source.stepId === itemId,
                ),
              )
            ) {
              setKindChangeError(tr('此步骤的产物已连接下游，请先移除连接再切换处理动作。'));
              return;
            }
            setKindChangeError('');
            onChange(
              kind === 'ai'
                ? {
                    kind,
                    processing: { mode: 'auto', expectedOutputs: [] },
                    operation: 'free',
                    outputs: [],
                  }
                : {
                    kind,
                    processing: undefined,
                    operation: 'free',
                    outputs: [{ key: 'result', kind: 'note' }],
                  },
            );
          }}
        >
          <option value="ai">{tr('AI 处理')}</option>
          <option value="human">{tr('人工检查')}</option>
          {action.kind === 'notebook' && (
            <option value="notebook">{tr('Notebook（原有步骤）')}</option>
          )}
        </Select>
      </label>
      {kindChangeError && (
        <p role="alert" className="text-small text-danger">
          {kindChangeError}
        </p>
      )}
      {action.kind === 'ai' && !auto && (
        <div className="space-y-2 rounded-md border border-line p-3 text-small">
          <p>{tr('已有固定方案：{value}', { value: operationLabel[operation] })}</p>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange({
                outputs: action.outputs?.length
                  ? action.outputs
                  : outputReferenced('result')
                    ? [{ key: 'result', kind: outputKind(operation) }]
                    : [],
                processing: {
                  mode: 'auto',
                  expectedOutputs: [
                    ...new Set((action.outputs ?? []).map((output) => output.kind)),
                  ],
                  ...(action.transform || action.chart
                    ? {
                        locks: {
                          ...(action.transform ? { transform: action.transform } : {}),
                          ...(action.chart ? { chart: action.chart } : {}),
                        },
                      }
                    : {}),
                },
                operation: 'free',
              })
            }
          >
            {tr('切换为自动规划')}
          </Button>
        </div>
      )}
      {auto && (
        <div className="space-y-2 text-small">
          <p>{tr('快捷建议')}</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                [tr('整理为笔记'), tr('整理输入材料，保留来源和关键信息。'), 'note'],
                [tr('提取成表'), tr('从输入材料中提取信息并整理成表格。'), 'table'],
                [tr('表格处理'), tr('按研究目标处理输入表格，并保留处理依据。'), 'table'],
                [tr('绘制图表'), tr('根据输入数据绘制合适的柱状图、折线图或散点图。'), 'figure'],
                [tr('自由目标'), '', null],
              ] as const
            ).map(([label, instructions, kind]) => (
              <Button
                key={label}
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    instructions,
                    processing: { ...action.processing!, expectedOutputs: kind ? [kind] : [] },
                    outputs: outputsForKinds(kind ? [kind] : []),
                  })
                }
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <label className="block space-y-1.5 text-small">
        {auto ? tr('处理目标') : tr('指令或检查要求')}
        <Textarea
          value={action.instructions}
          disabled={disabled}
          rows={5}
          onChange={(e) => onChange({ instructions: e.target.value })}
          placeholder={tr('说明希望如何处理材料')}
        />
      </label>
      {auto ? (
        <fieldset className="space-y-2">
          <legend className="text-small font-medium">{tr('期望产物')}</legend>
          <p className="text-caption text-fg-muted">{tr('不选择时由 AI 根据目标决定；可多选。')}</p>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ['note', tr('笔记')],
                ['table', tr('数据表')],
                ['figure', tr('数据图表（柱状、折线、散点）')],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind} className="flex items-center gap-2 text-small">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={action.processing?.expectedOutputs.includes(kind) ?? false}
                  onChange={(e) => {
                    const kinds = e.target.checked
                      ? [...action.processing!.expectedOutputs, kind]
                      : action.processing!.expectedOutputs.filter((entry) => entry !== kind);
                    onChange({
                      processing: { ...action.processing!, expectedOutputs: kinds },
                      outputs: outputsForKinds(kinds),
                    });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {(action.outputs ?? []).length > 0 && (
            <p className="text-caption text-fg-muted">
              {tr('保留的产物：')}
              {action.outputs
                ?.map(
                  (output) =>
                    output.title ||
                    ({ note: tr('笔记'), table: tr('数据表'), figure: tr('数据图表') } as const)[
                      output.kind
                    ],
                )
                .join(tr('、'))}
            </p>
          )}
        </fieldset>
      ) : (
        <label className="block space-y-1.5 text-small">
          {tr('输出形态')}
          <Select
            value={action.outputs?.[0]?.kind ?? outputKind(operation)}
            disabled={disabled || !['free', 'notebook', 'human'].includes(operation)}
            onChange={(e) =>
              onChange({
                outputs: [
                  {
                    key: action.outputs?.[0]?.key ?? 'result',
                    kind: e.target.value as 'note' | 'table' | 'figure',
                  },
                ],
              })
            }
          >
            {!['extract_table', 'transform_table', 'chart'].includes(operation) && (
              <option value="note">{tr('笔记')}</option>
            )}
            {!['notebook', 'organize', 'chart'].includes(operation) && (
              <option value="table">{tr('表格')}</option>
            )}
            {operation === 'chart' && <option value="figure">{tr('数据图表')}</option>}
          </Select>
        </label>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-small font-medium">{tr('输入内容')}</legend>
        {sources.map((input, index) => (
          <div
            key={`${sourceValue(input)}:${index}`}
            className="space-y-2 rounded-md border border-line p-3 text-small"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{sourceLabel(input)}</span>
              {!disabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patchInputs(sources.filter((_, i) => i !== index))}
                >
                  {tr('移除')}
                </Button>
              )}
            </div>
            {input.source.kind === 'item' && (
              <DraftBlockBinding
                pid={pid}
                recordId={recordId}
                input={input}
                item={items.find(
                  (item) => item.id === (input.source.kind === 'item' ? input.source.itemId : ''),
                )}
                disabled={disabled}
                onChange={(blockIds) =>
                  patchInputs(
                    sources.map((old, i) =>
                      i === index && old.source.kind === 'item'
                        ? { ...old, source: { ...old.source, blockIds } }
                        : old,
                    ),
                  )
                }
              />
            )}
            {input.source.kind === 'output' && (
              <ArtifactVersionSelect
                pid={pid}
                recordId={recordId}
                source={input.source}
                disabled={disabled}
                onChange={(artifactVersionId) =>
                  patchInputs(
                    sources.map((old, i) =>
                      i === index && old.source.kind === 'output'
                        ? { ...old, source: { ...old.source, artifactVersionId } }
                        : old,
                    ),
                  )
                }
              />
            )}
          </div>
        ))}
        {!sources.length && <p className="text-small text-fg-muted">{tr('尚未选择输入')}</p>}
        {!disabled && (
          <Select
            aria-label={tr('添加输入')}
            disabled={requiresTable && sources.length > 0}
            value=""
            onChange={(e) => add(e.target.value)}
          >
            <option value="">{tr('添加内容或上游产物')}</option>
            {possibleItems.map((item) => (
              <option key={item.id} value={`item:${item.id}`}>
                {tr('内容：{title}', { title: item.title })}
              </option>
            ))}
            {steps
              .filter((step) => !step.actionOutputs?.length)
              .map((step) => (
                <option key={step.id} value={`unknown:${step.id}`}>
                  {tr('步骤：{title} · 选择产物类型', { title: step.title })}
                </option>
              ))}
            {possibleOutputs.map((output) => (
              <option
                key={`${output.stepId}:${output.key}`}
                value={`output:${output.stepId}:${output.key}`}
              >
                {tr('步骤：{stepTitle} · {value}', {
                  stepTitle: output.stepTitle,
                  value: output.title || output.key,
                })}
              </option>
            ))}
          </Select>
        )}
        {unknownStep && (
          <div className="space-y-2 rounded-md border border-line p-3">
            <label className="block space-y-1 text-small">
              {tr('选择上游产物类型')}
              <Select
                value={unknownKind}
                disabled={bindingPending}
                onChange={(event) =>
                  setUnknownKind(event.target.value as 'note' | 'table' | 'figure')
                }
              >
                <option value="note">{tr('笔记')}</option>
                <option value="table">{tr('数据表')}</option>
                <option value="figure">{tr('数据图表')}</option>
              </Select>
            </label>
            <Button size="sm" disabled={bindingPending} onClick={() => void bindUnknown()}>
              {tr('添加产物输入')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={bindingPending}
              onClick={() => setUnknownStep('')}
            >
              {tr('取消')}
            </Button>
            {bindingError && (
              <p role="alert" className="text-danger">
                {bindingError}
              </p>
            )}
          </div>
        )}
        {requiresTable && sources.length > 0 && (
          <p className="text-caption text-fg-muted">
            {tr('表格处理和绘图每次使用一个表格；如需更换输入，请先移除当前输入。')}
          </p>
        )}
        {incompatible && (
          <p role="alert" className="text-danger">
            {tr('该处理需要表格输入，请移除不匹配的内容。')}
          </p>
        )}
        {requiresTable && sources.length > 1 && (
          <p role="alert" className="text-danger">
            {tr('当前有多个输入，请保留一个表格输入。')}
          </p>
        )}
        {requiresTable && !possibleItems.length && !possibleOutputs.length && (
          <p className="text-caption text-fg-muted">
            {tr('需要表格输入；请先创建表格或配置上游表格产物。')}
          </p>
        )}
      </fieldset>
      {requiresTable && artifacts.isError && (
        <p role="alert" className="text-small text-danger">
          {tr('上游产物版本不可用。')}
          <Button size="sm" variant="ghost" onClick={() => void artifacts.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      )}
      {requiresTable && (
        <>
          {!activeTableId && !artifactId ? (
            <p className="text-small text-fg-muted">
              {tr('选择表格以配置列；上游步骤尚无产物时，请先运行上游。')}
            </p>
          ) : table.isPending ? (
            <p className="text-small text-fg-muted">{tr('正在读取表格列…')}</p>
          ) : table.isError ? (
            <p role="alert" className="text-small text-danger">
              {tr('无法读取表格列。')}
              <Button size="sm" variant="ghost" onClick={() => void table.refetch()}>
                {tr('重试')}
              </Button>
            </p>
          ) : operation === 'transform_table' ? (
            <TransformEditor
              value={action.transform ?? {}}
              columns={columns}
              disabled={disabled}
              onChange={(transform) => onChange({ transform })}
            />
          ) : (
            <ChartEditor
              value={action.chart}
              columns={columns}
              disabled={disabled}
              onChange={(chart) => onChange({ chart })}
            />
          )}
        </>
      )}
      {auto && (
        <details className="space-y-3 text-small">
          <summary className="cursor-pointer">{tr('高级设置：锁定处理参数')}</summary>
          <p className="mt-2 text-caption text-fg-muted">
            {tr('选择表格输入后，可锁定表格处理或图表参数。')}
          </p>
          {(activeTableId || artifactId) && !table.isPending && !table.isError && (
            <div className="space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!action.processing?.locks?.transform}
                  onChange={(event) =>
                    onChange({
                      processing: {
                        ...action.processing!,
                        locks: {
                          ...action.processing?.locks,
                          transform: event.target.checked ? {} : undefined,
                        },
                      },
                    })
                  }
                />
                {tr('锁定表格处理参数')}
              </label>
              {action.processing?.locks?.transform && (
                <TransformEditor
                  value={action.processing.locks.transform}
                  columns={columns}
                  disabled={disabled}
                  onChange={(transform) =>
                    onChange({
                      processing: {
                        ...action.processing!,
                        locks: { ...action.processing?.locks, transform },
                      },
                    })
                  }
                />
              )}
              <ChartEditor
                value={action.processing?.locks?.chart}
                columns={columns}
                disabled={disabled}
                onChange={(chart) =>
                  onChange({
                    processing: {
                      ...action.processing!,
                      locks: { ...action.processing?.locks, chart },
                    },
                  })
                }
              />
              {action.processing?.locks?.chart && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      processing: {
                        ...action.processing!,
                        locks: { ...action.processing?.locks, chart: undefined },
                      },
                    })
                  }
                >
                  {tr('取消锁定图表参数')}
                </Button>
              )}
            </div>
          )}
        </details>
      )}
      <p className="text-caption text-fg-muted">
        {tr('处理连接与普通研究关联分开；材料更新只提示重跑。')}
      </p>
    </div>
  );
}

function DraftBlockBinding({
  pid,
  recordId,
  input,
  item,
  disabled,
  onChange,
}: {
  pid: string;
  recordId: string;
  input: ResearchActionInput;
  item?: ResearchItemSummary;
  disabled: boolean;
  onChange: (ids: string[] | undefined) => void;
}) {
  if (input.source.kind !== 'item' || item?.kind !== 'draft') return null;
  return (
    <DraftBlockSelection
      pid={pid}
      recordId={recordId}
      itemId={input.source.itemId}
      selected={input.source.blockIds}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
function ArtifactVersionSelect({
  pid,
  recordId,
  source,
  disabled,
  onChange,
}: {
  pid: string;
  recordId: string;
  source: Extract<ResearchActionInput['source'], { kind: 'output' }>;
  disabled: boolean;
  onChange: (id: string | undefined) => void;
}) {
  const versions = useInfiniteQuery({
    queryKey: ['p', pid, 'research', recordId, 'artifact-options', source.stepId, source.outputKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      contentApi.artifacts(pid, recordId, source.stepId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const options =
    versions.data?.pages
      .flatMap((page) => page.items)
      .filter((artifact) => artifact.outputKey === source.outputKey) ?? [];
  return (
    <div className="space-y-1 text-small">
      <label className="block space-y-1">
        {tr('上游产物版本')}
        <Select
          value={source.artifactVersionId ?? ''}
          disabled={disabled || versions.isPending}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{tr('使用本次流程的产物')}</option>
          {options.map((artifact, index) => (
            <option key={artifact.id} value={artifact.id}>
              {tr('第 ')}
              {artifact.version}
              {tr(' 版')}
              {index === 0 ? tr(' · 最近成功') : ''} ·{' '}
              {new Date(artifact.createdAt).toLocaleString(locale())} · {artifact.summary}
            </option>
          ))}
          {source.artifactVersionId &&
            !options.some((artifact) => artifact.id === source.artifactVersionId) && (
              <option value={source.artifactVersionId}>
                {tr('已绑定版本 {artifactVersionId}', {
                  artifactVersionId: source.artifactVersionId,
                })}
              </option>
            )}
        </Select>
      </label>
      <span className="block text-caption text-fg-muted">
        {tr('单步运行时，请明确选择一个已成功的固定版本。')}
      </span>
      {versions.isError && (
        <p className="text-danger">
          {tr('版本加载失败。')}
          <Button size="sm" variant="ghost" onClick={() => void versions.refetch()}>
            {tr('重试')}
          </Button>
        </p>
      )}
      {versions.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          disabled={versions.isFetchingNextPage}
          onClick={() => void versions.fetchNextPage()}
        >
          {tr('加载更早的版本')}
        </Button>
      )}
    </div>
  );
}
function DraftBlockSelection({
  pid,
  recordId,
  itemId,
  selected,
  disabled,
  onChange,
}: {
  pid: string;
  recordId: string;
  itemId: string;
  selected?: string[];
  disabled: boolean;
  onChange: (ids: string[] | undefined) => void;
}) {
  const item = useQuery({
    queryKey: ['p', pid, 'research', 'execution-item', recordId, itemId],
    queryFn: ({ signal }) => workspaceApi.item(pid, recordId, itemId, signal),
  });
  if (item.isPending) return <p className="text-fg-muted">{tr('正在读取草稿块…')}</p>;
  if (item.isError || item.data.payload?.kind !== 'draft')
    return <p className="text-danger">{tr('无法读取草稿块。')}</p>;
  const blocks = item.data.payload.blocks;
  return (
    <div className="space-y-1">
      {!blocks.length && <p className="text-danger">{tr('草稿没有内容块，请先添加内容。')}</p>}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={disabled || !blocks.length}
          checked={!selected}
          onChange={(e) => onChange(e.target.checked ? undefined : blocks.map((block) => block.id))}
        />
        {tr('全部内容块')}
      </label>
      {selected &&
        blocks.map((block, index) => (
          <label key={block.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={disabled || (selected.length === 1 && selected.includes(block.id))}
              checked={selected.includes(block.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, block.id]
                    : selected.filter((id) => id !== block.id),
                )
              }
            />
            {tr('第 ')}
            {index + 1}
            {tr(' 块 ·')}{' '}
            {block.kind === 'text'
              ? block.text.slice(0, 50) || tr('文字')
              : block.kind === 'resource'
                ? block.title || tr('材料')
                : tr('摘录')}
          </label>
        ))}
    </div>
  );
}

function ColumnChecks({
  label,
  columns,
  values,
  disabled,
  onChange,
}: {
  label: string;
  columns: ResearchTableColumn[];
  values: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-small font-medium">{label}</legend>
      <div className="flex flex-wrap gap-x-4">
        {columns.map((column) => (
          <label key={column.id} className="flex min-h-8 items-center gap-2 text-small">
            <input
              type="checkbox"
              disabled={disabled}
              checked={values.includes(column.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...values, column.id]
                    : values.filter((id) => id !== column.id),
                )
              }
            />
            {column.name}
            {column.unit ? tr('（{unit}）', { unit: column.unit }) : ''}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function ColumnSelect({
  value,
  columns,
  disabled,
  onChange,
  label,
}: {
  value: string;
  columns: ResearchTableColumn[];
  disabled: boolean;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{tr('选择列')}</option>
      {columns.map((column) => (
        <option key={column.id} value={column.id}>
          {column.name}
          {column.unit ? tr('（{unit}）', { unit: column.unit }) : ''}
        </option>
      ))}
    </Select>
  );
}
function TransformEditor({
  value,
  columns,
  disabled,
  onChange,
}: {
  value: ResearchTableTransform;
  columns: ResearchTableColumn[];
  disabled: boolean;
  onChange: (value: ResearchTableTransform) => void;
}) {
  const filters = value.filters ?? [];
  const sort = value.sort ?? [];
  const aggregates = value.aggregates ?? [];
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h4 className="text-small font-semibold">{tr('表格处理')}</h4>
      <p className="text-caption text-fg-muted">
        {tr(
          '保留列留空表示全部列。分组统计时，保留列应留空或恰好包含全部分组列，统计列会自动添加；不自动补零或换算单位。',
        )}
      </p>
      <ColumnChecks
        label={tr('保留列')}
        columns={columns}
        values={value.select ?? []}
        disabled={disabled}
        onChange={(select) => onChange({ ...value, select: select.length ? select : undefined })}
      />
      <ColumnChecks
        label={tr('按列去重')}
        columns={columns}
        values={value.deduplicateBy ?? []}
        disabled={disabled}
        onChange={(deduplicateBy) => onChange({ ...value, deduplicateBy })}
      />
      <ColumnChecks
        label={tr('分组列')}
        columns={columns}
        values={value.groupBy ?? []}
        disabled={disabled}
        onChange={(groupBy) => onChange({ ...value, groupBy })}
      />
      <div className="space-y-2">
        <p className="text-small font-medium">{tr('筛选')}</p>
        {filters.map((filter, index) => (
          <div className="grid gap-2 sm:grid-cols-4" key={index}>
            <ColumnSelect
              label={tr('筛选列 {value}', { value: index + 1 })}
              columns={columns}
              value={filter.columnId}
              disabled={disabled}
              onChange={(columnId) =>
                onChange({
                  ...value,
                  filters: filters.map((entry, i) =>
                    i === index ? { ...entry, columnId } : entry,
                  ),
                })
              }
            />
            <Select
              aria-label={tr('筛选条件 {value}', { value: index + 1 })}
              value={filter.operator}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  filters: filters.map((entry, i) =>
                    i === index
                      ? { ...entry, operator: e.target.value as typeof filter.operator }
                      : entry,
                  ),
                })
              }
            >
              <option value="eq">{tr('等于')}</option>
              <option value="ne">{tr('不等于')}</option>
              <option value="gt">{tr('大于')}</option>
              <option value="gte">{tr('大于等于')}</option>
              <option value="lt">{tr('小于')}</option>
              <option value="lte">{tr('小于等于')}</option>
              <option value="contains">{tr('包含')}</option>
              <option value="missing">{tr('缺失')}</option>
              <option value="present">{tr('非缺失')}</option>
            </Select>
            <Input
              aria-label={tr('筛选值 {value}', { value: index + 1 })}
              disabled={disabled || filter.operator === 'missing' || filter.operator === 'present'}
              value={String(filter.value ?? '')}
              onChange={(e) =>
                onChange({
                  ...value,
                  filters: filters.map((entry, i) =>
                    i === index
                      ? {
                          ...entry,
                          value: filterValue(
                            e.target.value,
                            columns.find((column) => column.id === entry.columnId)?.type,
                          ),
                        }
                      : entry,
                  ),
                })
              }
            />
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ ...value, filters: filters.filter((_, i) => i !== index) })}
            >
              {tr('删除')}
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={disabled || !columns.length}
          onClick={() =>
            onChange({
              ...value,
              filters: [...filters, { columnId: columns[0]!.id, operator: 'eq', value: '' }],
            })
          }
        >
          {tr('添加筛选')}
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-small font-medium">{tr('排序')}</p>
        {sort.map((entry, index) => (
          <div className="flex flex-wrap gap-2" key={index}>
            <ColumnSelect
              label={tr('排序列 {value}', { value: index + 1 })}
              columns={columns}
              value={entry.columnId}
              disabled={disabled}
              onChange={(columnId) =>
                onChange({
                  ...value,
                  sort: sort.map((old, i) => (i === index ? { ...old, columnId } : old)),
                })
              }
            />
            <Select
              aria-label={tr('排序方向 {value}', { value: index + 1 })}
              value={entry.direction}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  sort: sort.map((old, i) =>
                    i === index ? { ...old, direction: e.target.value as 'asc' | 'desc' } : old,
                  ),
                })
              }
            >
              <option value="asc">{tr('升序')}</option>
              <option value="desc">{tr('降序')}</option>
            </Select>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ ...value, sort: sort.filter((_, i) => i !== index) })}
            >
              {tr('删除')}
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={disabled || !columns.length}
          onClick={() =>
            onChange({ ...value, sort: [...sort, { columnId: columns[0]!.id, direction: 'asc' }] })
          }
        >
          {tr('添加排序')}
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-small font-medium">{tr('分组计算')}</p>
        {aggregates.map((entry, index) => (
          <div className="grid gap-2 sm:grid-cols-4" key={index}>
            <Select
              aria-label={tr('计算方法 {value}', { value: index + 1 })}
              value={entry.op}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  aggregates: aggregates.map((old, i) =>
                    i === index
                      ? {
                          ...old,
                          op: e.target.value as 'count' | 'sum' | 'mean',
                          columnId:
                            e.target.value === 'count'
                              ? undefined
                              : (old.columnId ?? columns[0]?.id),
                        }
                      : old,
                  ),
                })
              }
            >
              <option value="count">{tr('计数')}</option>
              <option value="sum">{tr('求和')}</option>
              <option value="mean">{tr('均值')}</option>
            </Select>
            <ColumnSelect
              label={tr('计算列 {value}', { value: index + 1 })}
              columns={columns}
              value={entry.columnId ?? ''}
              disabled={disabled || entry.op === 'count'}
              onChange={(columnId) =>
                onChange({
                  ...value,
                  aggregates: aggregates.map((old, i) =>
                    i === index ? { ...old, columnId } : old,
                  ),
                })
              }
            />
            <Input
              aria-label={tr('结果列名称 {value}', { value: index + 1 })}
              value={entry.as}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...value,
                  aggregates: aggregates.map((old, i) =>
                    i === index ? { ...old, as: e.target.value } : old,
                  ),
                })
              }
            />
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                onChange({ ...value, aggregates: aggregates.filter((_, i) => i !== index) })
              }
            >
              {tr('删除')}
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...value,
              aggregates: [
                ...aggregates,
                { op: 'count', as: tr('计数{value}', { value: aggregates.length + 1 }) },
              ],
            })
          }
        >
          {tr('添加计算')}
        </Button>
      </div>
    </div>
  );
}
function ChartEditor({
  value,
  columns,
  disabled,
  onChange,
}: {
  value?: ResearchChartSpec;
  columns: ResearchTableColumn[];
  disabled: boolean;
  onChange: (value: ResearchChartSpec) => void;
}) {
  if (!columns.length)
    return <p className="text-small text-fg-muted">{tr('表格尚无可绘图的列。')}</p>;
  const spec: ResearchChartSpec = value ?? {
    kind: 'bar',
    xColumn: columns[0]!.id,
    yColumns: [columns[1]?.id ?? columns[0]!.id],
    missing: 'omit',
  };
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h4 className="text-small font-semibold">{tr('绘图配置')}</h4>
      {!value && !disabled && (
        <Button size="sm" variant="secondary" onClick={() => onChange(spec)}>
          {tr('使用这些默认列')}
        </Button>
      )}
      <label className="block space-y-1 text-small">
        {tr('图表标题')}
        <Input
          value={spec.title ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, title: e.target.value })}
        />
      </label>
      <label className="block space-y-1 text-small">
        {tr('图表类型')}
        <Select
          value={spec.kind}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, kind: e.target.value as ResearchChartSpec['kind'] })}
        >
          <option value="bar">{tr('柱状图')}</option>
          <option value="line">{tr('折线图')}</option>
          <option value="scatter">{tr('散点图')}</option>
        </Select>
      </label>
      <label className="block space-y-1 text-small">
        {tr('横轴列')}
        <ColumnSelect
          label={tr('横轴列')}
          columns={columns}
          value={spec.xColumn}
          disabled={disabled}
          onChange={(xColumn) => {
            if (xColumn) onChange({ ...spec, xColumn });
          }}
        />
      </label>
      <ColumnChecks
        label={tr('纵轴数据列')}
        columns={columns}
        values={spec.yColumns}
        disabled={disabled}
        onChange={(yColumns) => {
          if (yColumns.length) onChange({ ...spec, yColumns });
        }}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-small">
          {tr('横轴名称（含单位）')}
          <Input
            value={spec.xLabel ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...spec, xLabel: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-small">
          {tr('纵轴名称（含单位）')}
          <Input
            value={spec.yLabel ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...spec, yLabel: e.target.value })}
          />
        </label>
      </div>
      <label className="block space-y-1 text-small">
        {tr('缺失值处理')}
        <Select
          value={spec.missing}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, missing: e.target.value as 'omit' | 'error' })}
        >
          <option value="omit">{tr('忽略缺失数据行')}</option>
          <option value="error">{tr('遇到缺失值时停止')}</option>
        </Select>
      </label>
    </div>
  );
}
