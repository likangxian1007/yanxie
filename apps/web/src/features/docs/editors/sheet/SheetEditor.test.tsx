import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { YDOC_FIELD, type DocumentMeta } from '@srh/shared';
import type { CollabDoc } from '../../collab/useCollabDoc';
import { prepareWorkbook } from './model/migrate';
import { Workbook } from './model/workbook';
import { SheetEditor } from './SheetEditor';

type Peer = CollabDoc['peers'][number];

function makeCollab(doc: Y.Doc, peers: CollabDoc['peers'] = []) {
  const provider = { setAwarenessField: vi.fn(), awareness: null };
  const collab = {
    doc,
    provider: provider as unknown as CollabDoc['provider'],
    status: 'connected',
    synced: true,
    me: { id: 'u1', name: '我', color: 'var(--palette-0)', colorIndex: 0, kind: 'user' },
    peers,
  } satisfies CollabDoc;
  return { collab, provider };
}

const meta = { id: 'd1', title: '实验结果', kind: 'sheet' } as unknown as DocumentMeta;

function lastAwareness(provider: { setAwarenessField: ReturnType<typeof vi.fn> }, key: string) {
  return provider.setAwarenessField.mock.calls.filter((c) => c[0] === key).at(-1)?.[1];
}

function peer(clientId: number, name: string, state: Record<string, unknown>): Peer {
  return {
    clientId,
    isSelf: false,
    user: { id: `u${clientId}`, name, color: 'var(--palette-3)', colorIndex: 3, kind: 'user' },
    state,
  } as Peer;
}

describe('SheetEditor', () => {
  it('renders evaluated values and follows remote changes', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    wb.setCells(
      's1',
      [
        { row: 0, col: 0, raw: '1' },
        { row: 1, col: 0, raw: '=A1+41' },
      ],
      'remote',
    );
    const { collab, provider } = makeCollab(doc);
    render(<SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(lastAwareness(provider, 'sheet')).toBe('s1');
    expect(lastAwareness(provider, 'cell')).toBe('r0:c0');
    // agent / 其他成员改了单元格：依赖它的公式自动重算
    act(() => wb.setCells('s1', [{ row: 0, col: 0, raw: '9' }], 'remote'));
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('keeps following the doc under StrictMode (effects mount twice)', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    const { collab } = makeCollab(doc);
    render(
      <StrictMode>
        <SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />
      </StrictMode>,
    );
    act(() => {
      wb.addSheet('remote', { name: '导入的表' });
    });
    expect(screen.getByRole('tab', { name: /导入的表/u })).toBeInTheDocument();
  });

  it('migrates a legacy single-sheet doc on open', () => {
    const doc = new Y.Doc();
    doc.getMap<string>(YDOC_FIELD.sheetCells).set('0:0', '旧数据');
    const { collab } = makeCollab(doc);
    render(<SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />);
    expect(screen.getByText('旧数据')).toBeInTheDocument();
    expect(doc.getMap(YDOC_FIELD.sheetCells).size).toBe(0);
    expect(screen.getByRole('tab', { name: /Sheet1/u })).toHaveAttribute('aria-selected', 'true');
  });

  it('types into the active cell, commits on Enter, then undoes only its own edit', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    const { collab, provider } = makeCollab(doc);
    render(<SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />);
    const sink = screen.getByLabelText('单元格内容');
    fireEvent.change(sink, { target: { value: '=1+2' } });
    fireEvent.keyDown(sink, { key: 'Enter' });
    expect(wb.sheet('s1').raw(0, 0)).toBe('=1+2');
    expect(lastAwareness(provider, 'cell')).toBe('r1:c0');
    // 别人同时改了 B1：撤销只撤我的
    act(() => wb.setCells('s1', [{ row: 0, col: 1, raw: '别人' }], 'remote'));
    act(() => {
      fireEvent.keyDown(sink, { key: 'z', ctrlKey: true });
    });
    expect(wb.sheet('s1').raw(0, 0)).toBeUndefined();
    expect(wb.sheet('s1').raw(0, 1)).toBe('别人');
  });

  it('名称框回车后焦点立即回到格子，紧接着输入写进跳转到的格子（终验：跳转后输入丢失）', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    const s2 = wb.addSheet('remote', { name: '汇总' });
    const { collab, provider } = makeCollab(doc);
    render(<SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />);
    const sink = screen.getByLabelText('单元格内容');
    const nameBox = screen.getByLabelText('名称框');
    act(() => nameBox.focus());
    fireEvent.change(nameBox, { target: { value: 'I2' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });
    // 不等下一帧：回车处理完焦点就已经在格子上
    expect(document.activeElement).toBe(sink);
    expect(lastAwareness(provider, 'cell')).toBe('r1:c8');
    fireEvent.change(sink, { target: { value: '=SUMIF(C2:C5,">0.7",D2:D5)' } });
    fireEvent.keyDown(sink, { key: 'Enter' });
    expect(wb.sheet('s1').raw(1, 8)).toBe('=SUMIF(C2:C5,">0.7",D2:D5)');
    expect(nameBox).toHaveValue('I3');

    // 跨表跳转也一样
    act(() => nameBox.focus());
    fireEvent.change(nameBox, { target: { value: '汇总!B2' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });
    expect(document.activeElement).toBe(sink);
    fireEvent.change(sink, { target: { value: '500' } });
    fireEvent.keyDown(sink, { key: 'Enter' });
    expect(wb.sheet(s2).raw(1, 1)).toBe('500');

    // 地址不对：留在名称框里改
    act(() => nameBox.focus());
    fireEvent.change(nameBox, { target: { value: '不是地址' } });
    fireEvent.keyDown(nameBox, { key: 'Enter' });
    expect(document.activeElement).toBe(nameBox);
  });

  it('shows peers on their selected range with a name label and on their sheet tab', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    const s2 = wb.addSheet('remote', { name: '汇总' });
    const { collab } = makeCollab(doc, [
      peer(7, '李四', { sheet: 's1', cell: 'r2:c1', range: ['r2:c1', 'r4:c3'] }),
      peer(8, '王五', { sheet: s2, cell: 'r0:c0' }),
      // 旧客户端：只有 "行:列" 下标
      peer(9, '赵六', { cell: '5:5' }),
    ]);
    const { container } = render(
      <SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable={false} />,
    );
    expect(container.querySelector('[data-peer-label="李四"]')).not.toBeNull();
    expect(container.querySelector('[data-peer-label="赵六"]')).not.toBeNull();
    // 王五在另一张表：网格上不显示，标签上显示
    expect(container.querySelector('[data-peer-label="王五"]')).toBeNull();
    expect(screen.getByLabelText('王五 在这张表')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /汇总/u }));
    expect(container.querySelector('[data-peer-label="王五"]')).not.toBeNull();
    expect(container.querySelector('[data-peer-label="李四"]')).toBeNull();
  });

  it('adds a sheet from the tab bar', () => {
    const doc = new Y.Doc();
    const { collab, provider } = makeCollab(doc);
    render(<SheetEditor projectId="p" docId="d1" meta={meta} collab={collab} editable />);
    fireEvent.click(screen.getByRole('button', { name: '新建工作表' }));
    const wb = new Workbook(doc);
    expect(wb.sheetIds()).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Sheet2/u })).toHaveAttribute('aria-selected', 'true');
    expect(lastAwareness(provider, 'sheet')).toBe(wb.sheetIds()[1]);
  });
});
