import { useState } from 'react';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResearchItemSummary } from '@srh/shared';
import WorkspaceCanvas, { type WorkspaceMove } from './WorkspaceCanvas';

const items = [
  {
    id: 'a',
    kind: 'note',
    title: '田野笔记',
    preview: '一段观察',
    parentId: null,
    position: { x: 20, y: 20 },
    positionVersion: 1,
    actionKind: null,
  },
  {
    id: 'b',
    kind: 'note',
    title: '访谈',
    preview: '原文',
    parentId: null,
    position: { x: 300, y: 20 },
    positionVersion: 1,
    actionKind: null,
  },
] as ResearchItemSummary[];

class CanvasResizeObserver {
  private observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.observed.add(target);
    queueMicrotask(() => {
      if (this.observed.has(target))
        this.callback(
          [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
    });
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
}
class CanvasMatrix {
  m22: number;
  constructor(transform = '') {
    const matrix = /^matrix\(([^)]+)\)/u.exec(transform)?.[1]?.split(',').map(Number);
    const scale = /scale\(([^)]+)\)/u.exec(transform)?.[1];
    this.m22 = matrix?.[3] ?? (scale ? Number(scale) : 1);
  }
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', CanvasResizeObserver);
  vi.stubGlobal('DOMMatrixReadOnly', CanvasMatrix);
  const MouseEventConstructor = document.defaultView!.MouseEvent;
  class CanvasPointerEvent extends MouseEventConstructor {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal('PointerEvent', CanvasPointerEvent);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('react-flow__node') ? 220 : 900;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('react-flow__node') ? 120 : 600;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 900,
    bottom: 600,
    width: 900,
    height: 600,
    toJSON: () => ({}),
  }));
});
afterEach(() => vi.unstubAllGlobals());

function mount(
  open: (id: string) => void,
  move: (moves: WorkspaceMove[]) => void,
  entries = items,
) {
  function Example() {
    const [selected, setSelected] = useState<string[]>([]);
    return (
      <WorkspaceCanvas
        items={entries}
        relations={[]}
        selected={selected}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        writable
        onSelect={setSelected}
        onOpen={open}
        onMove={() => {}}
        onMoveMany={move}
        onConnect={() => {}}
        onViewport={() => {}}
      />
    );
  }
  return render(<Example />);
}

it('真实画布单击选择，标题双击、Enter 和打开按钮进入', async () => {
  const open = vi.fn();
  mount(open, vi.fn());
  const title = await screen.findByText('田野笔记', { selector: '.research-node-title' });
  const node = title.closest<HTMLElement>('.react-flow__node')!;
  await waitFor(() => expect(node).toBeVisible());
  fireEvent.click(title);
  await waitFor(() => expect(node.classList.contains('selected')).toBe(true));
  expect(open).not.toHaveBeenCalled();
  fireEvent.doubleClick(title);
  expect(open).toHaveBeenCalledWith('a');
  open.mockClear();
  node.focus();
  fireEvent.keyDown(node, { key: 'Enter' });
  expect(open).toHaveBeenCalledWith('a');
  open.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '打开 田野笔记' }));
  expect(open).toHaveBeenCalledWith('a');
});

it('真实画布拖动超过阈值只保存一次，不触发打开', async () => {
  const open = vi.fn();
  const move = vi.fn();
  mount(open, move);
  const title = await screen.findByText('田野笔记', { selector: '.research-node-title' });
  await waitFor(() => expect(title.closest('.react-flow__node')).toBeVisible());
  const domWindow = title.ownerDocument.defaultView!;
  // Vitest's jsdom proxy is rejected by MouseEvent's view validator; D3 still
  // needs the actual event window to register the drag's move and end handlers.
  const withView = (event: Event) => {
    Object.defineProperty(event, 'view', { value: domWindow });
    return event;
  };
  fireEvent(
    title,
    withView(createEvent.mouseDown(title, { button: 0, buttons: 1, clientX: 40, clientY: 40 })),
  );
  fireEvent(
    domWindow,
    withView(createEvent.mouseMove(domWindow, { buttons: 1, clientX: 50, clientY: 40 })),
  );
  fireEvent(
    domWindow,
    withView(createEvent.mouseMove(domWindow, { buttons: 1, clientX: 100, clientY: 40 })),
  );
  fireEvent(
    domWindow,
    withView(createEvent.mouseUp(domWindow, { button: 0, clientX: 100, clientY: 40 })),
  );
  await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
  expect(move.mock.calls[0]![0][0]).toMatchObject({ id: 'a', position: { y: 20 } });
  expect(move.mock.calls[0]![0][0].position.x).toBeGreaterThan(20);
  expect(open).not.toHaveBeenCalled();
});

it('真实画布 Shift 多选后键盘整体移动，空白单击清除选择', async () => {
  const move = vi.fn();
  const view = mount(vi.fn(), move);
  const first = (
    await screen.findByText('田野笔记', { selector: '.research-node-title' })
  ).closest<HTMLElement>('.react-flow__node')!;
  const second = screen
    .getByText('访谈', { selector: '.research-node-title' })
    .closest<HTMLElement>('.react-flow__node')!;
  await waitFor(() => {
    expect(first).toBeVisible();
    expect(second).toBeVisible();
  });
  fireEvent.click(first);
  await waitFor(() => expect(first.classList.contains('selected')).toBe(true));
  fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  fireEvent.click(second, { shiftKey: true });
  await waitFor(() => expect(second.classList.contains('selected')).toBe(true));
  expect(first.classList.contains('selected')).toBe(true);
  fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(move).toHaveBeenCalledTimes(1);
  expect(move.mock.calls[0]![0]).toEqual([
    { id: 'a', position: { x: 25, y: 20 } },
    { id: 'b', position: { x: 305, y: 20 } },
  ]);
  const pane = view.container.querySelector<HTMLElement>('.react-flow__pane')!;
  fireEvent.pointerDown(pane, {
    button: 0,
    pointerId: 1,
    isPrimary: true,
    clientX: 20,
    clientY: 500,
  });
  fireEvent.pointerUp(pane, {
    button: 0,
    pointerId: 1,
    isPrimary: true,
    clientX: 20,
    clientY: 500,
  });
  fireEvent.click(pane);
  await waitFor(() => expect(first.classList.contains('selected')).toBe(false));
  expect(second.classList.contains('selected')).toBe(false);
});

it('图表卡片显示已有图像，加载失败后仍可打开', async () => {
  const open = vi.fn();
  const figure = {
    ...items[0],
    id: 'figure',
    projectId: 'p1',
    kind: 'figure',
    title: '研究图表',
    previewImageFileId: 'file_1',
  } as ResearchItemSummary;
  mount(open, vi.fn(), [figure]);
  const image = await screen.findByAltText('研究图表预览');
  expect(image).toHaveAttribute('src', '/api/v1/projects/p1/files/file_1');
  expect(image).toHaveAttribute('draggable', 'false');
  fireEvent.error(image);
  expect(screen.getByText('图片无法加载，请打开查看。')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: '打开 研究图表' }));
  expect(open).toHaveBeenCalledWith('figure');
});
