import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { PaperAnnotation } from '@srh/shared';
import type { CollabDoc } from '@/features/docs/collab/useCollabDoc';
import { ApiRequestError } from '@/lib/api';
import { AnnotationPublicationPicker } from './components/AnnotationPublicationPicker';
import { AnnotationCreateDialog } from './components/AnnotationCreateDialog';
import { AnnotationBodyEditor } from './components/AnnotationBodyEditor';
import { AnnotationsPanel } from './components/AnnotationsPanel';

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  flush: vi.fn(),
  update: vi.fn(),
  restore: vi.fn(),
  trash: vi.fn(),
  rows: [] as PaperAnnotation[],
  collab: null as CollabDoc | null,
  error: null as Error | null,
  archived: false,
  editable: true,
}));
vi.mock('./annotations-api', () => ({
  annotationApi: mock,
  annotationsKey: () => ['annotations'],
  usePaperAnnotations: () => ({
    data: mock.rows,
    isPending: false,
    error: mock.error,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/features/docs/collab/useCollabDoc', () => ({ useCollabDoc: () => mock.collab }));
vi.mock('./lib/reader', () => ({
  useReader: () => ({
    scope: 'prj_team',
    paper: {
      id: 'ppr_a',
      fileId: 'fil_a',
      archivedAt: mock.archived ? '2026-11-01T00:00:00Z' : null,
    },
    editable: mock.editable,
  }),
}));
const scope = { kind: 'personal' as const, userId: 'usr_a' };
const actor = { kind: 'user' as const, id: 'usr_a', name: '小王' };
function row(extra: Partial<PaperAnnotation> = {}): PaperAnnotation {
  return {
    id: 'lan_a',
    paperId: 'ppr_a',
    kind: 'highlight',
    color: 'yellow',
    label: '重要证据',
    fileId: 'fil_a',
    pdfSha256: 'hash',
    page: 1,
    quote: 'Scientific evidence.',
    boxes: [{ page: 1, x: 72, y: 60, w: 108, h: 14 }],
    anchorStatus: 'current',
    body: '',
    version: 1,
    metadataVersion: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    deletedAt: null,
    restoredToId: null,
    publishedFrom: null,
    ...extra,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.rows = [
    row(),
    row({ id: 'lan_b', kind: 'comment', label: '私人解释', body: '未选中的私人内容' }),
  ];
  mock.collab = null;
  mock.error = null;
  mock.archived = false;
  mock.editable = true;
});
afterEach(() => {
  mock.collab?.doc.destroy();
  vi.useRealTimers();
});

describe('标注选择发布', () => {
  it('默认不选，勾选后必须预览，只提交所选 ID 与当前版本', async () => {
    const onChange = vi.fn();
    mock.flush.mockResolvedValue(row({ version: 3 }));
    render(
      <AnnotationPublicationPicker
        scope={scope}
        paperId="ppr_a"
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的高亮和批注' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: '预览所选标注' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ id: 'lan_a', version: 3 }]));
    expect(mock.flush).toHaveBeenCalledExactlyOnceWith(scope, 'ppr_a', 'lan_a');
    expect(screen.queryByText('未选中的私人内容')).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it('文件不匹配不可选，预览失败不放行发布', async () => {
    mock.rows[0] = row({ anchorStatus: 'mismatch' });
    mock.flush.mockRejectedValue(new Error('标注已删除'));
    const onChange = vi.fn();
    render(
      <AnnotationPublicationPicker
        scope={scope}
        paperId="ppr_a"
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的高亮和批注' }));
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByRole('button', { name: '预览所选标注' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('标注已删除');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
describe('标注创建和维护', () => {
  it('点击目录在本条下面展开并定位原文，切换和收起不打乱其余条目', () => {
    const qc = new QueryClient();
    const onJump = vi.fn();
    function Directory() {
      const [active, setActive] = useState('');
      return <AnnotationsPanel activeId={active} onSelect={setActive} onJump={onJump} />;
    }
    const ui = render(
      <QueryClientProvider client={qc}>
        <Directory />
      </QueryClientProvider>,
    );
    const list = screen.getByRole('list', { name: '标注列表' });
    const items = within(list).getAllByRole('listitem');
    const first = within(items[0]!).getByRole('button');
    const second = within(items[1]!).getByRole('button');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(within(items[0]!).getByRole('region', { name: '标注详情' })).toBeInTheDocument();
    expect(within(items[1]!).queryByRole('region', { name: '标注详情' })).toBeNull();
    expect(onJump).toHaveBeenLastCalledWith(mock.rows[0], false);
    fireEvent.click(second);
    expect(within(items[0]!).queryByRole('region', { name: '标注详情' })).toBeNull();
    expect(within(items[1]!).getByRole('region', { name: '标注详情' })).toBeInTheDocument();
    expect(onJump).toHaveBeenLastCalledWith(mock.rows[1], false);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(second);
    expect(screen.queryByRole('region', { name: '标注详情' })).toBeNull();
    expect(onJump).toHaveBeenCalledTimes(2);
    ui.unmount();
    qc.clear();
  });
  it('失配或已删除的目录项可以展开查看，但不跳转错误原文', () => {
    const qc = new QueryClient(),
      onJump = vi.fn(),
      onSelect = vi.fn();
    mock.rows = [
      row({ anchorStatus: 'mismatch' }),
      row({ id: 'lan_b', kind: 'comment', deletedAt: '2026-11-02T00:00:00Z' }),
    ];
    const ui = render(
      <QueryClientProvider client={qc}>
        <AnnotationsPanel activeId="" onSelect={onSelect} onJump={onJump} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /高亮 · 第 1 页/ }));
    expect(onSelect).toHaveBeenLastCalledWith('lan_a');
    fireEvent.click(screen.getByRole('button', { name: '查看已删除' }));
    fireEvent.click(screen.getByRole('button', { name: /批注 · 第 1 页/ }));
    expect(onSelect).toHaveBeenLastCalledWith('lan_b');
    expect(onJump).not.toHaveBeenCalled();
    ui.unmount();
    qc.clear();
  });
  it('保存批注带当前文件与原文位置，失败保留输入，成功返回新记录', async () => {
    const onCreated = vi.fn();
    mock.create
      .mockRejectedValueOnce(new Error('网络暂不可用'))
      .mockResolvedValueOnce(row({ kind: 'comment', body: '待核对实验' }));
    render(
      <AnnotationCreateDialog
        scope={scope}
        paperId="ppr_a"
        draft={{
          kind: 'comment',
          fileId: 'fil_a',
          selection: { text: 'Scientific evidence.', page: 1, boxes: row().boxes, warning: null },
        }}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    fireEvent.change(screen.getByLabelText('新批注正文'), { target: { value: '待核对实验' } });
    fireEvent.click(screen.getByRole('button', { name: '保存标注' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络暂不可用');
    expect(screen.getByLabelText('新批注正文')).toHaveValue('待核对实验');
    fireEvent.click(screen.getByRole('button', { name: '保存标注' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mock.create).toHaveBeenLastCalledWith(
      scope,
      'ppr_a',
      expect.objectContaining({
        fileId: 'fil_a',
        kind: 'comment',
        quote: row().quote,
        boxes: row().boxes,
        body: '待核对实验',
      }),
    );
  });
  it('颜色冲突展示最新内容且保留草稿，确认后用新版本重试', async () => {
    const qc = new QueryClient();
    mock.update
      .mockRejectedValueOnce(
        new ApiRequestError({
          status: 409,
          code: 'version_conflict',
          message: '标注已被修改',
          details: { current: row({ color: 'blue', label: '他人说明', metadataVersion: 2 }) },
        }),
      )
      .mockResolvedValueOnce(row({ metadataVersion: 3 }));
    const ui = render(
      <QueryClientProvider client={qc}>
        <AnnotationsPanel activeId="lan_a" onSelect={vi.fn()} onJump={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '修改颜色与说明' }));
    fireEvent.change(screen.getByLabelText('新的标注说明'), { target: { value: '我的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText(/服务器最新内容/)).toHaveTextContent('他人说明');
    expect(screen.getByLabelText('新的标注说明')).toHaveValue('我的草稿');
    fireEvent.click(screen.getByRole('button', { name: '已核对，保留草稿继续修改' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() =>
      expect(mock.update).toHaveBeenLastCalledWith('prj_team', 'ppr_a', 'lan_a', {
        color: 'yellow',
        label: '我的草稿',
        baseMetadataVersion: 2,
      }),
    );
    ui.unmount();
    qc.clear();
  });
  it('原文版本失配阻止定位；归档隐藏修改入口', () => {
    const qc = new QueryClient();
    mock.rows = [row({ anchorStatus: 'mismatch' })];
    mock.archived = true;
    const ui = render(
      <QueryClientProvider client={qc}>
        <AnnotationsPanel activeId="lan_a" onSelect={vi.fn()} onJump={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: '定位原文' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '修改颜色与说明' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('定位待确认');
    ui.unmount();
    qc.clear();
  });
});
describe('批注同步状态', () => {
  function collab() {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, '本地草稿');
    mock.collab = {
      doc,
      status: 'connected',
      synced: true,
      ready: true,
      unsynced: 0,
      peers: [],
    } as unknown as CollabDoc;
  }
  it('保存请求期间继续输入，不把未保存的新内容标成已保存', async () => {
    collab();
    let resolve!: (v: PaperAnnotation) => void;
    mock.flush.mockReturnValue(
      new Promise<PaperAnnotation>((r) => {
        resolve = r;
      }),
    );
    render(<AnnotationBodyEditor scope={scope} annotation={row({ kind: 'comment' })} writable />);
    fireEvent.click(screen.getByRole('button', { name: '立即保存批注' }));
    act(() => mock.collab!.doc.getText('body').insert(0, '新文字'));
    await act(async () => resolve(row({ kind: 'comment', body: '本地草稿' })));
    expect(screen.getByRole('status')).not.toHaveTextContent('批注已保存到服务器');
  });
  it.each(['deleted', 'denied'])('%s 后草稿可读可复制但不能继续编辑', (reason) => {
    collab();
    if (reason === 'denied') mock.collab!.status = 'denied';
    render(
      <AnnotationBodyEditor
        scope={scope}
        annotation={row({
          kind: 'comment',
          deletedAt: reason === 'deleted' ? '2026-11-01T00:00:00Z' : null,
        })}
        writable
      />,
    );
    expect(screen.getByLabelText('批注正文')).toHaveValue('本地草稿');
    expect(screen.getByLabelText('批注正文')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '复制批注正文' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '立即保存批注' })).toBeNull();
  });
});
