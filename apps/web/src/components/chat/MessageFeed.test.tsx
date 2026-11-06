import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Page } from '@srh/shared';
import { qk } from '@/lib/query-keys';
import { MessageFeed } from './MessageFeed';

const mocks = vi.hoisted(() => ({
  flash: vi.fn(),
  drafts: [] as Array<{ sessionId: string; text: string }>,
}));

vi.mock('@/lib/message-link', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flashElement: mocks.flash,
}));
vi.mock('@/lib/realtime-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDraftsFor: () => mocks.drafts,
}));
vi.mock('@/lib/project', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgents: () => ({ data: [] }),
}));
vi.mock('./MessageItem', () => ({
  MessageItem: ({ message, compact }: { message: Message; compact: boolean }) => (
    <article id={message.id} data-compact={String(Boolean(compact))}>
      {message.body}
    </article>
  ),
}));
vi.mock('./StreamingMessage', () => ({
  StreamingMessage: ({ text }: { text: string }) => <div data-testid="streaming">{text}</div>,
}));

const NOW = '2026-10-26T08:00:00.000Z';
function message(id: string, body: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    projectId: 'prj_feed',
    threadId: 'thr_feed',
    author: { kind: 'agent', id: 'agt_feed', name: '研究智能体' },
    kind: 'text',
    body,
    meta: {},
    agentVisible: true,
    reactions: [],
    outputs: [],
    rootOfThreadId: null,
    editedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

type Channel = 'all' | 'agent' | 'team';
type Pages = Partial<Record<Channel, Record<string, Page<Message>>>>;

function network(pages: Pages, lookup?: (id: string) => Promise<Message>) {
  const calls = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    let result: unknown;
    if (url.pathname.endsWith('/messages')) {
      const channel = (url.searchParams.get('channel') ?? 'all') as Channel;
      const cursor = url.searchParams.get('cursor') ?? '';
      result = pages[channel]?.[cursor] ?? { items: [], nextCursor: null };
    } else {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      result = lookup ? await lookup(id) : message(id, '定位消息');
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', calls);
  return calls;
}

function scroller(id?: string) {
  const el = document.createElement('div');
  if (id) el.id = id;
  const metrics = { height: 1000 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    el.scrollTop = options.top ?? 0;
    el.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(el, 'scrollTo', { configurable: true, value: scrollTo });
  document.body.appendChild(el);
  return { el, metrics, scrollTo, scrollRef: { current: el } };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="当前位置">{location.pathname + location.search + location.hash}</output>
  );
}

function DualChannel({
  pid,
  tid,
  scrollRef,
}: {
  pid: string;
  tid: string;
  scrollRef: { current: HTMLDivElement };
}) {
  const location = useLocation();
  const discussion = new URLSearchParams(location.search).has('discussion');
  return (
    <>
      <section aria-label="智能体对话">
        <MessageFeed
          projectId={pid}
          threadId={tid}
          me={null}
          channel="agent"
          scrollRef={scrollRef}
        />
      </section>
      {discussion && (
        <section aria-label="团队讨论">
          <MessageFeed
            projectId={pid}
            threadId={tid}
            me={null}
            channel="team"
            scrollRef={scrollRef}
          />
        </section>
      )}
      <LocationProbe />
    </>
  );
}

function feedTree(
  queryClient: QueryClient,
  pid: string,
  tid: string,
  channel: Channel,
  scrollRef: { current: HTMLDivElement } | undefined,
  path = '/p/prj_feed/threads/thr_feed',
) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <MessageFeed
          projectId={pid}
          threadId={tid}
          me={null}
          channel={channel}
          {...(scrollRef ? { scrollRef } : {})}
          empty={<p>没有消息</p>}
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.flash.mockReset();
  mocks.drafts = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('消息流滚动与定位', () => {
  it('读历史时新消息不抢滚动，可点击提示回到最新', async () => {
    const pid = 'prj_scroll';
    const tid = 'thr_scroll';
    const first = message('msg_first', '已有消息');
    network({ agent: { '': { items: [first], nextCursor: null } } });
    const queryClient = client();
    const host = scroller();
    render(feedTree(queryClient, pid, tid, 'agent', host.scrollRef), { container: host.el });
    await screen.findByText('已有消息');
    host.el.scrollTop = 250;
    fireEvent.scroll(host.el);
    const next = message('msg_next', '刚到的新消息');
    act(() => {
      queryClient.setQueryData<InfiniteData<Page<Message>, string | null>>(
        qk.threadMessages(pid, tid, 'agent'),
        (data) => ({
          ...data!,
          pages: [{ ...data!.pages[0]!, items: [next, first] }],
        }),
      );
    });
    const button = await screen.findByRole('button', { name: '1 条新消息' });
    expect(host.el.scrollTop).toBe(250);
    fireEvent.click(button);
    expect(host.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1000 }));
    expect(host.el.scrollTop).toBe(1000);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /条新消息/u })).not.toBeInTheDocument(),
    );
  });

  it('一次收到多条新消息时按实际条数提示', async () => {
    const pid = 'prj_batch';
    const tid = 'thr_batch';
    const first = message('msg_batch0', '已有记录');
    network({ agent: { '': { items: [first], nextCursor: null } } });
    const queryClient = client();
    const host = scroller();
    render(feedTree(queryClient, pid, tid, 'agent', host.scrollRef), { container: host.el });
    await screen.findByText('已有记录');
    host.el.scrollTop = 250;
    fireEvent.scroll(host.el);
    act(() => {
      queryClient.setQueryData<InfiniteData<Page<Message>, string | null>>(
        qk.threadMessages(pid, tid, 'agent'),
        (data) => ({
          ...data!,
          pages: [
            {
              ...data!.pages[0]!,
              items: [message('msg_batch2', '新消息二'), message('msg_batch1', '新消息一'), first],
            },
          ],
        }),
      );
    });
    expect(await screen.findByRole('button', { name: '2 条新消息' })).toBeInTheDocument();
    expect(host.el.scrollTop).toBe(250);
  });

  it('乐观消息替换为服务端消息时不会重复计数', async () => {
    const pid = 'prj_optimistic';
    const tid = 'thr_optimistic';
    const first = message('msg_before', '之前的消息');
    const author = { kind: 'user' as const, id: 'usr_sender', name: '研究员' };
    const temporary = message('tmp_1', '自己发出的消息', { author });
    const saved = message('msg_saved', '自己发出的消息', { author });
    network({ agent: { '': { items: [first], nextCursor: null } } });
    const queryClient = client();
    const host = scroller();
    render(feedTree(queryClient, pid, tid, 'agent', host.scrollRef), { container: host.el });
    await screen.findByText('之前的消息');
    host.el.scrollTop = 250;
    fireEvent.scroll(host.el);
    const replace = (item: Message) => {
      queryClient.setQueryData<InfiniteData<Page<Message>, string | null>>(
        qk.threadMessages(pid, tid, 'agent'),
        (data) => ({ ...data!, pages: [{ ...data!.pages[0]!, items: [item, first] }] }),
      );
    };
    act(() => replace(temporary));
    await screen.findByRole('button', { name: '1 条新消息' });
    await act(async () => {
      replace(saved);
      await Promise.resolve();
    });
    await waitFor(() => expect(document.getElementById('msg_saved')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '1 条新消息' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 条新消息' })).not.toBeInTheDocument();
  });

  it('删除最新消息不会误报新消息', async () => {
    const pid = 'prj_deleted';
    const tid = 'thr_deleted';
    const earlier = message('msg_before_delete', '更早消息');
    const latest = message('msg_to_delete', '将删除消息');
    network({ agent: { '': { items: [latest, earlier], nextCursor: null } } });
    const queryClient = client();
    const host = scroller();
    render(feedTree(queryClient, pid, tid, 'agent', host.scrollRef), { container: host.el });
    await screen.findByText('将删除消息');
    host.el.scrollTop = 250;
    fireEvent.scroll(host.el);
    await act(async () => {
      queryClient.setQueryData<InfiniteData<Page<Message>, string | null>>(
        qk.threadMessages(pid, tid, 'agent'),
        (data) => ({ ...data!, pages: [{ ...data!.pages[0]!, items: [earlier] }] }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText('将删除消息')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /条新消息/u })).not.toBeInTheDocument();
  });

  it('加载旧页保留阅读位置，不误报新消息', async () => {
    const first = message('msg_recent', '最近的消息');
    const old = message('msg_older', '更早的消息');
    const host = scroller();
    const calls = network({
      agent: {
        '': { items: [first], nextCursor: 'older' },
        older: { items: [old], nextCursor: null },
      },
    });
    const queryClient = client();
    render(feedTree(queryClient, 'prj_older', 'thr_older', 'agent', host.scrollRef), {
      container: host.el,
    });
    await screen.findByText('最近的消息');
    host.el.scrollTop = 500;
    fireEvent.scroll(host.el);
    fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
    host.metrics.height = 1300;
    await screen.findByText('更早的消息');
    await waitFor(() => expect(host.el.scrollTop).toBe(800));
    expect(screen.queryByRole('button', { name: /条新消息/u })).not.toBeInTheDocument();
    expect(
      calls.mock.calls.some(
        ([url]) => new URL(String(url), 'http://localhost').searchParams.get('cursor') === 'older',
      ),
    ).toBe(true);
  });

  it('团队频道不展示智能体流式草稿，智能体频道仍展示', async () => {
    mocks.drafts = [{ sessionId: 'agt_feed', text: '智能体正在生成的内容' }];
    network({});
    const queryClient = client();
    const host = scroller();
    const view = render(feedTree(queryClient, 'prj_drafts', 'thr_drafts', 'team', host.scrollRef), {
      container: host.el,
    });
    await screen.findByText('没有消息');
    expect(screen.queryByTestId('streaming')).not.toBeInTheDocument();
    view.rerender(feedTree(queryClient, 'prj_drafts', 'thr_drafts', 'agent', host.scrollRef));
    expect(await screen.findByTestId('streaming')).toHaveTextContent('智能体正在生成的内容');
  });

  it('目标只在自己的消息流中查找，外部同 id 不阻止翻页', async () => {
    const outside = document.createElement('article');
    outside.id = 'msg_target';
    document.body.appendChild(outside);
    const target = message('msg_target', '目标消息');
    const calls = network(
      {
        agent: {
          '': { items: [message('msg_latest', '近期消息')], nextCursor: 'older' },
          older: { items: [target], nextCursor: null },
        },
      },
      async () => target,
    );
    const queryClient = client();
    const host = scroller();
    render(
      feedTree(
        queryClient,
        'prj_target',
        'thr_target',
        'agent',
        host.scrollRef,
        '/p/prj_target/threads/thr_target#msg_target',
      ),
      { container: host.el },
    );
    const found = await within(host.el).findByText('目标消息');
    await waitFor(() => expect(mocks.flash).toHaveBeenCalled());
    expect(mocks.flash.mock.calls[0]?.[0]).toBe(found);
    expect(mocks.flash.mock.calls[0]?.[0]).not.toBe(outside);
    expect(
      calls.mock.calls.some(
        ([url]) => new URL(String(url), 'http://localhost').searchParams.get('cursor') === 'older',
      ),
    ).toBe(true);
  });

  it('个人会话 all 频道能定位旧旁聊，不切到团队讨论', async () => {
    const target = message('msg_private', '个人历史旁聊', { agentVisible: false });
    const calls = network(
      { all: { '': { items: [target], nextCursor: null } } },
      async () => target,
    );
    const queryClient = client();
    const host = scroller();
    render(
      feedTree(
        queryClient,
        'prj_private',
        'thr_private',
        'all',
        host.scrollRef,
        '/p/prj_private/workspace/thr_private#msg_private',
      ),
      { container: host.el },
    );
    const found = await screen.findByText('个人历史旁聊');
    await waitFor(() => expect(mocks.flash).toHaveBeenCalled());
    expect(mocks.flash.mock.calls[0]?.[0]).toBe(found);
    expect(screen.getByLabelText('当前位置')).toHaveTextContent(
      '/p/prj_private/workspace/thr_private#msg_private',
    );
    expect(
      calls.mock.calls.some(([url]) =>
        new URL(String(url), 'http://localhost').pathname.endsWith('/messages/msg_private'),
      ),
    ).toBe(false);
  });

  it('旧旁聊链接先判定频道，再让团队消息流定位，智能体流不翻历史', async () => {
    const pid = 'prj_redirect';
    const tid = 'thr_redirect';
    const target = message('msg_teamold', '团队历史消息', {
      projectId: pid,
      threadId: tid,
      agentVisible: false,
    });
    let resolveLookup!: (value: Message) => void;
    const pendingLookup = new Promise<Message>((resolve) => {
      resolveLookup = resolve;
    });
    const calls = network(
      {
        agent: { '': { items: [message('msg_agent', '智能体最近消息')], nextCursor: 'agent-old' } },
        team: { '': { items: [target], nextCursor: null } },
      },
      async () => pendingLookup,
    );
    const historyLocations: string[] = [];
    const fetchPage = calls.getMockImplementation()!;
    calls.mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('cursor') === 'agent-old') {
        historyLocations.push(screen.getByLabelText('当前位置').textContent ?? '');
      }
      return fetchPage(input);
    });
    const queryClient = client();
    const host = scroller();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/prj_redirect/threads/thr_redirect#msg_teamold']}>
          <DualChannel pid={pid} tid={tid} scrollRef={host.scrollRef} />
        </MemoryRouter>
      </QueryClientProvider>,
      { container: host.el },
    );
    await screen.findByText('智能体最近消息');
    await waitFor(() =>
      expect(calls.mock.calls.some(([url]) => String(url).includes('/messages/msg_teamold'))).toBe(
        true,
      ),
    );
    expect(historyLocations).toEqual([]);
    await act(async () => resolveLookup(target));
    const team = await screen.findByRole('region', { name: '团队讨论' });
    const located = await within(team).findByText('团队历史消息');
    await waitFor(() => expect(mocks.flash).toHaveBeenCalled());
    expect(mocks.flash.mock.calls[0]?.[0]).toBe(located);
    expect(screen.getByLabelText('当前位置')).toHaveTextContent(
      '?discussion=thr_redirect#msg_teamold',
    );
    expect(historyLocations).toEqual([]);
  });

  it('同一天的连续文字才合并，跨日或决策卡之后重新显示作者', async () => {
    const created = (day: number, hour: number, minute: number) =>
      new Date(2026, 9, day, hour, minute).toISOString();
    const one = message('msg_group1', '前一天', { createdAt: created(26, 23, 59) });
    const two = message('msg_group2', '隔日', { createdAt: created(27, 0, 1) });
    const decision = message('msg_group3', '决策', {
      kind: 'decision',
      createdAt: created(27, 0, 2),
    });
    const four = message('msg_group4', '决策之后', { createdAt: created(27, 0, 3) });
    const five = message('msg_group5', '连续文字', { createdAt: created(27, 0, 4) });
    network({ agent: { '': { items: [five, four, decision, two, one], nextCursor: null } } });
    const host = scroller();
    render(feedTree(client(), 'prj_grouping', 'thr_grouping', 'agent', host.scrollRef), {
      container: host.el,
    });
    for (const body of ['前一天', '隔日', '决策', '决策之后']) {
      expect(await screen.findByText(body)).toHaveAttribute('data-compact', 'false');
    }
    expect(await screen.findByText('连续文字')).toHaveAttribute('data-compact', 'true');
  });

  it('完整页和面板分别恢复自己的滚动位置', async () => {
    const item = message('msg_shared', '共享线程消息');
    network({ agent: { '': { items: [item], nextCursor: null } } });
    const pid = 'prj_scroll_scope';
    const tid = 'thr_scroll_scope';
    const panelClient = client();
    const panel = scroller();
    const first = render(feedTree(panelClient, pid, tid, 'agent', panel.scrollRef), {
      container: panel.el,
    });
    await screen.findByText('共享线程消息');
    panel.el.scrollTop = 240;
    fireEvent.scroll(panel.el);
    first.unmount();
    panel.el.remove();

    const pageClient = client();
    const page = scroller('app-scroll');
    const second = render(feedTree(pageClient, pid, tid, 'agent', undefined), {
      container: page.el,
    });
    await screen.findByText('共享线程消息');
    await waitFor(() => expect(page.el.scrollTop).toBe(1000));
    page.el.scrollTop = 480;
    fireEvent.scroll(page.el);
    second.unmount();
    page.el.remove();

    const reopened = scroller();
    render(feedTree(client(), pid, tid, 'agent', reopened.scrollRef), { container: reopened.el });
    await screen.findByText('共享线程消息');
    await waitFor(() => expect(reopened.el.scrollTop).toBe(240));
  });

  it('停在底部时，消息里的图片晚到加载完也重新贴住底部', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    network({ agent: { '': { items: [message('msg_img', '带图消息')], nextCursor: null } } });
    const host = scroller();
    render(feedTree(client(), 'prj_img', 'thr_img', 'agent', host.scrollRef), {
      container: host.el,
    });
    const article = await screen.findByText('带图消息');
    await waitFor(() => expect(host.el.scrollTop).toBe(1000));
    const img = document.createElement('img');
    article.appendChild(img);
    host.metrics.height = 1180;
    img.dispatchEvent(new Event('load'));
    expect(host.el.scrollTop).toBe(1180);
    // 人往上翻了就不再拽回底部
    host.el.scrollTop = 300;
    fireEvent.scroll(host.el);
    host.metrics.height = 1300;
    img.dispatchEvent(new Event('error'));
    expect(host.el.scrollTop).toBe(300);
  });
});
