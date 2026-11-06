import type { ReactElement } from 'react';
import { act, fireEvent, render as rtlRender } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { cellsOf, insertCell } from '../model';
import { NotebookView } from './NotebookView';

// 工具栏 / 变量面板 / 快捷键帮助和键盘逻辑无关，换成空壳
vi.mock('./NotebookToolbar', () => ({ NotebookToolbar: () => null }));
vi.mock('./VariablesSheet', () => ({ VariablesSheet: () => null }));
vi.mock('./ShortcutsDialog', () => ({ ShortcutsDialog: () => null }));

beforeAll(() => {
  // jsdom 没有 Range 的几何 API，CodeMirror 测量时会用到
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  const rect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects ??= empty as unknown as () => DOMRectList;
  Range.prototype.getBoundingClientRect ??= rect;
});

function setup(sources: string[] = ['a = 1', 'b = 2']) {
  const doc = new Y.Doc();
  sources.forEach((s, i) => insertCell(doc, i, 'code', s));
  const awareness = new Awareness(doc);
  const provider = {
    setAwarenessField: vi.fn(),
    awareness,
    hasUnsyncedChanges: false,
  } as unknown as HocuspocusProvider;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={qc}>
      <NotebookView
        pid="p1"
        notebookId="nb1"
        doc={doc}
        provider={provider}
        peers={[]}
        writable
        kernelAvailable={false}
        title="测试"
      />
    </QueryClientProvider>
  );
  const utils = rtlRender(ui);
  const list = utils.getByRole('list', { name: '单元格' });
  const rows = () => Array.from(list.querySelectorAll<HTMLElement>('[data-cell-id]'));
  const activeRow = () => list.querySelector<HTMLElement>('.nb-active');
  const types = () =>
    cellsOf(doc)
      .toArray()
      .map((m) => String(m.get('type')));
  const texts = () =>
    cellsOf(doc)
      .toArray()
      .map((m) => String(m.get('source')));
  /** 连续按键，中间不等任何帧（模拟很快的连按）；键发给当前有焦点的元素 */
  const press = (...keys: string[]) => {
    for (const key of keys) {
      const target = (document.activeElement as HTMLElement | null) ?? list;
      fireEvent.keyDown(target, { key });
    }
  };
  act(() => list.focus());
  return { doc, list, rows, activeRow, types, texts, press };
}

describe('NotebookView 命令模式快捷键（快速连按）', () => {
  it('连按 J B B：每个新单元格都插在当前单元格下方', () => {
    const t = setup();
    const [c1, c2] = t.rows().map((r) => r.dataset.cellId);
    t.press('j', 'b', 'b');
    const ids = t.rows().map((r) => r.dataset.cellId);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(c1);
    expect(ids[1]).toBe(c2);
    // 第二个 B 插在第一个新单元格下面（以前会落回第一个单元格）
    expect(t.activeRow()?.dataset.cellId).toBe(ids[3]);
    expect(document.activeElement).toBe(t.list);
  });

  it('连按 M Y A D D Z K：作用在当前单元格上，字母不进任何单元格', () => {
    const t = setup(['x = 1', 'y = 2', 'z = 3']);
    t.press('j', 'm');
    expect(t.types()).toEqual(['code', 'markdown', 'code']);
    t.press('y');
    expect(t.types()).toEqual(['code', 'code', 'code']);
    t.press('a');
    expect(t.rows()).toHaveLength(4);
    expect(t.activeRow()?.dataset.cellId).toBe(t.rows()[1]?.dataset.cellId);
    t.press('d', 'd');
    expect(t.texts()).toEqual(['x = 1', 'y = 2', 'z = 3']);
    t.press('z');
    expect(t.rows()).toHaveLength(4);
    t.press('d', 'd', 'k', 'k');
    expect(t.rows()).toHaveLength(3);
    expect(t.activeRow()?.dataset.cellId).toBe(t.rows()[0]?.dataset.cellId);
    expect(t.texts()).toEqual(['x = 1', 'y = 2', 'z = 3']);
    expect(document.activeElement).toBe(t.list);
  });

  it('Enter 进编辑、Esc 回命令模式后马上按 M / B 都生效，焦点不跑到别的单元格', () => {
    const t = setup(['first', 'second']);
    t.press('j', 'Enter');
    const second = t.rows()[1]!;
    expect(second.contains(document.activeElement)).toBe(true);
    expect(second.classList.contains('nb-editing')).toBe(true);
    // 编辑器里的字母不当命令
    t.press('b');
    expect(t.rows()).toHaveLength(2);
    t.press('Escape');
    expect(document.activeElement).toBe(t.list);
    expect(second.classList.contains('nb-editing')).toBe(false);
    t.press('m', 'b');
    expect(t.types()).toEqual(['code', 'markdown', 'code']);
    expect(t.rows()).toHaveLength(3);
    expect(t.activeRow()?.dataset.cellId).toBe(t.rows()[2]?.dataset.cellId);
    // 第一个单元格的编辑器没拿到焦点，内容没变
    expect(t.rows()[0]!.contains(document.activeElement)).toBe(false);
    expect(t.texts()).toEqual(['first', 'second', '']);
  });

  it('撤销删除后按 Enter：编辑的是恢复出来的那个单元格', () => {
    const t = setup(['one', 'two', 'three']);
    t.press('j', 'd', 'd', 'z', 'Enter');
    expect(t.texts()[1]).toBe('two');
    expect(t.rows()[1]!.contains(document.activeElement)).toBe(true);
  });

  it('渲染态的 Markdown 单元格按 Enter：编辑器在同一次按键里拿到焦点', () => {
    const t = setup(['# 标题', 'code']);
    t.press('m');
    // Shift+Enter 渲染 Markdown 并跳到下一个，再 K 回来
    fireEvent.keyDown(t.list, { key: 'Enter', shiftKey: true });
    t.press('k');
    expect(t.rows()[0]!.querySelector('.cm-editor')).toBeNull();
    t.press('Enter');
    const row = t.rows()[0]!;
    expect(row.querySelector('.cm-editor')).not.toBeNull();
    expect(row.contains(document.activeElement)).toBe(true);
  });

  it('编辑器失焦后焦点回到列表：命令键照常生效（不会卡在编辑模式）', () => {
    const t = setup();
    t.press('Enter');
    expect(t.rows()[0]!.contains(document.activeElement)).toBe(true);
    act(() => t.list.focus());
    t.press('b');
    expect(t.rows()).toHaveLength(3);
  });
});
