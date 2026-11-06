import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ResearchAction,
  type ResearchItem,
  type ResearchItemSummary,
  type ResearchRecord,
} from '@srh/shared';
import { workspaceApi, workspaceStorageKey } from '../workspace-data';
import { ResearchRecordPage } from './ResearchRecordPage';

const layout = vi.hoisted(() => ({ compact: false, canvasRenders: 0 }));
vi.mock('@/lib/project', () => ({
  useProjectId: () => 'p1',
  useMyRole: () => 'owner',
  canWrite: () => true,
}));
vi.mock('@/lib/session', () => ({ useMeUser: () => ({ id: 'u1' }) }));
vi.mock('@/lib/realtime', () => ({ useProjectEvent: () => undefined }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => layout.compact }));
vi.mock('../components/WorkspaceCanvas', () => ({
  default: (props: {
    selected: string[];
    viewport: { x: number } | null;
    onSelect: (ids: string[]) => void;
    onOpen: (id: string) => void;
    onMoveMany: (moves: { id: string; position: { x: number; y: number } }[]) => void;
    onViewport: (view: { x: number; y: number; zoom: number }) => void;
    onDataConnect: (value: { fromItemId: string; toItemId: string; outputKey?: string }) => void;
  }) => {
    layout.canvasRenders++;
    return (
      <div>
        <span>
          视口 {props.viewport?.x ?? '初始'} / 已选 {props.selected.join(',')}
        </span>
        <button onClick={() => props.onOpen('rwi_1')}>打开画布内容</button>
        <button
          onClick={() =>
            props.onDataConnect({ fromItemId: 'source', toItemId: 'target', outputKey: 'result' })
          }
        >
          连接自动步骤
        </button>
        <button onClick={() => props.onMoveMany([{ id: 'rwi_1', position: { x: 10, y: 0 } }])}>
          移动到十
        </button>
        <button onClick={() => props.onMoveMany([{ id: 'rwi_1', position: { x: 20, y: 0 } }])}>
          移动到二十
        </button>
        <button onClick={() => props.onSelect(['rwi_1'])}>选中画布内容</button>
        <button onClick={() => props.onViewport({ x: 123, y: 45, zoom: 1.2 })}>移动画布</button>
      </div>
    );
  },
}));
vi.mock('../components/WorkspaceItemEditor', () => ({
  WorkspaceItemEditor: (props: { itemId: string; onClose: () => void }) => (
    <div>
      聚焦 {props.itemId}
      <button onClick={props.onClose}>返回总览</button>
    </div>
  ),
}));
vi.mock('../components/WorkspaceEvidenceDialog', () => ({
  default: (props: { view: string; onClose: () => void }) => (
    <div role="dialog">
      依据视图 {props.view}
      <button onClick={props.onClose}>关闭依据</button>
    </div>
  ),
}));
const item = {
  id: 'rwi_1',
  kind: 'note',
  title: '田野笔记',
  preview: '观察',
  parentId: null,
  position: { x: 0, y: 0 },
  version: 1,
  positionVersion: 1,
  archivedAt: null,
} as unknown as ResearchItemSummary;
const record = { id: 'r1', title: '研究', question: '', version: 1 } as ResearchRecord;
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="当前位置">{location.search}</output>
      <button onClick={() => navigate(-1)}>浏览器后退</button>
    </>
  );
}
function mount(url = '/p/p1/research/r1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/p/:projectId/research/:recordId"
            element={
              <>
                <ResearchRecordPage />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  layout.compact = false;
  layout.canvasRenders = 0;
  vi.spyOn(workspaceApi, 'load').mockResolvedValue({ record, items: [item], relations: [] });
});
afterEach(() => vi.restoreAllMocks());

it('键盘打开内容后返回，保留选中、URL 与画布视口', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '移动画布' }));
  fireEvent.click(screen.getByRole('button', { name: '选中画布内容' }));
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(await screen.findByText('聚焦 rwi_1')).toBeTruthy();
  expect(screen.getByLabelText('当前位置').textContent).toBe('?item=rwi_1');
  fireEvent.click(screen.getByRole('button', { name: '返回总览' }));
  expect(await screen.findByText('视口 123 / 已选 rwi_1')).toBeTruthy();
  expect(screen.getByLabelText('当前位置').textContent).toBe('');
  const saved = JSON.parse(localStorage.getItem(`${workspaceStorageKey('u1', 'p1', 'r1')}:view`)!);
  expect(saved.viewport).toEqual({ x: 123, y: 45, zoom: 1.2 });
});

it('选中内容后，工具栏按钮和链接的 Enter 不被全局打开快捷键截获', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '选中画布内容' }));
  for (const control of [
    screen.getByRole('button', { name: '运行与结果' }),
    screen.getByRole('link', { name: '研究列表' }),
  ]) {
    expect(fireEvent.keyDown(control, { key: 'Enter' })).toBe(true);
    expect(screen.queryByText('聚焦 rwi_1')).toBeNull();
    expect(screen.getByLabelText('当前位置').textContent).toBe('');
  }
});

it('窄屏默认列表，不加载画布，列表可多选并用键盘打开', async () => {
  layout.compact = true;
  mount();
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择 田野笔记' }));
  expect(layout.canvasRenders).toBe(0);
  fireEvent.keyDown(document, { key: 'Enter' });
  await waitFor(() => expect(screen.getByLabelText('当前位置').textContent).toBe('?item=rwi_1'));
});

it('旧栏目链接进入研究空间的只读历史，关闭后保留聚焦内容', async () => {
  mount('/p/p1/research/r1?section=process&item=rwi_1');
  expect(await screen.findByText('聚焦 rwi_1')).toBeTruthy();
  expect((await screen.findByRole('dialog')).textContent).toContain('依据视图 history');
  expect(screen.queryByText('原记录与字段')).toBeNull();
  expect(screen.queryByRole('tab', { name: '过程' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭依据' }));
  expect(screen.getByLabelText('当前位置').textContent).toBe('?item=rwi_1');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('既有结论链接在研究空间按需打开依据，不回到旧表单', async () => {
  mount('/p/p1/research/r1?section=findings');
  expect(await screen.findByText('视口 初始 / 已选')).toBeTruthy();
  expect((await screen.findByRole('dialog')).textContent).toContain('依据视图 findings');
  expect(screen.queryByText('采用新版模板')).toBeNull();
});

it('连续移动后逐次撤销使用当前布局版本，不回到过期版本', async () => {
  let positionVersion = 1;
  const save = vi
    .spyOn(workspaceApi, 'layout')
    .mockImplementation(async (_pid, _record, input) => ({
      items: input.moves.map((move) => ({
        ...item,
        body: '观察',
        action: null,
        origin: null,
        position: move.position,
        positionVersion: ++positionVersion,
      })) as ResearchItem[],
    }));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '移动到十' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '撤销 移动布局' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '移动到二十' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: '撤销 移动布局' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '撤销 移动布局' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole('button', { name: '撤销 移动布局' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '撤销 移动布局' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(4));
  expect(save.mock.calls.map((call) => call[2].moves[0]?.basePositionVersion)).toEqual([
    1, 2, 3, 4,
  ]);
  expect(save.mock.calls.map((call) => call[2].moves[0]?.position.x)).toEqual([10, 20, 10, 0]);
});

it('浏览器后退关闭聚焦也恢复进入前的原选择', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '移动画布' }));
  fireEvent.click(screen.getByRole('button', { name: '打开画布内容' }));
  expect(await screen.findByText('聚焦 rwi_1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '浏览器后退' }));
  await waitFor(() => expect(screen.getByLabelText('当前位置').textContent).toBe(''));
  expect(await screen.findByText('视口 123 / 已选')).toBeTruthy();
});

it('首次连接未知自动产物时先选择类型并持久化具名输出', async () => {
  const source = {
    ...item,
    id: 'source',
    kind: 'action',
    title: '自动处理',
    actionKind: 'ai',
    actionOutputs: [],
  } as ResearchItemSummary;
  const target = {
    ...item,
    id: 'target',
    kind: 'action',
    title: '下游',
    actionKind: 'ai',
    actionOutputs: [],
  } as ResearchItemSummary;
  const action = {
    kind: 'ai',
    instructions: '',
    inputItemIds: [],
    notebookId: null,
    cellIds: [],
    model: null,
    effort: null,
    profile: null,
    processing: { mode: 'auto', expectedOutputs: [] },
  } as ResearchItem['action'];
  vi.mocked(workspaceApi.load).mockResolvedValue({
    record,
    items: [source, target],
    relations: [],
  });
  const fullItem = (id: string, itemAction: ResearchItem['action']): ResearchItem => ({
    id,
    projectId: 'p1',
    recordId: 'r1',
    kind: 'action',
    title: id === 'source' ? '自动处理' : '下游',
    body: '',
    resource: null,
    evidenceRef: null,
    origin: null,
    action: itemAction,
    parentId: null,
    position: { x: 0, y: 0 },
    version: 1,
    positionVersion: 1,
    createdBy: { kind: 'user', id: 'u1', name: '甲' },
    updatedBy: { kind: 'user', id: 'u1', name: '甲' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
  });
  vi.spyOn(workspaceApi, 'item').mockImplementation(async (_pid, _record, id) =>
    fullItem(id, action),
  );
  const update = vi
    .spyOn(workspaceApi, 'updateItem')
    .mockImplementation(async (_pid, _record, id, input) =>
      fullItem(id, ResearchAction.parse(input.action ?? action)),
    );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '连接自动步骤' }));
  fireEvent.change(await screen.findByLabelText('产物类型'), { target: { value: 'table' } });
  fireEvent.click(screen.getByRole('button', { name: '建立连接' }));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'p1',
      'r1',
      'source',
      expect.objectContaining({
        action: expect.objectContaining({ outputs: [{ key: 'table', kind: 'table' }] }),
      }),
    ),
  );
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      'p1',
      'r1',
      'target',
      expect.objectContaining({
        action: expect.objectContaining({
          inputs: [
            expect.objectContaining({
              source: { kind: 'output', stepId: 'source', outputKey: 'table' },
            }),
          ],
        }),
      }),
    ),
  );
});
