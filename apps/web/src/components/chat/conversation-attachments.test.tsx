import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearSubmittedAttachments, useConversationAttachments } from './conversation-attachments';

function fileResponse(id: string, projectId: string) {
  return {
    ok: true,
    json: async () => ({
      id,
      projectId,
      name: '数据.csv',
      path: 'uploads/数据.csv',
      mime: 'text/csv',
      size: 1,
      uploadedBy: { kind: 'user', id: 'u', name: '成员' },
      createdAt: '2026-10-27T00:00:00.000Z',
    }),
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() =>
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }),
);
afterEach(() => vi.unstubAllGlobals());

describe('对话附件暂存', () => {
  it('按用户、课题、线程和频道隔离，关闭后上传仍继续', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const original = renderHook(() => useConversationAttachments('u-isolation', 'p', 't', 'agent'));
    const others = [
      renderHook(() => useConversationAttachments('other', 'p', 't', 'agent')),
      renderHook(() => useConversationAttachments('u-isolation', 'other', 't', 'agent')),
      renderHook(() => useConversationAttachments('u-isolation', 'p', 'other', 'agent')),
      renderHook(() => useConversationAttachments('u-isolation', 'p', 't', 'team')),
      renderHook(() => useConversationAttachments(undefined, 'p', 't', 'agent')),
    ];
    const file = new File(['a'], '数据.csv', { type: 'text/csv' });
    act(() => original.result.current.add([file]));
    expect(original.result.current.isUploading).toBe(true);
    for (const other of others) expect(other.result.current.files).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects/p/files');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.body as FormData).get('file')).toBe(file);
    expect((init.body as FormData).get('path')).toMatch(
      /^uploads\/conversations\/[^/]+\/数据\.csv$/u,
    );
    original.unmount();
    response.resolve(fileResponse('file-one', 'p'));
    const reopened = renderHook(() => useConversationAttachments('u-isolation', 'p', 't', 'agent'));
    await waitFor(() => expect(reopened.result.current.fileIds).toEqual(['file-one']));
    expect(reopened.result.current.isUploading).toBe(false);
    for (const other of others) expect(other.result.current.files).toEqual([]);
  });

  it('失败后保留附件，可重试或移除；被移除的请求完成后不会复活', async () => {
    const late = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(fileResponse('file-retry', 'p'))
      .mockReturnValueOnce(late.promise);
    vi.stubGlobal('fetch', fetchMock);
    const draft = renderHook(() => useConversationAttachments('u-retry', 'p', null, 'agent'));
    act(() => draft.result.current.add([new File(['a'], '结果.txt')]));
    await waitFor(() => expect(draft.result.current.hasErrors).toBe(true));
    expect(draft.result.current.files[0]?.error).toContain('无法连接服务器');
    const firstId = draft.result.current.files[0]!.id;
    act(() => draft.result.current.retry(firstId));
    await waitFor(() => expect(draft.result.current.fileIds).toEqual(['file-retry']));
    const firstPath = (fetchMock.mock.calls[0]![1].body as FormData).get('path');
    expect((fetchMock.mock.calls[1]![1].body as FormData).get('path')).toBe(firstPath);

    act(() => draft.result.current.add([new File(['b'], '未完成.txt')]));
    const pendingId = draft.result.current.files[1]!.id;
    const signal = fetchMock.mock.calls[2]![1].signal as AbortSignal;
    act(() => draft.result.current.remove(pendingId));
    expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(fileResponse('late', 'p')));
    expect(draft.result.current.fileIds).toEqual(['file-retry']);
    act(() => draft.result.current.remove(firstId));
    expect(draft.result.current.files).toEqual([]);
  });

  it('同名文件使用不同路径，每个草稿最多 20 个文件', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const draft = renderHook(() => useConversationAttachments('u-limit', 'p', null, 'team'));
    const files = Array.from({ length: 21 }, () => new File(['a'], 'CON?.txt'));
    act(() => draft.result.current.add(files));
    expect(draft.result.current.files).toHaveLength(20);
    expect(draft.result.current.notice).toContain('最多添加 20 个');
    const paths = fetchMock.mock.calls.map(([, init]) => (init.body as FormData).get('path'));
    expect(new Set(paths).size).toBe(20);
    expect(paths[0]).toMatch(/^uploads\/conversations\/[^/]+\/CON_\.txt$/u);
    act(() => {
      for (const item of draft.result.current.files) draft.result.current.remove(item.id);
    });
  });

  it('超过 20 MB 的文件留在草稿中等待移除，不发起上传', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const draft = renderHook(() => useConversationAttachments('u-large', 'p', null, 'agent'));
    const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.bin');
    act(() => draft.result.current.add([file]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(draft.result.current.hasErrors).toBe(true);
    expect(draft.result.current.files[0]?.error).toContain('不能超过 20 MB');
    act(() => draft.result.current.remove(draft.result.current.files[0]!.id));
    expect(draft.result.current.hasErrors).toBe(false);
  });

  it('成功后只清除已提交的文件，保留后来添加和失败的附件', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fileResponse('sent', 'p'))
      .mockResolvedValueOnce(fileResponse('later', 'p'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const draft = renderHook(() => useConversationAttachments('u-clear', 'p', 't', 'team'));
    const other = renderHook(() => useConversationAttachments('u-clear', 'p', 't', 'agent'));
    act(() => draft.result.current.add([new File(['a'], 'first.txt')]));
    await waitFor(() => expect(draft.result.current.fileIds).toEqual(['sent']));
    act(() =>
      draft.result.current.add([new File(['b'], 'later.txt'), new File(['c'], 'error.txt')]),
    );
    await waitFor(() => expect(draft.result.current.hasErrors).toBe(true));
    await waitFor(() => expect(draft.result.current.fileIds).toEqual(['sent', 'later']));
    act(() => clearSubmittedAttachments('u-clear', 'p', 't', 'agent', ['sent']));
    expect(draft.result.current.fileIds).toEqual(['sent', 'later']);
    act(() => draft.result.current.clearSubmitted(['sent']));
    expect(draft.result.current.fileIds).toEqual(['later']);
    expect(draft.result.current.files.map((file) => file.name)).toEqual(['later.txt', 'error.txt']);
    expect(draft.result.current.hasErrors).toBe(true);
    expect(other.result.current.files).toEqual([]);
  });
});
