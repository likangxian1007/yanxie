import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { withBase } from '@/lib/base-path';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  ResearchActionOutput,
  ResearchItemSummary,
  ResearchRelation,
  ResearchPosition,
} from '@srh/shared';
import './workspace-canvas.css';
import { workspaceGroupFrames } from '../lib/workspace-graph';
import { contentApi } from '../content-data';
import {
  translatedPositions,
  workspaceDataWouldCycle,
  workspaceMoveIds,
} from '../lib/workspace-layout-geometry';
import { tr } from '@/lib/i18n';

const LABEL: Record<string, string> = {
  note: tr('笔记'),
  resource: tr('材料'),
  action: tr('处理步骤'),
  group: tr('分组'),
  draft: tr('混合草稿'),
  table: tr('数据表'),
  figure: tr('图像／图表'),
};
const RUN_STATUS: Record<string, string> = {
  queued: tr('等待运行'),
  running: tr('运行中'),
  waiting: tr('等待处理'),
  succeeded: tr('已完成'),
  failed: tr('运行失败'),
  cancelled: tr('已停止'),
  interrupted: tr('运行中断'),
};
type CardNode = Node<
  {
    title: string;
    kind: ResearchItemSummary['kind'];
    parent: string;
    preview: string;
    actionKind: ResearchItemSummary['actionKind'];
    runStatus?: string | null;
    outputs: ResearchActionOutput[];
    dataEnabled: boolean;
    previewImageUrl: string | null;
    openHandler: (id: string) => void;
    onOpen: () => void;
    groupSize: number;
  },
  'research' | 'researchGroup'
>;
const ResearchCard = memo(function ResearchCard({ id, data, selected }: NodeProps<CardNode>) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const outputs: ResearchActionOutput[] =
    data.kind === 'action'
      ? data.outputs.length
        ? data.outputs
        : [{ key: 'result', kind: 'note' }]
      : [{ key: 'default', kind: 'note' }];
  const updateNodeInternals = useUpdateNodeInternals();
  const outputKeys = outputs.map((output) => output.key).join('\u0000');
  useEffect(
    () => updateNodeInternals(id),
    [id, data.kind, data.dataEnabled, outputKeys, updateNodeInternals],
  );
  return (
    <div className={`research-node ${selected ? 'is-selected' : ''}`}>
      <Handle
        type="target"
        id="relation:in"
        position={Position.Top}
        aria-label={tr('关联到此内容')}
      />
      {data.dataEnabled && data.kind === 'action' && (
        <Handle
          className="research-data-handle"
          type="target"
          id="data:in"
          position={Position.Left}
          aria-label={tr('处理步骤的数据输入')}
        />
      )}
      <div className="research-node-kind">
        {data.actionKind
          ? ({ ai: tr('AI 处理'), notebook: 'Notebook', human: tr('人工检查') } as const)[
              data.actionKind
            ]
          : LABEL[data.kind]}
        {data.parent && ` · ${data.parent}`}
      </div>
      <div className="research-node-title">{data.title}</div>
      {data.previewImageUrl &&
        (failedImage === data.previewImageUrl ? (
          <p className="research-node-preview">{tr('图片无法加载，请打开查看。')}</p>
        ) : (
          <img
            className="research-node-image"
            src={withBase(data.previewImageUrl)}
            alt={tr('{title}预览', { title: data.title })}
            draggable={false}
            onError={() => setFailedImage(data.previewImageUrl)}
          />
        ))}
      {data.preview && <p className="research-node-preview">{data.preview}</p>}
      {data.kind === 'action' && data.runStatus && (
        <div className="research-node-status" role="status">
          {RUN_STATUS[data.runStatus] ?? data.runStatus}
        </div>
      )}
      <button
        type="button"
        className="research-node-open nodrag nopan"
        aria-label={tr('打开 {title}', { title: data.title })}
        onClick={(event) => {
          event.stopPropagation();
          data.onOpen();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {tr('打开')}
      </button>
      <Handle
        type="source"
        id="relation:out"
        position={Position.Bottom}
        aria-label={tr('从此内容建立关联')}
      />
      {data.dataEnabled &&
        outputs.map((output, index, all) => (
          <Handle
            className="research-data-handle"
            key={output.key}
            type="source"
            id={`data:${encodeURIComponent(output.key)}`}
            position={Position.Right}
            style={{ top: `${((index + 1) / (all.length + 1)) * 100}%` }}
            aria-label={
              data.kind === 'action' && !data.outputs.length
                ? tr('数据输出：选择产物类型')
                : tr('数据输出：{value}', { value: output.title || output.key })
            }
          />
        ))}
    </div>
  );
});
const ResearchGroup = memo(function ResearchGroup({ data, selected }: NodeProps<CardNode>) {
  return (
    <div className={`research-group ${selected ? 'is-selected' : ''}`}>
      <Handle
        type="target"
        id="relation:in"
        position={Position.Top}
        aria-label={tr('关联到分组')}
      />
      <div className="research-group-heading">
        <span className="text-small font-medium text-fg">
          {data.title}{' '}
          <span className="text-caption text-fg-muted">
            {tr('{groupSize} 项', { groupSize: data.groupSize })}
          </span>
        </span>
        <button
          type="button"
          className="research-node-open nodrag nopan"
          aria-label={tr('打开 {title}', { title: data.title })}
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {tr('打开')}
        </button>
      </div>
      <Handle
        type="source"
        id="relation:out"
        position={Position.Bottom}
        aria-label={tr('从分组建立关联')}
      />
    </div>
  );
});
const nodeTypes = { research: ResearchCard, researchGroup: ResearchGroup };
const DataEdge = memo(function DataEdge(props: EdgeProps) {
  const [path, x, y] = getBezierPath(props);
  const remove = props.data?.onRemove as (() => void) | undefined;
  const label = typeof props.data?.inputName === 'string' ? props.data.inputName : '';
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <div
          className="research-data-edge-label nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          {label && <span>{label}</span>}
          {remove && (
            <button
              type="button"
              onClick={remove}
              aria-label={tr('移除数据流{value}', {
                value: label ? tr('：{label}', { label }) : '',
              })}
            >
              {tr('移除')}
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
const edgeTypes = { researchData: DataEdge };
export type WorkspaceMove = { id: string; position: ResearchPosition };
export type WorkspaceDataConnection = {
  id: string;
  fromItemId: string;
  toItemId: string;
  outputKey?: string;
  inputName: string;
};
const EMPTY_DATA_CONNECTIONS: WorkspaceDataConnection[] = [];
type Drag = {
  anchor: string;
  anchorPosition: ResearchPosition;
  initial: Map<string, ResearchPosition>;
  latest: Map<string, ResearchPosition>;
};

function projectNodes(
  items: ResearchItemSummary[],
  selected: string[],
  open: (id: string) => void,
  dataEnabled: boolean,
  previous: CardNode[],
  positions: Map<string, ResearchPosition>,
): CardNode[] {
  const projected = items.map((item) => ({
    ...item,
    position: positions.get(item.id) ?? item.position,
  }));
  const sizes = new Map(
    previous
      .filter((node) => node.measured?.width && node.measured?.height)
      .map((node) => [node.id, { width: node.measured!.width!, height: node.measured!.height! }]),
  );
  const frames = workspaceGroupFrames(projected, sizes);
  const byId = new Map(previous.map((node) => [node.id, node]));
  const titles = new Map(projected.map((item) => [item.id, item.title]));
  const counts = new Map<string, number>();
  for (const item of projected)
    if (item.parentId) counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
  return projected.map((item): CardNode => {
    const frame = frames.get(item.id);
    const old = byId.get(item.id);
    const type = item.kind === 'group' ? 'researchGroup' : 'research';
    const position = frame ? { x: frame.x, y: frame.y } : item.position;
    const style = frame
      ? { width: frame.width, height: frame.height }
      : item.kind === 'group'
        ? { width: 220, height: 96 }
        : undefined;
    const zIndex = frame ? -1 : 0;
    const isSelected = selected.includes(item.id);
    const parent = item.parentId ? (titles.get(item.parentId) ?? '') : '';
    const groupSize = counts.get(item.id) ?? 0;
    const outputs = item.actionOutputs ?? [];
    const previewImageUrl =
      item.kind === 'figure' && item.previewImageFileId
        ? contentApi.fileUrl(item.projectId, item.previewImageFileId)
        : null;
    const oldData = old?.data;
    const data =
      oldData &&
      oldData.title === item.title &&
      oldData.kind === item.kind &&
      oldData.parent === parent &&
      oldData.preview === item.preview &&
      oldData.actionKind === item.actionKind &&
      oldData.runStatus === item.runStatus &&
      oldData.dataEnabled === dataEnabled &&
      oldData.previewImageUrl === previewImageUrl &&
      oldData.openHandler === open &&
      oldData.groupSize === groupSize &&
      JSON.stringify(oldData.outputs) === JSON.stringify(outputs)
        ? oldData
        : {
            title: item.title,
            kind: item.kind,
            parent,
            preview: item.preview,
            actionKind: item.actionKind,
            runStatus: item.runStatus,
            outputs,
            dataEnabled,
            previewImageUrl,
            openHandler: open,
            onOpen: () => open(item.id),
            groupSize,
          };
    if (
      old &&
      old.type === type &&
      old.ariaLabel === item.title &&
      old.selected === isSelected &&
      old.position.x === position.x &&
      old.position.y === position.y &&
      old.zIndex === zIndex &&
      old.style?.width === style?.width &&
      old.style?.height === style?.height &&
      old.data === data
    )
      return old;
    return {
      ...old,
      id: item.id,
      ariaLabel: item.title,
      type,
      position,
      style,
      zIndex,
      selected: isSelected,
      data,
    };
  });
}

export default function WorkspaceCanvas({
  items,
  relations,
  selected,
  viewport,
  writable,
  onSelect,
  onOpen,
  onMove,
  onMoveMany,
  onConnect,
  dataConnections = EMPTY_DATA_CONNECTIONS,
  onDataConnect,
  onDataDisconnect,
  onViewport,
}: {
  items: ResearchItemSummary[];
  relations: ResearchRelation[];
  selected: string[];
  viewport: Viewport | null;
  writable: boolean;
  onSelect: (ids: string[]) => void;
  onOpen: (id: string) => void;
  onMove: (id: string, position: ResearchPosition) => void;
  onMoveMany?: (moves: WorkspaceMove[]) => void;
  onConnect: (from: string, to: string) => void;
  dataConnections?: WorkspaceDataConnection[];
  onDataConnect?: (connection: {
    fromItemId: string;
    toItemId: string;
    outputKey?: string;
  }) => void;
  onDataDisconnect?: (id: string) => void;
  onViewport: (viewport: Viewport) => void;
}) {
  const itemsRef = useRef(items);
  const selectedRef = useRef(selected);
  const openRef = useRef(onOpen);
  const openItem = useCallback((id: string) => openRef.current(id), []);
  const dataEnabledRef = useRef(Boolean(onDataConnect) || dataConnections.length > 0);
  const drag = useRef<Drag | null>(null);
  const lastDrag = useRef(0);
  const deferredSelection = useRef<string[] | null>(null);
  const deferredViewport = useRef<Viewport | null>(null);
  const waiting = useRef(new Map<string, ResearchPosition>());
  useLayoutEffect(() => {
    itemsRef.current = items;
    selectedRef.current = deferredSelection.current ?? selected;
    openRef.current = onOpen;
    dataEnabledRef.current = Boolean(onDataConnect) || dataConnections.length > 0;
  }, [items, selected, onOpen, onDataConnect, dataConnections.length]);

  const mergeNodes = useCallback(
    (previous: CardNode[], overrides = new Map<string, ResearchPosition>()) => {
      const positions = new Map(waiting.current);
      for (const [id, position] of overrides) positions.set(id, position);
      return projectNodes(
        itemsRef.current,
        selectedRef.current,
        openItem,
        dataEnabledRef.current,
        previous,
        positions,
      );
    },
    [openItem],
  );
  const [nodes, setNodes] = useState<CardNode[]>(() =>
    projectNodes(
      items,
      selected,
      onOpen,
      Boolean(onDataConnect) || dataConnections.length > 0,
      [],
      new Map(),
    ),
  );
  const [connectionError, setConnectionError] = useState('');
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      for (const item of items) {
        const position = waiting.current.get(item.id);
        if (position && position.x === item.position.x && position.y === item.position.y)
          waiting.current.delete(item.id);
      }
      setNodes((previous) => mergeNodes(previous, drag.current?.latest));
    });
    return () => {
      cancelled = true;
    };
  }, [items, selected, mergeNodes, onDataConnect, dataConnections.length]);

  const begin = useCallback((node: CardNode, chosen: CardNode[]) => {
    if (drag.current) return;
    const ids = workspaceMoveIds(
      itemsRef.current,
      chosen.length ? chosen.map((item) => item.id) : [node.id],
    );
    const initial = new Map(
      itemsRef.current
        .filter((item) => ids.has(item.id))
        .map((item) => [item.id, waiting.current.get(item.id) ?? item.position]),
    );
    drag.current = { anchor: node.id, anchorPosition: node.position, initial, latest: initial };
  }, []);
  const update = useCallback(
    (node: CardNode) => {
      const active = drag.current;
      if (!active || node.id !== active.anchor) return;
      active.latest = translatedPositions(
        active.initial,
        node.position.x - active.anchorPosition.x,
        node.position.y - active.anchorPosition.y,
      );
      setNodes((previous) => mergeNodes(previous, active.latest));
    },
    [mergeNodes],
  );
  const finish = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    lastDrag.current = Date.now();
    if (deferredSelection.current) {
      onSelect(deferredSelection.current);
      deferredSelection.current = null;
    }
    if (deferredViewport.current) {
      onViewport(deferredViewport.current);
      deferredViewport.current = null;
    }
    const moves = [...active.latest]
      .filter(([id, position]) => {
        const original = active.initial.get(id)!;
        return position.x !== original.x || position.y !== original.y;
      })
      .map(([id, position]) => ({ id, position }));
    if (!moves.length) return;
    for (const move of moves) waiting.current.set(move.id, move.position);
    if (onMoveMany) onMoveMany(moves);
    else for (const move of moves) onMove(move.id, move.position);
  }, [onMove, onMoveMany, onSelect, onViewport]);
  const changeNodes = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      // The final drag event carries a position that may already be stale. Keep
      // the dragging flag change, but leave position authority with the local layout.
      const applicable = changes.map((change) =>
        change.type === 'position' && change.dragging === false
          ? { ...change, position: undefined }
          : change,
      );
      setNodes((previous) => {
        const next = applyNodeChanges(applicable, previous);
        return applicable.some((change) => change.type === 'dimensions')
          ? mergeNodes(next, new Map(next.map((node) => [node.id, node.position])))
          : next;
      });
      const keyboard = changes.filter(
        (change): change is Extract<NodeChange<CardNode>, { type: 'position' }> =>
          change.type === 'position' && change.dragging === undefined && !!change.position,
      );
      if (!drag.current && keyboard.length) {
        const moves = keyboard.map((change) => ({ id: change.id, position: change.position! }));
        for (const move of moves) waiting.current.set(move.id, move.position);
        setNodes((previous) => mergeNodes(previous));
        if (onMoveMany) onMoveMany(moves);
        else for (const move of moves) onMove(move.id, move.position);
      }
    },
    [mergeNodes, onMove, onMoveMany],
  );
  const selectionChange = useCallback(
    ({ nodes: chosen }: { nodes: CardNode[] }) => {
      const ids = chosen.map((node) => node.id);
      if (drag.current) {
        selectedRef.current = ids;
        deferredSelection.current = ids;
      } else onSelect(ids);
    },
    [onSelect],
  );
  const edges = useMemo<Edge[]>(
    () => [
      ...relations.map((relation): Edge => ({
        id: relation.id,
        source: relation.fromItemId,
        sourceHandle: 'relation:out',
        target: relation.toItemId,
        targetHandle: 'relation:in',
        label: relation.label,
        style: { stroke: 'var(--fg-subtle)', strokeDasharray: '5 4' },
        labelStyle: { fill: 'var(--fg-muted)' },
        labelBgStyle: { fill: 'var(--surface)' },
      })),
      ...dataConnections.map((connection): Edge => {
        const source = items.find((item) => item.id === connection.fromItemId);
        const outputKey =
          source?.kind === 'action' ? (connection.outputKey ?? 'result') : 'default';
        return {
          id: `data:${connection.id}`,
          type: 'researchData',
          source: connection.fromItemId,
          sourceHandle: `data:${encodeURIComponent(outputKey)}`,
          target: connection.toItemId,
          targetHandle: 'data:in',
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)' },
          style: { stroke: 'var(--accent)', strokeWidth: 2 },
          data: {
            inputName: connection.inputName,
            ...(writable && onDataDisconnect
              ? { onRemove: () => onDataDisconnect(connection.id) }
              : {}),
          },
        };
      }),
    ],
    [relations, dataConnections, items, writable, onDataDisconnect],
  );
  const connectionIsValid = (connection: Connection | Edge) => {
    if (!connection.source || !connection.target || connection.source === connection.target)
      return false;
    if (connection.sourceHandle === 'relation:out' && connection.targetHandle === 'relation:in')
      return true;
    return Boolean(
      connection.sourceHandle?.startsWith('data:') &&
      connection.targetHandle === 'data:in' &&
      items.some((item) => item.id === connection.target && item.kind === 'action') &&
      !workspaceDataWouldCycle(dataConnections, connection.source, connection.target),
    );
  };
  const connect = (connection: Connection) => {
    if (!connectionIsValid(connection)) return;
    setConnectionError('');
    if (connection.sourceHandle === 'relation:out') {
      onConnect(connection.source, connection.target);
    } else {
      const source = items.find((item) => item.id === connection.source);
      const outputKey =
        source?.kind === 'action' && connection.sourceHandle
          ? decodeURIComponent(connection.sourceHandle.slice('data:'.length))
          : undefined;
      onDataConnect?.({
        fromItemId: connection.source,
        toItemId: connection.target,
        ...(outputKey ? { outputKey } : {}),
      });
    }
  };
  return (
    <div
      className="research-flow h-[min(68vh,760px)] min-h-[420px] overflow-hidden rounded-lg border border-line bg-canvas"
      aria-label={tr('研究画布')}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const node = target.closest<HTMLElement>('.react-flow__node');
        if (event.key === 'Enter' && node && target === node && node.dataset.id) {
          event.preventDefault();
          event.stopPropagation();
          onOpen(node.dataset.id);
        }
        const directions: Record<string, ResearchPosition> = {
          ArrowLeft: { x: -1, y: 0 },
          ArrowRight: { x: 1, y: 0 },
          ArrowUp: { x: 0, y: -1 },
          ArrowDown: { x: 0, y: 1 },
        };
        const direction = directions[event.key];
        if (
          writable &&
          direction &&
          node &&
          target === node &&
          node.dataset.id &&
          selectedRef.current.includes(node.dataset.id)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const ids = workspaceMoveIds(itemsRef.current, selectedRef.current);
          const distance = event.shiftKey ? 20 : 5;
          const moves = itemsRef.current
            .filter((item) => ids.has(item.id))
            .map((item) => {
              const previous = waiting.current.get(item.id) ?? item.position;
              return {
                id: item.id,
                position: {
                  x: previous.x + direction.x * distance,
                  y: previous.y + direction.y * distance,
                },
              };
            });
          for (const move of moves) waiting.current.set(move.id, move.position);
          setNodes((previous) => mergeNodes(previous));
          if (onMoveMany) onMoveMany(moves);
          else for (const move of moves) onMove(move.id, move.position);
        }
      }}
    >
      <ReactFlow<CardNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={changeNodes}
        onConnect={connect}
        isValidConnection={connectionIsValid}
        onConnectEnd={(_, state) => {
          if (state.toHandle && state.isValid === false)
            setConnectionError(
              tr(
                '无法连接：请连接相同类型的端点；数据流必须指向处理步骤，且不能连接自身或形成环。',
              ),
            );
        }}
        nodesDraggable={writable}
        nodesConnectable={writable}
        onlyRenderVisibleElements
        onSelectionChange={selectionChange}
        onNodeDoubleClick={(_, node) => {
          if (Date.now() - lastDrag.current > 300) onOpen(node.id);
        }}
        onNodeDragStart={(_, node, chosen) => {
          if (node) begin(node, chosen);
        }}
        onNodeDrag={(_, node) => {
          if (node) update(node);
        }}
        onNodeDragStop={finish}
        onSelectionDragStart={(_, chosen) => {
          if (chosen[0]) begin(chosen[0], chosen);
        }}
        onSelectionDrag={(_, chosen) => {
          const anchor = chosen.find((node) => node.id === drag.current?.anchor);
          if (anchor) update(anchor);
        }}
        onSelectionDragStop={finish}
        onMoveEnd={(_, next) => {
          if (drag.current) deferredViewport.current = next;
          else onViewport(next);
        }}
        {...(viewport ? { defaultViewport: viewport } : { fitView: true })}
        minZoom={0.2}
        maxZoom={2}
        nodeDragThreshold={6}
        nodeClickDistance={6}
        paneClickDistance={6}
        selectionOnDrag
        selectionKeyCode={null}
        panOnDrag={[1]}
        panActivationKeyCode="Space"
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        aria-label={tr('研究内容画布')}
        ariaLabelConfig={{
          'controls.zoomIn.ariaLabel': tr('放大画布'),
          'controls.zoomOut.ariaLabel': tr('缩小画布'),
          'controls.fitView.ariaLabel': tr('显示全部内容'),
          'controls.ariaLabel': tr('画布控制'),
          'node.a11yDescription.default': tr('单击选择，双击或按回车打开；使用方向键移动。'),
          'node.a11yDescription.keyboardDisabled': tr('单击选择，双击或按回车打开。'),
          'handle.ariaLabel': tr('内容关联端点'),
          'node.a11yDescription.ariaLiveMessage': ({ x, y }) =>
            tr('内容已移动到横坐标 {x}、纵坐标 {y}。', { x, y }),
        }}
      >
        <Background color="var(--line-strong)" gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {connectionError && (
        <div role="status" className="research-connection-error">
          {connectionError}
        </div>
      )}
    </div>
  );
}
