import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PaperPdfViewer } from './PaperPdfViewer';
import { useState } from 'react';
import { PaperSelectionReader } from './PaperSelectionReader';
import type { PdfTextSelection } from './selection';

vi.mock('@/features/docs/editors/latex/compile/PdfViewer', () => ({
  loadPdfJs: async () => ({
    TextLayer: class {
      host: HTMLElement;
      constructor(input: { container: HTMLElement }) {
        this.host = input.container;
      }
      async render() {
        const span = document.createElement('span');
        span.textContent = 'Scientific research.';
        this.host.append(span);
      }
      cancel() {}
    },
  }),
}));
const viewport = {
  width: 612,
  height: 792,
  viewBox: [0, 0, 612, 792],
  convertToPdfPoint: (x: number, y: number) => [x, 792 - y],
};
const doc = {
  getPage: async () => ({
    userUnit: 1,
    getViewport: () => viewport,
    getTextContent: async () => ({ items: [{ str: 'Scientific research.' }] }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  }),
} as unknown as PDFDocumentProxy;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function SnapshotReader({ onSelection }: { onSelection: (selection: PdfTextSelection) => void }) {
  const [snapshot, setSnapshot] = useState<PdfTextSelection | null>(null);
  return (
    <>
      <PaperSelectionReader
        doc={doc}
        sizes={[{ width: 612, height: 792 }]}
        error={null}
        marks={[]}
        onTextSelected={(selection) => {
          setSnapshot(selection);
          onSelection(selection);
        }}
        onOpenTranslation={() => {}}
      />
      <p aria-label="侧栏原文">{snapshot?.text}</p>
    </>
  );
}

async function setup(snapshot = false, annotationMenu = false, askMenu = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  const onSelection = vi.fn();
  const onCreate = vi.fn();
  const onAsk = vi.fn();
  render(
    annotationMenu || askMenu ? (
      <PaperSelectionReader
        doc={doc}
        sizes={[{ width: 612, height: 792 }]}
        error={null}
        marks={[]}
        onTextSelected={onSelection}
        onOpenTranslation={() => {}}
        onCreateAnnotation={annotationMenu ? onCreate : undefined}
        onAskSelection={askMenu ? onAsk : undefined}
      />
    ) : snapshot ? (
      <SnapshotReader onSelection={onSelection} />
    ) : (
      <PaperPdfViewer
        doc={doc}
        sizes={[
          { width: 612, height: 792 },
          { width: 612, height: 792 },
        ]}
        error={null}
        marks={[]}
        onSelection={onSelection}
      />
    ),
  );
  const layer = screen.getByLabelText('第 1 页文字');
  await waitFor(() => expect(layer.querySelector('span')).not.toBeNull());
  const page = layer.parentElement!;
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 612,
    bottom: 792,
    width: 612,
    height: 792,
    toJSON: () => ({}),
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  onSelection.mockClear();
  return { layer, onSelection, onCreate, onAsk };
}
function choose(start: Node, end = start) {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent!.length);
  Object.defineProperty(range, 'getClientRects', {
    value: () => [{ left: 72, top: 60, right: 180, bottom: 74 }],
  });
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
}

function beginDrag(layer: HTMLElement) {
  const down = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(down, 'button', { value: 0 });
  fireEvent(layer, down);
}
describe('PDF 选区事件回归', () => {
  it.each([true, false])(
    '浮动菜单显示文字“引用到问答”，和标注权限独立（可标注=%s）',
    async (annotations) => {
      const { layer, onAsk, onCreate } = await setup(false, annotations, true);
      choose(layer.querySelector('span')!.firstChild!);
      const menu = await screen.findByRole('group', { name: '选区标注操作' });
      const quote = within(menu).getByRole('button', { name: '引用到问答' });
      expect(quote).toHaveTextContent('引用到问答');
      expect(onAsk).not.toHaveBeenCalled();
      expect(Boolean(within(menu).queryByRole('button', { name: '保存高亮' }))).toBe(annotations);
      fireEvent.pointerDown(quote);
      fireEvent.click(quote);
      expect(onAsk).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Scientific research.', page: 1 }),
      );
      expect(onCreate).not.toHaveBeenCalled();
      expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
      expect(screen.getByRole('button', { name: '引用到问答' })).toHaveTextContent('引用到问答');
    },
  );
  it('点击侧栏并定位原文后，不把同一选区的坐标微差再次当作划词翻译', async () => {
    const { layer, onSelection } = await setup(false, true);
    const text = layer.querySelector('span')!.firstChild!;
    choose(text);
    await waitFor(() => expect(onSelection).toHaveBeenCalledTimes(1));
    fireEvent.pointerDown(document.body, { button: 0 });
    const page = layer.parentElement!;
    const bounds = page.getBoundingClientRect();
    vi.mocked(page.getBoundingClientRect).mockReturnValue({
      ...bounds,
      top: bounds.top + 0.0001,
      bottom: bounds.bottom + 0.0001,
    });
    fireEvent.pointerUp(document.body);
    fireEvent(document, new Event('selectionchange'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(onSelection).toHaveBeenCalledTimes(1);
    // 仍然允许用户重新主动划选同一句，自动翻译不能因此失效。
    beginDrag(layer);
    choose(text);
    fireEvent.pointerUp(layer);
    await waitFor(() => expect(onSelection).toHaveBeenCalledTimes(2));
  });
  it('点击侧栏使尚未完成的选区计算失效，不由晚到结果抢回翻译栏目', async () => {
    const { layer, onSelection } = await setup();
    const pdfPage = await doc.getPage(1);
    let resolvePage!: (value: typeof pdfPage) => void;
    const getPage = vi.spyOn(doc, 'getPage').mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    choose(layer.querySelector('span')!.firstChild!);
    await waitFor(() => expect(getPage).toHaveBeenCalled());
    const outside = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(outside, 'button', { value: 0 });
    fireEvent(document.body, outside);
    await act(async () => {
      resolvePage(pdfPage);
      await Promise.resolve();
    });
    expect(onSelection.mock.calls.some(([value]) => value !== null)).toBe(false);
  });
  it('已选文字上开始拖选会重置选区，Shift 扩选和触摸手柄保留选区', async () => {
    const { layer } = await setup();
    const text = layer.querySelector('span')!.firstChild!;
    choose(text);
    beginDrag(layer);
    expect(window.getSelection()?.toString()).toBe('');
    fireEvent(document, new Event('pointerup'));
    for (const props of [
      { shiftKey: true, pointerType: 'mouse' },
      { shiftKey: false, pointerType: 'touch' },
    ]) {
      choose(text);
      const down = new Event('pointerdown', { bubbles: true });
      for (const [key, value] of Object.entries({ button: 0, ...props }))
        Object.defineProperty(down, key, { value });
      fireEvent(layer, down);
      expect(window.getSelection()?.toString()).toBe('Scientific research.');
      fireEvent(document, new Event('pointerup'));
    }
  });
  it('旧选区计算在新拖选期间返回时不能提交或触发翻译', async () => {
    const { layer, onSelection } = await setup();
    const pdfPage = await doc.getPage(1);
    let resolvePage!: (value: typeof pdfPage) => void;
    const pending = new Promise<typeof pdfPage>((resolve) => {
      resolvePage = resolve;
    });
    const getPage = vi.spyOn(doc, 'getPage').mockReturnValueOnce(pending);
    choose(layer.querySelector('span')!.firstChild!);
    await waitFor(() => expect(getPage).toHaveBeenCalled());
    beginDrag(layer);
    choose(layer.querySelector('span')!.firstChild!);
    await act(async () => {
      resolvePage(pdfPage);
      await pending;
    });
    expect(onSelection.mock.calls.some(([value]) => value !== null)).toBe(false);
    fireEvent(document, new Event('pointerup'));
    await waitFor(() =>
      expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })),
    );
  });
  it.each(['pointercancel', 'blur'])('%s 中断拖选后不翻译残留的半段文字', async (event) => {
    const { layer, onSelection } = await setup();
    beginDrag(layer);
    choose(layer.querySelector('span')!.firstChild!);
    fireEvent(event === 'blur' ? window : document, new Event(event));
    fireEvent(document, new Event('pointerup'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(onSelection.mock.calls.some(([value]) => value !== null)).toBe(false);
    expect(window.getSelection()?.toString()).toBe('');
    beginDrag(layer);
    choose(layer.querySelector('span')!.firstChild!);
    fireEvent(document, new Event('pointerup'));
    await waitFor(() =>
      expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })),
    );
  });
  it('焦点仍在翻译侧栏时，新的 PDF 选区也必须更新，不能沿用上一句', async () => {
    const { layer, onSelection } = await setup();
    const control = document.createElement('button');
    control.setAttribute('data-library-selection-tools', '');
    document.body.append(control);
    try {
      control.focus();
      choose(layer.querySelector('span')!.firstChild!);
      await waitFor(() =>
        expect(onSelection).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'Scientific research.' }),
        ),
      );
    } finally {
      control.remove();
    }
  });
  it('布局缩放只清除 PDF 坐标，侧栏的文字快照保留且不重复触发翻译', async () => {
    const { layer, onSelection } = await setup(true);
    choose(layer.querySelector('span')!.firstChild!);
    await waitFor(() =>
      expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })),
    );
    expect(screen.getByLabelText('侧栏原文')).toHaveTextContent('Scientific research.');
    onSelection.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByLabelText('侧栏原文')).toHaveTextContent('Scientific research.');
    expect(onSelection).not.toHaveBeenCalled();
  });
  it('鼠标拖选中不显示新工具条，松开后才报告选区，Esc 清除', async () => {
    const { layer, onSelection } = await setup();
    const text = layer.querySelector('span')!.firstChild!;
    // jsdom 的 PointerEvent 缺少 button，显式提供与鼠标主键相同的属性。
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(down, 'button', { value: 0 });
    fireEvent(layer, down);
    choose(text);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onSelection.mock.calls.some(([value]) => value !== null)).toBe(false);
    fireEvent(document, new Event('pointerup'));
    await waitFor(() =>
      expect(onSelection).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Scientific research.', page: 1 }),
      ),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSelection).toHaveBeenLastCalledWith(null);
  });
  it('跨页选区提示分次翻译，不把两页合成单页坐标', async () => {
    const { layer, onSelection } = await setup();
    const endLayer = screen.getByLabelText('第 2 页文字');
    await waitFor(() => expect(endLayer.querySelector('span')).not.toBeNull());
    choose(layer.querySelector('span')!.firstChild!, endLayer.querySelector('span')!.firstChild!);
    await waitFor(() =>
      expect(onSelection).toHaveBeenCalledWith(null, '请在同一页选择文字；跨页内容可以分次翻译。'),
    );
  });
  it('拖选结束才在指针附近显示两个标注入口；点击时保留原选区并交付同一段原文', async () => {
    const { layer, onCreate } = await setup(false, true);
    const text = layer.querySelector('span')!.firstChild!;
    fireEvent.pointerMove(layer);
    expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
    beginDrag(layer);
    choose(text);
    expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
    const up = new Event('pointerup', { bubbles: true });
    Object.defineProperties(up, {
      clientX: { value: 170 },
      clientY: { value: 70 },
    });
    fireEvent(layer, up);
    const menu = await screen.findByRole('group', { name: '选区标注操作' });
    expect(menu.querySelectorAll('button')).toHaveLength(2);
    expect(menu).toHaveStyle({ left: '182px', top: '82px' });
    const button = screen.getByRole('button', { name: '保存高亮' });
    const down = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe('Scientific research.');
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledWith(
      'highlight',
      expect.objectContaining({ text: 'Scientific research.', page: 1 }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
  });
  it('拖选在固定工具栏上松开仍结束拖动，不锁住后续选区读取', async () => {
    const { layer, onSelection } = await setup(false, true);
    beginDrag(layer);
    choose(layer.querySelector('span')!.firstChild!);
    fireEvent.pointerUp(document.querySelector('[data-library-selection-bar]')!);
    await screen.findByRole('group', { name: '选区标注操作' });
    expect(onSelection).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Scientific research.' }),
    );
  });
  it('键盘选区可用 Tab 到达批注入口；Escape 只关闭菜单，不触发保存或丢失原文', async () => {
    const { layer, onCreate } = await setup(false, true);
    choose(layer.querySelector('span')!.firstChild!);
    await screen.findByRole('group', { name: '选区标注操作' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '保存高亮' }));
    expect(window.getSelection()?.toString()).toBe('Scientific research.');
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '添加批注' }));
    expect(window.getSelection()?.toString()).toBe('Scientific research.');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
    expect(window.getSelection()?.toString()).toBe('Scientific research.');
    expect(onCreate).not.toHaveBeenCalled();
    beginDrag(layer);
    choose(layer.querySelector('span')!.firstChild!);
    fireEvent.pointerUp(layer);
    fireEvent.click(await screen.findByRole('button', { name: '添加批注' }));
    expect(onCreate).toHaveBeenCalledWith('comment', expect.objectContaining({ page: 1 }));
  });
  it('滚动原文或点击外部收起菜单；侧栏滚动不打断操作，新拖选可以重新显示', async () => {
    const { layer } = await setup(false, true);
    const chooseAgain = async () => {
      beginDrag(layer);
      choose(layer.querySelector('span')!.firstChild!);
      fireEvent.pointerUp(layer);
      return screen.findByRole('group', { name: '选区标注操作' });
    };
    await chooseAgain();
    const sidebar = document.createElement('aside');
    document.body.append(sidebar);
    try {
      fireEvent.scroll(sidebar);
      expect(screen.getByRole('group', { name: '选区标注操作' })).toBeInTheDocument();
      fireEvent.scroll(screen.getByLabelText('PDF 页面'));
      expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
      fireEvent(document, new Event('selectionchange'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
      await chooseAgain();
      fireEvent.pointerDown(sidebar);
      expect(screen.queryByRole('group', { name: '选区标注操作' })).toBeNull();
    } finally {
      sidebar.remove();
    }
  });
});
