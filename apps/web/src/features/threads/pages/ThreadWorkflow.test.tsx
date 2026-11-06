import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSession,
  AgentStep,
  Decision,
  Message,
  Page,
  ProjectRole,
  Thread,
} from '@srh/shared';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';
import { useLayoutStore } from '@/components/layout/layout-store';

const PID = 'prj_workflow';
const NOW = '2026-10-26T08:00:00.000Z';
const USER = {
  id: 'usr_workflow',
  email: 'workflow@lab.edu.cn',
  name: '研究员',
  avatarColor: 0,
  avatarUrl: null,
  createdAt: NOW,
};
const PROJECT = {
  id: PID,
  name: '工作流测试',
  description: '',
  icon: '🧬',
  color: 0,
  instructions: '',
  visibility: 'team',
  createdBy: USER.id,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};
const THREAD: Thread = {
  id: 'thr_workflow',
  projectId: PID,
  kind: 'project',
  rootMessageId: 'msg_workflow',
  title: '扩散模型消融实验',
  label: '实验',
  ownerUserId: USER.id,
  statusBucket: 'idle',
  statusText: '完成消融实验\n○ 核对数据',
  resolved: false,
  replyCount: 0,
  forwardedAt: null,
  agentSessionId: null,
  lastActivityAt: NOW,
  createdAt: NOW,
};
const THREADS = [
  THREAD,
  { ...THREAD, id: 'thr_other', title: '整理相关文献', label: '文献' },
  { ...THREAD, id: 'thr_done', title: '扩散模型已完成实验', resolved: true },
];
const DECISION: Decision = {
  id: 'dec_workflow',
  messageId: 'msg_decision',
  threadId: THREAD.id,
  question: '选哪个基线？',
  context: null,
  options: [
    { label: '基线 A', consequence: '更快' },
    { label: '基线 B', consequence: '更完整' },
  ],
  recommended: 0,
  reason: null,
  state: 'open',
  chosen: null,
  chosenBy: null,
  answeredAt: null,
  createdAt: NOW,
};
const message = (id: string, body: string): Message => ({
  id,
  projectId: PID,
  threadId: THREAD.id,
  author: { kind: 'agent', id: 'agt_workflow', name: '研究智能体' },
  kind: 'text',
  body,
  meta: {},
  agentVisible: true,
  reactions: [],
  outputs: [],
  rootOfThreadId: null,
  editedAt: null,
  createdAt: NOW,
});
const DECISION_MESSAGE: Message = {
  ...message(DECISION.messageId, ''),
  kind: 'decision',
  meta: { decisionId: DECISION.id, decision: DECISION },
};
const OUTPUT_MESSAGE: Message = {
  ...message('msg_output', '产出已经准备好'),
  outputs: [{ id: 'out_workflow', kind: 'document', ref: 'doc_result', title: '实验成果' }],
};
const CHANGE: AgentStep = {
  id: 'stp_workflow',
  sessionId: 'agt_workflow',
  turnId: 'turn_workflow',
  index: 0,
  kind: 'tool_call',
  name: 'write_file',
  content: '{"path":"notes.md"}',
  data: { args: { path: 'notes.md' } },
  createdAt: NOW,
};
function setup(
  role: ProjectRole = 'owner',
  path = `/p/${PID}/threads`,
  agentStatus?: AgentSession['status'],
  fixtures: { pages?: Page<Message>[]; steps?: AgentStep[] } = {},
) {
  const agent: AgentSession = {
    id: 'agt_workflow',
    projectId: PID,
    threadId: THREAD.id,
    role: 'thread',
    status: agentStatus ?? 'idle',
    model: 'test/model',
    effort: null,
    profile: null,
    goal: null,
    activity: null,
    workingForUserId: USER.id,
    tokenUsage: { input: 0, output: 0, cached: 0 },
    lastActivityAt: NOW,
    createdAt: NOW,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (path === '/api/health')
      return json({
        status: 'ok',
        version: '0.1.0',
        uptimeSec: 1,
        time: NOW,
        db: { ok: true, driver: 'pglite', latencyMs: 1 },
        llm: { configured: false, model: '' },
      });
    if (path === '/api/v1/auth/me') return json({ user: USER, projects: [{ ...PROJECT, role }] });
    if (path === `/api/v1/projects/${PID}`) return json(PROJECT);
    if (path.endsWith('/members'))
      return json([{ projectId: PID, user: USER, role, joinedAt: NOW }]);
    if (path.endsWith('/agents')) return json(agentStatus ? [agent] : []);
    if (path.endsWith('/threads')) return json({ items: THREADS, nextCursor: null });
    if (path.endsWith(`/threads/${THREAD.id}`)) return json(THREAD);
    if (path.endsWith(`/threads/${THREAD.id}/messages`)) {
      const pages = fixtures.pages ?? [{ items: [], nextCursor: null }];
      const cursor = url.searchParams.get('cursor');
      return json(
        cursor ? (pages.find((_, i) => pages[i - 1]?.nextCursor === cursor) ?? pages[0]) : pages[0],
      );
    }
    if (path.endsWith('/agents/agt_workflow/steps'))
      return json({ items: fixtures.steps ?? [], nextCursor: null });
    if (path === `/api/v1/projects/${PID}/messages/msg_old`) {
      const found = fixtures.pages?.flatMap((page) => page.items).find((m) => m.id === 'msg_old');
      return json(found);
    }
    if (path.endsWith(`/decisions/${DECISION.id}/answer`) && init?.method === 'POST')
      return json({
        ...DECISION,
        state: 'answered',
        chosen: 0,
        chosenBy: { kind: 'user', id: USER.id, name: USER.name },
        answeredAt: NOW,
      });
    if (
      path.endsWith('/agents') ||
      path.endsWith('/claims') ||
      path.endsWith('/reviews') ||
      path.endsWith('/docs') ||
      path === '/api/v1/inbox'
    )
      return json([]);
    return json({ items: [], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    },
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Providers queryClient={qc}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, fetcher, qc };
}
beforeEach(() => useLayoutStore.setState({ rightPanelOpen: false, panelTab: 'threads' }));
afterEach(() => vi.unstubAllGlobals());

describe('线程工作流', () => {
  it.each(['完整页', '辅助面板'] as const)(
    '%s 先显示成果和改动，待决定可单独展开并回答，讨论仍保留决策卡',
    async (surface) => {
      const path =
        surface === '完整页'
          ? `/p/${PID}/threads/${THREAD.id}`
          : `/p/${PID}/threads?thread=${THREAD.id}`;
      const { fetcher } = setup('owner', path, 'idle', {
        pages: [{ items: [OUTPUT_MESSAGE, DECISION_MESSAGE], nextCursor: null }],
        steps: [CHANGE],
      });
      const scope =
        surface === '辅助面板'
          ? within(await screen.findByRole('dialog', { name: '辅助面板' }))
          : screen;
      expect(await scope.findByRole('heading', { name: DECISION.question })).toBeInTheDocument();
      fireEvent.click(scope.getByRole('tab', { name: /^产出/u }));
      const results = await scope.findByRole('region', { name: '成果' });
      const changes = await scope.findByRole('region', { name: '改动' });
      const decisions = await scope.findByRole('region', { name: '待决定' });
      expect(
        results.compareDocumentPosition(changes) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        changes.compareDocumentPosition(decisions) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(within(results).getByText('实验成果')).toBeInTheDocument();
      const summary = within(decisions).getByText('待决定 · 1').closest('summary')!;
      const details = summary.closest('details')!;
      expect(details).not.toHaveAttribute('open');
      fireEvent.click(summary);
      expect(details).toHaveAttribute('open');
      const option = within(decisions).getByRole('radio', { name: /基线 A/u });
      expect(option).toBeEnabled();
      fireEvent.click(option);
      await waitFor(() =>
        expect(scope.queryByRole('region', { name: '待决定' })).not.toBeInTheDocument(),
      );
      expect(
        fetcher.mock.calls.some(([url]) =>
          String(url).endsWith(`/decisions/${DECISION.id}/answer`),
        ),
      ).toBe(true);
      fireEvent.click(scope.getByRole('tab', { name: '讨论' }));
      expect(await scope.findByText('已选：', { exact: false })).toHaveTextContent('基线 A');
    },
  );

  it.each(['完整页', '辅助面板'] as const)('%s 中访客展开待决定后仍不可回答', async (surface) => {
    const path =
      surface === '完整页'
        ? `/p/${PID}/threads/${THREAD.id}`
        : `/p/${PID}/threads?thread=${THREAD.id}`;
    setup('guest', path, 'idle', {
      pages: [{ items: [DECISION_MESSAGE], nextCursor: null }],
    });
    const scope =
      surface === '辅助面板'
        ? within(await screen.findByRole('dialog', { name: '辅助面板' }))
        : screen;
    expect(await scope.findByRole('heading', { name: DECISION.question })).toBeInTheDocument();
    fireEvent.click(scope.getByRole('tab', { name: /^产出/u }));
    const decisions = await scope.findByRole('region', { name: '待决定' });
    fireEvent.click(within(decisions).getByText('待决定 · 1'));
    expect(within(decisions).getByRole('radio', { name: /基线 A/u })).toBeDisabled();
  });

  it('辅助面板用自己的消息滚动容器定位较早的深链接', async () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      const { fetcher } = setup('owner', `/p/${PID}/threads?thread=${THREAD.id}#msg_old`, 'idle', {
        pages: [
          { items: [message('msg_recent', '最近消息')], nextCursor: 'cursor_old' },
          { items: [message('msg_old', '较早的引用消息')], nextCursor: null },
        ],
      });
      const panel = await screen.findByRole('dialog', { name: '辅助面板' });
      const old = await within(panel).findByText('较早的引用消息');
      const article = old.closest('article')!;
      await waitFor(() => expect(article).toHaveAttribute('data-flash'));
      expect(scrollIntoView).toHaveBeenCalled();
      expect(article.closest('.overflow-y-auto')).not.toBe(document.getElementById('app-scroll'));
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            new URL(String(url), 'http://localhost').searchParams.get('cursor') === 'cursor_old',
        ),
      ).toBe(true);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('搜索与已解决筛选保留在URL，开合详情不改变列表筛选和滚动', async () => {
    const { router } = setup();
    const search = await screen.findByRole('searchbox', { name: '搜索线程' });
    fireEvent.change(search, { target: { value: '扩散' } });
    await waitFor(() => expect(router.state.location.search).toContain('q='));
    fireEvent.click(screen.getByRole('switch', { name: '显示已解决' }));
    await screen.findByRole('link', { name: '扩散模型已完成实验' });
    expect(router.state.location.search).toContain('resolved=1');
    expect(screen.queryByRole('link', { name: '整理相关文献' })).not.toBeInTheDocument();
    const scroller = document.getElementById('app-scroll')!;
    scroller.scrollTop = 320;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole('link', { name: THREAD.title }));
    const panel = await screen.findByRole('dialog', { name: '辅助面板' });
    expect(router.state.location.search).toContain(`thread=${THREAD.id}`);
    const reply = await within(panel).findByRole('combobox', { name: '回复线程' });
    fireEvent.change(reply, { target: { value: '未发送的研究思路' } });
    fireEvent.click(within(panel).getByRole('tab', { name: '产出' }));
    fireEvent.click(within(panel).getByRole('tab', { name: '讨论' }));
    expect(within(panel).getByRole('combobox', { name: '回复线程' })).toHaveValue(
      '未发送的研究思路',
    );

    expect(scroller.scrollTop).toBe(320);
    expect(screen.getByRole('searchbox', { name: '搜索线程' })).toHaveValue('扩散');
    fireEvent.click(within(panel).getByRole('button', { name: '关闭辅助面板' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('thread='));
    expect(router.state.location.search).toContain('resolved=1');
    expect(scroller.scrollTop).toBe(320);
    expect(screen.getByRole('searchbox', { name: '搜索线程' })).toHaveValue('扩散');
  });

  it('完整页返回恢复筛选和滚动，讨论/产出/执行记录支持快速切换和浏览器前后退', async () => {
    const { router } = setup('owner', `/p/${PID}/threads?q=扩散`);
    await screen.findByRole('link', { name: THREAD.title });
    const scroller = document.getElementById('app-scroll')!;
    scroller.scrollTop = 280;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByRole('link', { name: `在完整页面打开：${THREAD.title}` }));
    await screen.findByRole('tab', { name: '执行记录' });
    fireEvent.click(screen.getByRole('tab', { name: '执行记录' }));
    expect(await screen.findByText('当前 agent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '产出' }));
    expect(await screen.findByText('审阅', { selector: 'h2' })).toBeInTheDocument();
    await act(() => router.navigate(-1));
    expect(screen.getByRole('tab', { name: '执行记录' })).toHaveAttribute('aria-selected', 'true');
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '讨论' }));
      fireEvent.click(screen.getByRole('tab', { name: '产出' }));
    });
    expect(screen.getByRole('tab', { name: '产出' })).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('审阅', { selector: 'h2' });
    fireEvent.click(screen.getByRole('link', { name: '全部线程' }));
    expect(await screen.findByRole('searchbox', { name: '搜索线程' })).toHaveValue('扩散');
    expect(scroller.scrollTop).toBe(280);
  });

  it('辅助线程列表在详情返回后保留标签筛选与内部滚动', async () => {
    setup();
    await screen.findByRole('searchbox', { name: '搜索线程' });
    act(() => useLayoutStore.getState().setRightPanelOpen(true));
    const panel = await screen.findByRole('dialog', { name: '辅助面板' });
    // 面板框架先打开，等待按需加载的线程内容和数据就绪。
    const labels = await within(panel).findByRole('group', { name: '按标签筛选' });
    const filter = within(labels).getByRole('button', { name: /^实验/u });
    fireEvent.click(filter);
    const row = within(panel).getByRole('link', { name: new RegExp(`^${THREAD.title}，`) });
    const scroller = row.closest('.overflow-y-auto') as HTMLElement;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    fireEvent.click(row);
    fireEvent.click(await within(panel).findByRole('button', { name: '返回线程列表' }));
    expect(within(panel).getByRole('group', { name: '按标签筛选' })).toContainElement(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(scroller.scrollTop).toBe(120);
    expect(within(panel).queryByRole('link', { name: /^整理相关文献，/u })).not.toBeInTheDocument();
  });

  it.each([
    ['完整页', 'failed', 'agent 停下了，这件事还没做完'],
    ['完整页', 'stopped', 'agent 已被停止'],
    ['辅助面板', 'failed', 'agent 停下了，这件事还没做完'],
    ['辅助面板', 'stopped', 'agent 已被停止'],
  ] as const)('%s 的 %s 状态直接出现在讨论中，保留继续操作', async (surface, status, title) => {
    const path =
      surface === '完整页'
        ? `/p/${PID}/threads/${THREAD.id}`
        : `/p/${PID}/threads?thread=${THREAD.id}`;
    setup('owner', path, status);
    const scope =
      surface === '辅助面板'
        ? within(await screen.findByRole('dialog', { name: '辅助面板' }))
        : screen;
    expect(await scope.findByText(title)).toBeInTheDocument();
    expect(scope.getByRole('tab', { name: '讨论' })).toHaveAttribute('aria-selected', 'true');
    expect(scope.getByRole('button', { name: '继续' })).toBeEnabled();
    expect(scope.getByRole('combobox', { name: '回复线程' })).toHaveAttribute(
      'placeholder',
      '回复线程…',
    );
    expect(scope.queryByText('回复这个线程，agent 会接着做。')).not.toBeInTheDocument();
  });

  it('访客深链接详情保持只读，三个详情标签功能仍可浏览', async () => {
    const { router, fetcher } = setup('guest', `/p/${PID}/threads?thread=${THREAD.id}`);
    const panel = await screen.findByRole('dialog', { name: '辅助面板' });
    const reply = await within(panel).findByRole('combobox', { name: '回复线程' });
    expect(reply).toBeDisabled();
    expect(reply).toHaveAttribute('placeholder', '访客只能查看，不能发言');
    expect(within(panel).queryByRole('button', { name: '发送' })).toBeDisabled();
    expect(within(panel).queryByRole('button', { name: '停止 agent' })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: '产出' }));
    await within(panel).findByText('审阅', { selector: 'h2' });
    expect(within(panel).queryByRole('button', { name: '请导师审阅' })).not.toBeInTheDocument();
    expect(router.state.location.search).toContain('threadTab=outputs');
    await act(() => router.navigate(-1));
    expect(within(panel).getByRole('tab', { name: '讨论' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(fetcher.mock.calls.every((call) => !String(call[0]).endsWith('/stop'))).toBe(true);
  });
});
