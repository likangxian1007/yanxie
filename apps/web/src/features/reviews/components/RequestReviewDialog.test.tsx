import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { DocumentMeta, ProjectMember, Review } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestReviewDialog } from '../index';

const PID = 'prj_1';
const AT = '2026-10-26T08:00:00.000Z';

const user = (id: string, name: string) => ({
  id,
  name,
  email: `${id}@x.org`,
  avatarColor: 1,
  avatarUrl: null,
});

const MEMBERS: ProjectMember[] = [
  { projectId: PID, user: user('usr_me', '我自己'), role: 'owner', joinedAt: AT },
  { projectId: PID, user: user('usr_li', '李四'), role: 'member', joinedAt: AT },
  { projectId: PID, user: user('usr_wang', '王老师'), role: 'advisor', joinedAt: AT },
  { projectId: PID, user: user('usr_guest', '访客小赵'), role: 'guest', joinedAt: AT },
] as ProjectMember[];

const DOCUMENT = {
  id: 'doc_1',
  projectId: PID,
  title: '基线复现',
} as DocumentMeta;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RequestReviewDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: unknown = null;

  beforeEach(() => {
    posted = null;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/auth/me')) return json({ user: user('usr_me', '我自己'), projects: [] });
      if (url.includes(`/projects/${PID}/members`)) return json(MEMBERS);
      if (url.includes(`/projects/${PID}/docs`)) return json([DOCUMENT]);
      if (url.includes(`/projects/${PID}/threads`)) return json({ items: [], nextCursor: null });
      if (url.includes(`/projects/${PID}/reviews`) && method === 'POST') {
        posted = JSON.parse(String(init?.body));
        return json({ id: 'rev_1', ...(posted as object) } as Review, 201);
      }
      return json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDialog(onOpenChange = vi.fn()) {
    const router = createMemoryRouter(
      [
        {
          path: '/p/:projectId/docs/:docId',
          element: (
            <RequestReviewDialog
              open
              onOpenChange={onOpenChange}
              defaultTarget={{ kind: 'document', id: 'doc_1', title: '基线复现' }}
            />
          ),
        },
      ],
      { initialEntries: [`/p/${PID}/docs/doc_1`] },
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return { onOpenChange };
  }

  it('预填目标与标题；审阅人排除访客和自己，导师带标记', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: '请求审阅' });

    expect(within(dialog).getByLabelText('目标类型')).toHaveValue('document');
    expect(within(dialog).getByLabelText('文档')).toHaveValue('doc_1');
    expect(within(dialog).getByLabelText('标题')).toHaveValue('请审阅：基线复现');

    const wang = await within(dialog).findByRole('checkbox', { name: /王老师/u });
    expect(wang).toHaveTextContent('导师');
    expect(within(dialog).getByRole('checkbox', { name: /李四/u })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /访客小赵/u })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /我自己/u })).not.toBeInTheDocument();
    // 导师排在最前
    expect(within(dialog).getAllByRole('checkbox')[0]).toBe(wang);
  });

  it('至少选一位审阅人，提交后 POST P/reviews 并关闭', async () => {
    const { onOpenChange } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: '请求审阅' });

    fireEvent.click(within(dialog).getByRole('button', { name: '发起审阅' }));
    expect(await within(dialog).findByText('至少选择一位审阅人')).toBeInTheDocument();
    expect(posted).toBeNull();

    const wang = await within(dialog).findByRole('checkbox', { name: /王老师/u });
    fireEvent.click(wang);
    expect(wang).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(within(dialog).getByLabelText('说明'), { target: { value: '重点看参数表' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '发起审阅' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posted).toEqual({
      targetKind: 'document',
      targetId: 'doc_1',
      title: '请审阅：基线复现',
      summary: '重点看参数表',
      reviewerIds: ['usr_wang'],
    });
  });

  it('计划 / 消息改为粘贴 id', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: '请求审阅' });
    fireEvent.change(within(dialog).getByLabelText('目标类型'), { target: { value: 'message' } });
    const input = within(dialog).getByLabelText('消息');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue('');
  });
});
