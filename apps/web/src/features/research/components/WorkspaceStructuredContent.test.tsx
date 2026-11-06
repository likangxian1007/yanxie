import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  ResearchArtifactVersion,
  ResearchItem,
  ResearchItemPayload,
  ResearchItemSummary,
} from '@srh/shared';
import { api } from '@/lib/api';
import { researchApi } from '../data';
import { contentApi } from '../content-data';
import {
  ArtifactHistory,
  DraftContent,
  FigureContent,
  TableContent,
} from './WorkspaceStructuredContent';

function DraftHarness() {
  const [payload, setPayload] = useState<Extract<ResearchItemPayload, { kind: 'draft' }>>({
    kind: 'draft',
    blocks: [
      { id: 'one', kind: 'text', text: '第一段' },
      { id: 'two', kind: 'text', text: '第二段' },
    ],
  });
  return (
    <DraftContent pid="p" recordId="r" payload={payload} onChange={setPayload} disabled={false} />
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('草稿内容块可编辑、调整顺序和删除', async () => {
  vi.spyOn(researchApi, 'excerpts').mockResolvedValue([]);
  vi.spyOn(api, 'get').mockResolvedValue([] as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DraftHarness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('第 1 块文字'), { target: { value: '修改后的第一段' } });
  const first = screen.getByRole('region', { name: '内容块 1' });
  fireEvent.click(within(first).getByRole('button', { name: '下移' }));
  expect((screen.getByLabelText('第 2 块文字') as HTMLTextAreaElement).value).toBe(
    '修改后的第一段',
  );
  fireEvent.click(
    within(screen.getByRole('region', { name: '内容块 1' })).getByRole('button', { name: '删除' }),
  );
  expect((screen.getByLabelText('第 1 块文字') as HTMLTextAreaElement).value).toBe(
    '修改后的第一段',
  );
  fireEvent.click(screen.getByRole('button', { name: '添加文字' }));
  expect(screen.getByLabelText('第 2 块文字')).toBeTruthy();
});

function artifact(
  id: string,
  itemId: string,
  runId: string,
  outputKey: string,
  summary: string,
  origin: ResearchArtifactVersion['origin'] = 'ai_draft',
): ResearchArtifactVersion {
  return {
    id,
    itemId,
    version: 1,
    kind: 'note',
    mime: 'text/markdown',
    hash: id,
    size: 10,
    projectId: 'p',
    recordId: 'r',
    runId,
    stepId: 'step',
    outputKey,
    summary,
    origin,
    createdBy: { kind: 'user', id: 'u', name: '研究者' },
    createdAt: '2026-01-01T00:00:00Z',
    inputs: [],
  };
}

it('同一输出跨运行筛选历史，空页仍可继续加载，本条目的人工确认保留', async () => {
  const own = artifact('own', 'current', 'run-new', 'result', '当前结果');
  const confirmed = {
    ...artifact('confirmed', 'current', 'run-confirm', 'checked', '人工确认', 'member_report'),
    stepId: 'review',
  };
  const old = artifact('old', 'old-item', 'run-old', 'result', '旧运行结果');
  const other = artifact('other', 'other-item', 'run-old', 'different', '无关输出');
  const versions = vi
    .spyOn(contentApi, 'artifacts')
    .mockImplementation(async (_pid, _rid, id, cursor) => {
      if (id === 'current') return { items: [own, confirmed], nextCursor: null };
      if (id === 'step' && !cursor) return { items: [other], nextCursor: 'next' };
      if (id === 'step' && cursor === 'next') return { items: [old, own], nextCursor: null };
      throw new Error('unexpected request');
    });
  const fetchText = vi
    .fn()
    .mockResolvedValue({ ok: true, text: async () => '旧运行的固定笔记正文' });
  vi.stubGlobal('fetch', fetchText);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ArtifactHistory
        pid="p"
        recordId="r"
        itemId="current"
        producer={{ producerStepId: 'step', producerOutputKey: 'result' }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('本条目版本与人工确认'));
  const ownHistory = screen.getByText('本条目版本与人工确认').closest('details')!;
  expect(await within(ownHistory).findByText(/成员记录.*人工确认/)).toBeTruthy();
  fireEvent.click(screen.getByText('该步骤同输出历史'));
  const history = screen.getByText('该步骤同输出历史').closest('details')!;
  await within(history).findByText('已加载的记录中没有匹配产物，可继续加载。');
  expect(within(history).queryByText(/无关输出/)).toBeNull();
  fireEvent.click(within(history).getByRole('button', { name: '加载更多' }));
  const oldRow = (await within(history).findByText(/旧运行结果/)).closest('div')!;
  expect(oldRow).toHaveTextContent('条目 old-item · 条目内第 1 版 · 运行 run-old');
  expect(within(history).getByText(/当前结果/)).toHaveTextContent(
    '条目 current · 条目内第 1 版 · 运行 run-new',
  );
  expect(versions).toHaveBeenCalledWith('p', 'r', 'step', 'next', expect.anything());
  fireEvent.click(within(oldRow).getByRole('button', { name: '查看固定版本' }));
  const detail = within(history).getByRole('region', { name: '固定产物版本' });
  expect(detail).toHaveTextContent('条目 old-item · 条目内第 1 版 · 只读');
  expect(await within(detail).findByText('旧运行的固定笔记正文')).toBeTruthy();
  expect(fetchText).toHaveBeenCalledWith(
    expect.stringContaining('/artifacts/old/download'),
    expect.objectContaining({ credentials: 'include' }),
  );
});

it('表格和图像聚焦内容都提供对应步骤的历史入口', () => {
  vi.spyOn(contentApi, 'artifacts').mockResolvedValue({ items: [], nextCursor: null });
  const base = {
    id: 'table',
    projectId: 'p',
    recordId: 'r',
    title: '内容',
    body: '',
    resource: null,
    evidenceRef: null,
    origin: null,
    action: null,
    parentId: null,
    position: { x: 0, y: 0 },
    version: 1,
    positionVersion: 1,
    createdBy: { kind: 'user', id: 'u', name: '研究者' },
    updatedBy: { kind: 'user', id: 'u', name: '研究者' },
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
  };
  const table = { ...base, kind: 'table' } as ResearchItem;
  const figure = { ...base, id: 'figure', kind: 'figure' } as ResearchItem;
  const summaries = [table, figure].map((item) => ({
    ...item,
    actionKind: null,
    preview: '',
    originItemId: null,
    producerStepId: `step-${item.id}`,
    producerOutputKey: 'result',
  })) as ResearchItemSummary[];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TableContent
          pid="p"
          recordId="r"
          userId="u"
          item={table}
          items={summaries}
          payload={{ kind: 'table' }}
          disabled
          onChange={() => {}}
          onOpen={() => {}}
        />
        <FigureContent
          pid="p"
          recordId="r"
          item={figure}
          items={summaries}
          payload={{ kind: 'figure' }}
          disabled
          onChange={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getAllByText('该步骤同输出历史')).toHaveLength(2);
  expect(screen.getAllByText('本条目版本与人工确认')).toHaveLength(2);
});

it.each(['table', 'figure'] as const)(
  '同输出的历史 %s 以只读快照展示并保留固定输入',
  async (kind) => {
    const previous: ResearchArtifactVersion = {
      ...artifact('old-output', 'old-item', 'old-run', 'result', '以前的结果', 'computation'),
      kind,
      mime: kind === 'table' ? 'application/json' : 'image/svg+xml',
      inputs: ['source-snapshot'],
      metadata: {
        action: { chart: { kind: 'bar', xLabel: '组别', yLabel: '质量', missing: 'omit' } },
        pngArtifactId: 'old-png',
      },
    };
    vi.spyOn(contentApi, 'artifacts').mockResolvedValue({ items: [previous], nextCursor: null });
    const table = vi.spyOn(contentApi, 'artifactTable').mockResolvedValue({
      documentId: 'old-doc',
      sheetId: 'sheet',
      sourceVersion: 'old-version',
      hash: 'hash',
      columns: [{ id: 'mass', name: '质量', unit: 'kg' }],
      rows: [{ id: 'row', cells: { mass: 7 } }],
      totalRows: 1,
      nextCursor: null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ArtifactHistory
          pid="p"
          recordId="r"
          itemId="current"
          producer={{ producerStepId: 'step', producerOutputKey: 'result' }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('该步骤同输出历史'));
    await screen.findByText(/以前的结果/);
    fireEvent.click(screen.getByRole('button', { name: '查看固定版本' }));
    const detail = screen.getByRole('region', { name: '固定产物版本' });
    expect(detail).toHaveTextContent('条目 old-item · 条目内第 1 版 · 只读');
    expect(within(detail).getByRole('link', { name: 'source-snapshot' })).toHaveAttribute(
      'href',
      expect.stringContaining('/artifacts/source-snapshot/download'),
    );
    if (kind === 'table') {
      expect(await within(detail).findByText('7')).toBeTruthy();
      expect(within(detail).getByText('质量（kg）')).toBeTruthy();
      expect(table).toHaveBeenCalledWith('p', 'old-output', expect.anything());
    } else {
      expect(within(detail).getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('/artifacts/old-output/download?inline=1'),
      );
      expect(within(detail).getByText(/图表配置：bar/)).toHaveTextContent('组别');
      expect(within(detail).getByRole('link', { name: '下载此版本 PNG' })).toHaveAttribute(
        'href',
        expect.stringContaining('/artifacts/old-png/download'),
      );
      expect(table).not.toHaveBeenCalled();
    }
  },
);
