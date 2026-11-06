import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import type { NotebookCellType } from '@srh/shared';
import { toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import type { CollabPeer } from '@/features/docs/collab/useCollabDoc';
import { notebookActions } from '../api';
import {
  clearOutputs,
  deleteCells,
  insertCell,
  insertPlainCells,
  mergeCells,
  moveCell,
  plainOf,
  setCellType,
  splitCell,
  toggleOutputs,
  toggleSource,
  useNotebookView,
  type PlainCell,
} from '../model';
import { Cell } from './Cell';
import type { CellEditorHandle, CellEditorKeys } from './CellEditor';
import { NotebookToolbar } from './NotebookToolbar';
import { ShortcutsDialog } from './ShortcutsDialog';
import { VariablesSheet } from './VariablesSheet';
import { ProposalBanner } from '@/features/versioning/components/ProposalBanner';
import { VersionHistorySheet } from '@/features/versioning/components/VersionHistorySheet';
import { tr } from '@/lib/i18n';

/**
 * 1:1 Jupyter 的 notebook 视图。
 * 命令模式（蓝色左边条）/ 编辑模式（编辑器获得焦点）。命令模式快捷键与 JupyterLab 相同：
 *   Enter 编辑 · Shift+Enter 运行并下移 · Ctrl+Enter 运行 · Alt+Enter 运行并插入
 *   ↑/K ↓/J 选择 · Shift+↑/↓ 多选 · A/B 上方/下方插入 · X/C/V/Shift+V 剪切/复制/粘贴
 *   D,D 删除 · Z 撤销删除 · Y/M/R 代码/Markdown/Raw · 1–6 标题 · Shift+M 合并
 *   L 行号 · O 折叠输出 · Shift+O 折叠代码 · I,I 中断 · 0,0 重启 · H 快捷键帮助
 */

interface Props {
  pid: string;
  notebookId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  peers: CollabPeer[];
  writable: boolean;
  /** 内核服务是否可用（服务器没配内核时只能编辑） */
  kernelAvailable: boolean;
  title: string;
}

/** 剪贴板跨 notebook 共用（和 Jupyter 一样能在两个 notebook 之间复制单元格） */
let cellClipboard: PlainCell[] = [];

/** 等本地修改送到服务端再执行，否则服务端可能跑的是旧代码 */
async function flushProvider(provider: HocuspocusProvider, timeoutMs = 3000) {
  const start = Date.now();
  while (provider.hasUnsyncedChanges && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
  }
}

export function NotebookView({
  pid,
  notebookId,
  doc,
  provider,
  peers,
  writable,
  kernelAvailable,
  title,
}: Props) {
  const view = useNotebookView(doc);
  const actions = useMemo(() => notebookActions(pid, notebookId), [pid, notebookId]);
  const [selected, setSelected] = useState<string | null>(null);
  /** 多选的另一端（Shift+↑/↓） */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [mode, setMode] = useState<'command' | 'edit'>('command');
  /** 正在编辑的 Markdown 单元格（其余的显示渲染结果） */
  const [editingMd, setEditingMd] = useState<Set<string>>(() => new Set());
  const [lineNumbers, setLineNumbers] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showVars, setShowVars] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const deleted = useRef<{ index: number; cells: PlainCell[] }[]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const editors = useRef(new Map<string, CellEditorHandle>());
  const rows = useRef(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement>(null);

  const cells = useMemo(() => view?.cells ?? [], [view]);
  const ids = useMemo(() => cells.map((c) => c.id), [cells]);
  const current = selected && ids.includes(selected) ? selected : (ids[0] ?? null);
  const currentIndex = current ? ids.indexOf(current) : -1;

  const selection = useMemo(() => {
    if (!current) return [] as string[];
    if (!anchor || !ids.includes(anchor) || anchor === current) return [current];
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(current);
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  }, [anchor, current, ids]);

  // awareness：告诉别人我在哪个单元格、什么模式
  useEffect(() => {
    provider.setAwarenessField('cell', current);
    provider.setAwarenessField('mode', mode);
  }, [provider, current, mode]);

  /** 等编辑器挂上再给焦点（Markdown 从渲染态切到编辑器、新插入的单元格） */
  const pendingFocus = useRef<{ id: string; where: 'start' | 'end' | 'keep' } | null>(null);

  const focusRoot = useCallback(() => {
    pendingFocus.current = null;
    root.current?.focus({ preventScroll: true });
  }, []);

  const scrollTo = useCallback((id: string) => {
    requestAnimationFrame(() =>
      rows.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }, []);

  const select = useCallback(
    (id: string | null, opts: { extend?: boolean; scroll?: boolean } = {}) => {
      if (!id) return;
      if (opts.extend) setAnchor((a) => a ?? current);
      else setAnchor(null);
      setSelected(id);
      if (opts.scroll !== false) scrollTo(id);
    },
    [current, scrollTo],
  );

  const enterEdit = useCallback(
    (id: string, where: 'start' | 'end' | 'keep' = 'keep') => {
      if (!writable) return;
      setSelected(id);
      setAnchor(null);
      setMode('edit');
      setEditingMd((s) => (s.has(id) ? s : new Set(s).add(id)));
      // 编辑器已经在就立刻给焦点（同一个按键事件里），否则等它在这次提交里挂上
      const ed = editors.current.get(id);
      if (ed?.view()) {
        pendingFocus.current = null;
        ed.focus(where);
      } else pendingFocus.current = { id, where };
    },
    [writable],
  );

  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const ed = editors.current.get(p.id);
    if (!ed?.view()) return;
    pendingFocus.current = null;
    ed.focus(p.where);
  });

  const toCommand = useCallback(() => {
    setMode('command');
    focusRoot();
  }, [focusRoot]);

  // ------------------------------------------------------------ 执行

  const run = useCallback(
    async (targetIds: string[], after: 'stay' | 'advance' | 'insert') => {
      if (!writable) return;
      const targets = cells.filter((c) => targetIds.includes(c.id));
      // Markdown：渲染即可
      setEditingMd((s) => {
        const n = new Set(s);
        for (const c of targets) if (c.type !== 'code') n.delete(c.id);
        return n;
      });
      const code = targets.filter((c) => c.type === 'code').map((c) => c.id);
      const lastId = targetIds[targetIds.length - 1] ?? current;
      const lastIdx = lastId ? ids.indexOf(lastId) : -1;

      if (after === 'advance') {
        const next = ids[lastIdx + 1];
        if (next) {
          select(next);
          setMode('command');
          focusRoot();
        } else {
          const id = insertCell(doc, lastIdx + 1, 'code');
          enterEdit(id, 'start');
        }
      } else if (after === 'insert') {
        const id = insertCell(doc, lastIdx + 1, 'code');
        enterEdit(id, 'start');
      } else {
        setMode('command');
        focusRoot();
      }

      if (!code.length) return;
      if (!kernelAvailable) {
        toast.error(tr('没法运行'), tr('服务器还没有配置 Python 内核，暂时只能编辑。'));
        return;
      }
      await flushProvider(provider);
      try {
        await actions.execute(code);
      } catch (err) {
        toast.error(
          tr('运行失败'),
          err instanceof ApiRequestError ? err.message : tr('请稍后再试。'),
        );
      }
    },
    [
      writable,
      cells,
      current,
      ids,
      select,
      focusRoot,
      doc,
      enterEdit,
      kernelAvailable,
      provider,
      actions,
    ],
  );

  const runAll = useCallback(
    async (range: 'all' | 'above' | 'below') => {
      const i = currentIndex;
      const list =
        range === 'all'
          ? ids
          : range === 'above'
            ? ids.slice(0, Math.max(0, i))
            : ids.slice(Math.max(0, i));
      await run(list, 'stay');
    },
    [currentIndex, ids, run],
  );

  const control = useCallback(
    async (what: 'interrupt' | 'restart' | 'restartRunAll' | 'restartClear' | 'shutdown') => {
      try {
        if (what === 'interrupt') await actions.interrupt();
        else if (what === 'shutdown') await actions.shutdown();
        else {
          await flushProvider(provider);
          await actions.restart({
            runAll: what === 'restartRunAll',
            clearOutputs: what !== 'restart',
          });
        }
        if (what === 'restart')
          toast.success(tr('内核已重启'), tr('变量都清空了，需要重新运行单元格。'));
      } catch (err) {
        toast.error(
          tr('操作失败'),
          err instanceof ApiRequestError ? err.message : tr('请稍后再试。'),
        );
      }
    },
    [actions, provider],
  );

  // ------------------------------------------------------------ 结构编辑

  const insertAt = useCallback(
    (where: 'above' | 'below', type: NotebookCellType = 'code') => {
      if (!writable) return;
      const idx = currentIndex < 0 ? 0 : currentIndex + (where === 'below' ? 1 : 0);
      const id = insertCell(doc, idx, type);
      select(id);
      setMode('command');
      focusRoot();
    },
    [writable, currentIndex, doc, select, focusRoot],
  );

  const removeSelected = useCallback(
    (cut = false) => {
      if (!writable || !selection.length) return;
      const plain = cells.filter((c) => selection.includes(c.id)).map(plainOf);
      if (cut) cellClipboard = plain;
      const first = ids.indexOf(selection[0] ?? '');
      deleted.current.push({ index: first, cells: plain });
      if (deleted.current.length > 20) deleted.current.shift();
      const after =
        ids[ids.indexOf(selection[selection.length - 1] ?? '') + 1] ?? ids[first - 1] ?? null;
      deleteCells(doc, selection);
      setAnchor(null);
      if (after) setSelected(after);
    },
    [writable, selection, cells, ids, doc],
  );

  const undoDelete = useCallback(() => {
    const last = deleted.current.pop();
    if (!last || !writable) return;
    const newIds = insertPlainCells(doc, last.index, last.cells);
    if (newIds[0]) select(newIds[0]);
  }, [doc, select, writable]);

  const paste = useCallback(
    (where: 'above' | 'below') => {
      if (!writable || !cellClipboard.length) return;
      const idx = currentIndex < 0 ? 0 : currentIndex + (where === 'below' ? 1 : 0);
      const newIds = insertPlainCells(doc, idx, cellClipboard);
      const last = newIds[newIds.length - 1];
      if (last) select(last);
    },
    [writable, currentIndex, doc, select],
  );

  const changeType = useCallback(
    (type: NotebookCellType, heading?: number) => {
      if (!writable) return;
      for (const id of selection) {
        setCellType(doc, id, type);
        if (heading) {
          const c = cells.find((x) => x.id === id);
          if (c) {
            const src = c.text.toString();
            const stripped = src.replace(/^#{1,6}\s*/, '');
            doc.transact(() => {
              c.text.delete(0, c.text.length);
              c.text.insert(0, `${'#'.repeat(heading)} ${stripped}`);
            });
          }
        }
      }
    },
    [writable, selection, doc, cells],
  );

  // ------------------------------------------------------------ 命令模式快捷键

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 模式按焦点判断，不看 mode 状态（状态可能还没更新）：
    // 焦点在编辑器里 = 编辑模式，键交给 CodeMirror；否则就是命令模式，键一律在这里处理，进不了编辑器
    const t = e.target as HTMLElement;
    if (t.closest('.cm-editor')) return;
    // 焦点在输入框 / 菜单里时不拦
    if (t !== root.current && t.closest('input,textarea,select,[role=menu],[contenteditable=true]'))
      return;
    // 单元格里的按钮：Enter / 空格留给按钮自己
    if (
      t !== root.current &&
      (e.key === 'Enter' || e.key === ' ') &&
      t.closest('button,a,summary,[role=button]')
    )
      return;
    if (mode !== 'command') setMode('command');
    pendingFocus.current = null;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const now = Date.now();
    const double = (k: string) => {
      const hit = lastKey.current?.key === k && now - lastKey.current.at < 600;
      lastKey.current = hit ? null : { key: k, at: now };
      return hit;
    };
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (!current) return;
    if (key === 'Enter' && e.shiftKey) return (handled(), void run(selection, 'advance'));
    if (key === 'Enter' && mod) return (handled(), void run(selection, 'stay'));
    if (key === 'Enter' && e.altKey) return (handled(), void run(selection, 'insert'));
    if (key === 'Enter') return (handled(), enterEdit(current, 'keep'));
    if (mod && key.toLowerCase() === 's')
      return (handled(), toast.success(tr('已自动保存'), tr('每次修改都会实时同步给所有人。')));
    if (mod || e.altKey) return;
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (k === 'ArrowUp' || k === 'k') {
      handled();
      select(ids[Math.max(0, currentIndex - 1)] ?? null, { extend: e.shiftKey });
    } else if (k === 'ArrowDown' || k === 'j') {
      handled();
      select(ids[Math.min(ids.length - 1, currentIndex + 1)] ?? null, { extend: e.shiftKey });
    } else if (k === 'a' && !e.shiftKey) {
      handled();
      insertAt('above');
    } else if (k === 'b' && !e.shiftKey) {
      handled();
      insertAt('below');
    } else if (k === 'x') {
      handled();
      removeSelected(true);
    } else if (k === 'c') {
      handled();
      cellClipboard = cells.filter((c) => selection.includes(c.id)).map(plainOf);
      toast.success(tr('已复制 {count} 个单元格', { count: cellClipboard.length }));
    } else if (k === 'v') {
      handled();
      paste(e.shiftKey ? 'above' : 'below');
    } else if (k === 'd') {
      handled();
      if (double('d')) removeSelected(false);
    } else if (k === 'z' && !e.shiftKey) {
      handled();
      undoDelete();
    } else if (k === 'y') {
      handled();
      changeType('code');
    } else if (k === 'm' && e.shiftKey) {
      handled();
      if (writable) mergeCells(doc, selection);
    } else if (k === 'm') {
      handled();
      changeType('markdown');
    } else if (k === 'r') {
      handled();
      changeType('raw');
    } else if (/^[1-6]$/.test(k)) {
      handled();
      changeType('markdown', Number(k));
    } else if (k === 'l') {
      handled();
      setLineNumbers((v) => !v);
    } else if (k === 'o') {
      handled();
      for (const id of selection) (e.shiftKey ? toggleSource : toggleOutputs)(doc, id);
    } else if (k === 'i') {
      handled();
      if (double('i')) void control('interrupt');
    } else if (k === '0') {
      handled();
      if (double('0')) void control('restart');
    } else if (k === 'h') {
      handled();
      setShowHelp(true);
    } else if (k === 'Home') {
      handled();
      select(ids[0] ?? null);
    } else if (k === 'End') {
      handled();
      select(ids[ids.length - 1] ?? null);
    }
  };

  // ------------------------------------------------------------ 编辑模式键位（给每个编辑器）

  const keysFor = useCallback(
    (id: string): CellEditorKeys => ({
      run: (m) => void run([id], m),
      escape: () => {
        setSelected(id);
        toCommand();
      },
      split: (at) => {
        const nid = splitCell(doc, id, at);
        if (nid) enterEdit(nid, 'start');
      },
      leave: (dir) => {
        const i = ids.indexOf(id) + dir;
        const next = ids[i];
        if (next) enterEdit(next, dir < 0 ? 'end' : 'start');
      },
      complete: kernelAvailable
        ? async (code, pos) => {
            const r = await actions.complete(code, pos);
            return { matches: r.matches, from: r.cursor_start, to: r.cursor_end };
          }
        : undefined,
      focus: () => {
        setSelected(id);
        setAnchor(null);
        setMode('edit');
      },
    }),
    [run, toCommand, doc, enterEdit, ids, kernelAvailable, actions],
  );

  // 其他人所在的单元格（光标 / 选择）
  const peersByCell = useMemo(() => {
    const m = new Map<string, CollabPeer[]>();
    for (const p of peers) {
      if (p.isSelf) continue;
      const cell = p.state.cell;
      if (typeof cell !== 'string') continue;
      const list = m.get(cell) ?? [];
      list.push(p);
      m.set(cell, list);
    }
    return m;
  }, [peers]);

  if (!view) return null;
  const busy = Object.values(view.runs).some((r) => r.state === 'running');

  return (
    <div className="nb-root flex min-w-0 flex-col">
      <NotebookToolbar
        pid={pid}
        notebookId={notebookId}
        title={title}
        writable={writable}
        kernel={view.kernel}
        kernelAvailable={kernelAvailable}
        busy={busy}
        currentType={cells[currentIndex]?.type ?? 'code'}
        peers={peers}
        hasCells={cells.some((c) => c.source.trim() || c.outputs.length)}
        onInsert={() => insertAt('below')}
        onCut={() => removeSelected(true)}
        onCopy={() => {
          cellClipboard = cells.filter((c) => selection.includes(c.id)).map(plainOf);
        }}
        onPaste={() => paste('below')}
        onMove={(d) => current && moveCell(doc, current, d) && scrollTo(current)}
        onRun={() => void run(selection, 'advance')}
        onRunAll={(r) => void runAll(r)}
        onControl={(w) => void control(w)}
        onType={(t) => changeType(t)}
        onClearOutputs={(all) => clearOutputs(doc, all ? undefined : selection)}
        onToggleLineNumbers={() => setLineNumbers((v) => !v)}
        lineNumbers={lineNumbers}
        onShowVariables={() => setShowVars(true)}
        onShowHelp={() => setShowHelp(true)}
        onShowHistory={() => setShowHistory(true)}
        onImport={(text) => actions.importIpynb(text)}
      />

      <div className="mx-1 mb-2 empty:hidden">
        <ProposalBanner pid={pid} targetKind="notebook" targetId={notebookId} />
      </div>

      {view.kernel.error && (
        <p
          role="status"
          className="mx-1 mb-2 rounded-md bg-danger-soft px-3 py-2 text-caption text-danger"
        >
          {tr('内核：{error}', { error: view.kernel.error })}
        </p>
      )}

      <div
        ref={root}
        tabIndex={-1}
        role="list"
        aria-label={tr('单元格')}
        className="nb-cells flex flex-col gap-0.5 pb-40 outline-none"
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          // 焦点回到单元格列表本身 = 命令模式（编辑器失焦后状态别停在编辑模式）
          if (e.target === e.currentTarget) setMode('command');
        }}
      >
        {cells.map((c, i) => (
          <Cell
            key={c.id}
            ref={(el) => {
              if (el) rows.current.set(c.id, el);
              else rows.current.delete(c.id);
            }}
            editorRef={(h) => {
              if (h) editors.current.set(c.id, h);
              else editors.current.delete(c.id);
            }}
            cell={c}
            index={i}
            awareness={provider.awareness}
            run={view.runs[c.id] ?? null}
            selected={selection.includes(c.id)}
            active={c.id === current}
            mode={c.id === current ? mode : 'command'}
            editingMarkdown={editingMd.has(c.id)}
            writable={writable}
            lineNumbers={lineNumbers}
            peers={peersByCell.get(c.id) ?? []}
            keys={keysFor(c.id)}
            onSelect={(extend) => {
              select(c.id, { extend, scroll: false });
              if (mode === 'edit' && c.id !== current) setMode('command');
              focusRoot();
            }}
            onEdit={() => enterEdit(c.id, 'keep')}
            onRun={() => void run([c.id], 'stay')}
            onToggleOutputs={() => toggleOutputs(doc, c.id)}
            onToggleSource={() => toggleSource(doc, c.id)}
            onInsertBelow={(type) => {
              const id = insertCell(doc, i + 1, type);
              enterEdit(id, 'start');
            }}
          />
        ))}
        {writable && (
          <div className="mt-2 flex justify-center gap-2 opacity-70 transition-opacity hover:opacity-100">
            <button
              type="button"
              className="rounded-md border border-dashed border-line px-3 py-1.5 text-caption text-fg-muted hover:border-line-strong hover:text-fg"
              onClick={() => enterEdit(insertCell(doc, ids.length, 'code'), 'start')}
            >
              {tr('+ 代码')}
            </button>
            <button
              type="button"
              className="rounded-md border border-dashed border-line px-3 py-1.5 text-caption text-fg-muted hover:border-line-strong hover:text-fg"
              onClick={() => enterEdit(insertCell(doc, ids.length, 'markdown'), 'start')}
            >
              + Markdown
            </button>
          </div>
        )}
      </div>

      <ShortcutsDialog open={showHelp} onOpenChange={setShowHelp} />
      <VariablesSheet
        pid={pid}
        notebookId={notebookId}
        open={showVars}
        onOpenChange={setShowVars}
        executionCount={view.kernel.executionCount}
      />
      <VersionHistorySheet
        open={showHistory}
        onOpenChange={setShowHistory}
        pid={pid}
        targetKind="notebook"
        targetId={notebookId}
        title={title}
        editable={writable}
      />
    </div>
  );
}
