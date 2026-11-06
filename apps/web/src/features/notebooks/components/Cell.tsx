import { forwardRef, memo, useLayoutEffect, useRef, type Ref } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { NotebookCellType, NotebookRun } from '@srh/shared';
import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { CollabPeer } from '@/features/docs/collab/useCollabDoc';
import type { CellView } from '../model';
import { renderMarkdown } from '../render';
import { CellEditor, type CellEditorHandle, type CellEditorKeys } from './CellEditor';
import { CellOutputs } from './CellOutputs';
import { tr, trServer } from '@/lib/i18n';

/**
 * 一个单元格，版式照 JupyterLab：左侧 In [n]: 提示符 + 折叠条，右侧编辑器；下方 Out 区。
 * 选中时左边一条蓝色竖条；编辑模式时编辑器描边。
 * 运行中 In [*]，排队 In [ ]+时钟；别人正在运行时显示他的名字。
 */

interface Props {
  cell: CellView;
  index: number;
  awareness: Awareness | null | undefined;
  run: NotebookRun | null;
  selected: boolean;
  active: boolean;
  mode: 'command' | 'edit';
  editingMarkdown: boolean;
  writable: boolean;
  lineNumbers: boolean;
  peers: CollabPeer[];
  keys: CellEditorKeys;
  editorRef: Ref<CellEditorHandle>;
  onSelect: (extend: boolean) => void;
  onEdit: () => void;
  onRun: () => void;
  onToggleOutputs: () => void;
  onToggleSource: () => void;
  onInsertBelow: (type: NotebookCellType) => void;
}

function promptOf(cell: CellView, run: NotebookRun | null): string {
  if (cell.type !== 'code') return '';
  if (run?.state === 'running') return '[*]';
  if (run?.state === 'queued') return '[ ]';
  return `[${cell.executionCount ?? ' '}]`;
}

export const Cell = memo(
  forwardRef<HTMLDivElement, Props>(function Cell(props, ref) {
    const {
      cell,
      awareness,
      run,
      selected,
      active,
      mode,
      editingMarkdown,
      writable,
      lineNumbers,
      peers,
      keys,
      editorRef,
    } = props;
    const isCode = cell.type === 'code';
    const showRendered = cell.type === 'markdown' && !editingMarkdown;
    // 编辑器只在创建时拿一次这个 ref，之后靠 .current 读最新的回调；
    // ref 对象本身必须稳定，否则编辑器手里一直是第一次渲染时的旧回调（旧的单元格列表）
    const keysRef = useRef(keys);
    useLayoutEffect(() => {
      keysRef.current = keys;
    });
    const prompt = promptOf(cell, run);
    const editing = active && mode === 'edit';
    const hasOutputs = isCode && cell.outputs.length > 0;
    const runner = run ? trServer(run.by.name) : undefined;

    return (
      <div
        ref={ref}
        role="listitem"
        data-cell-id={cell.id}
        data-type={cell.type}
        className={cn(
          'nb-cell group relative rounded-md py-1 pr-2 transition-colors',
          selected && 'nb-selected',
          active && 'nb-active',
          editing && 'nb-editing',
          run?.state === 'running' && 'nb-running',
        )}
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          // 点到编辑器里由编辑器自己处理（进入编辑模式）
          if (t.closest('.cm-editor')) return;
          if (t.closest('a,button,summary')) return;
          props.onSelect(e.shiftKey);
          if (!t.closest('.nb-outputs')) e.preventDefault();
        }}
        onDoubleClick={(e) => {
          if (cell.type === 'markdown' && showRendered && writable) {
            e.preventDefault();
            props.onEdit();
          }
        }}
      >
        {/* 别人在这个单元格里 */}
        {peers.length > 0 && (
          <div className="pointer-events-none absolute -top-1 right-2 z-10 flex gap-1">
            {peers.map((p) => (
              <span
                key={p.clientId}
                className="rounded px-1.5 py-px text-[11px] font-medium leading-4 text-white shadow-xs"
                style={{ background: p.user.color }}
              >
                {p.user.name}
                {p.state.mode === 'edit' ? tr(' 正在编辑') : ''}
              </span>
            ))}
          </div>
        )}

        {/* ---- 输入区 ---- */}
        <div className="nb-row flex min-w-0 items-start">
          <div className="nb-collapser" aria-hidden onClick={props.onToggleSource} />
          <div
            className={cn('nb-prompt nb-in-prompt', run?.state === 'running' && 'text-accent-text')}
          >
            {isCode && (
              <>
                {writable && (
                  <button
                    type="button"
                    className="nb-run-btn"
                    aria-label={tr('运行这个单元格')}
                    title={tr('运行（Ctrl+Enter）')}
                    onClick={props.onRun}
                  >
                    <Play size={12} strokeWidth={2.25} />
                  </button>
                )}
                <span className="nb-prompt-text">In&nbsp;{prompt}:</span>
              </>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {cell.sourceHidden ? (
              <button type="button" className="nb-hidden-src" onClick={props.onToggleSource}>
                <ChevronRight size={14} />
                {tr(' 代码已折叠（')}
                {cell.source.split('\n').length} {tr('行），点击展开')}
              </button>
            ) : showRendered ? (
              cell.source.trim() ? (
                <div
                  className="nb-markdown nb-rendered"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source) }}
                />
              ) : (
                <div className="nb-markdown nb-rendered text-fg-subtle">
                  {writable ? tr('双击编辑 Markdown') : tr('（空的 Markdown 单元格）')}
                </div>
              )
            ) : (
              <div className={cn('nb-input', cell.type === 'raw' && 'nb-raw')}>
                <CellEditor
                  ref={editorRef}
                  text={cell.text}
                  awareness={awareness ?? null}
                  language={cell.type === 'code' ? 'python' : cell.type}
                  editable={writable}
                  showLineNumbers={lineNumbers}
                  keys={keysRef}
                  placeholder={
                    cell.type === 'markdown'
                      ? tr('# 标题、文字、公式 $E=mc^2$，Shift+Enter 渲染')
                      : cell.type === 'code' && props.index === 0
                        ? tr('import numpy as np   # Shift+Enter 运行')
                        : undefined
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* ---- 运行状态（谁在跑） ---- */}
        {run && (
          <div className="ml-[var(--nb-prompt-w)] flex items-center gap-1.5 pl-3 pt-0.5 text-caption text-fg-subtle">
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                run.state === 'running' ? 'animate-pulse bg-accent' : 'bg-fg-subtle',
              )}
            />
            {run.state === 'running' ? tr('正在运行') : tr('排队中')}
            {runner ? ` · ${runner}` : ''}
          </div>
        )}

        {/* ---- 输出区 ---- */}
        {hasOutputs && (
          <div className="nb-row flex min-w-0 items-start pt-1">
            <div className="nb-collapser" aria-hidden onClick={props.onToggleOutputs} />
            <div className="nb-prompt nb-out-prompt">
              {cell.outputs.some((o) => o.output_type === 'execute_result') &&
              !cell.outputsHidden ? (
                <span className="nb-prompt-text">Out[{cell.executionCount ?? ' '}]:</span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1 overflow-x-auto px-2">
              {cell.outputsHidden ? (
                <button type="button" className="nb-hidden-src" onClick={props.onToggleOutputs}>
                  <ChevronDown size={14} />
                  {tr(' 输出已折叠，点击展开')}
                </button>
              ) : (
                <CellOutputs outputs={cell.outputs} />
              )}
            </div>
          </div>
        )}
      </div>
    );
  }),
);
