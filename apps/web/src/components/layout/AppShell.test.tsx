import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { HealthResponse } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';
import { useLayoutStore } from './layout-store';

const PID = 'prj_01JBTEST000000000000000000';
const NOW = '2026-10-26T08:00:00.000Z';

const HEALTH: HealthResponse = {
  status: 'ok',
  version: '0.1.0',
  uptimeSec: 12,
  time: NOW,
  db: { ok: true, driver: 'pglite', latencyMs: 1 },
  llm: { configured: false, model: '' },
};

const USER = {
  id: 'usr_01JBTEST000000000000000001',
  email: 'kk@lab.edu.cn',
  name: 'kk',
  avatarColor: 0,
  avatarUrl: null,
  createdAt: NOW,
};

const PROJECT = {
  id: PID,
  name: '扩散模型医学分割',
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

const THREAD = {
  id: 'thr_01JBTEST000000000000000001',
  projectId: PID,
  kind: 'project',
  rootMessageId: 'msg_01JBTEST000000000000000001',
  title: '调研：扩散模型用于医学图像分割',
  label: '文献调研',
  ownerUserId: USER.id,
  statusBucket: 'working',
  statusText: '调研\n\n✓ 检索论文\n✱ 正在阅读 MedSegDiff-V2 的实验部分\n○ 整理对比表',
  resolved: false,
  replyCount: 3,
  forwardedAt: null,
  agentSessionId: null,
  lastActivityAt: NOW,
  createdAt: NOW,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('AppShell', () => {
  let loggedIn = true;
  let healthUnavailable = false;

  beforeEach(() => {
    loggedIn = true;
    healthUnavailable = false;
    useLayoutStore.setState({ paletteOpen: false, rightPanelOpen: false });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const p = url.pathname;
      if (p === '/api/health')
        return json(
          healthUnavailable
            ? { ...HEALTH, status: 'degraded', db: { ...HEALTH.db, ok: false } }
            : HEALTH,
          healthUnavailable ? 503 : 200,
        );
      if (p === '/api/v1/auth/me') {
        return loggedIn
          ? json({ user: USER, projects: [{ ...PROJECT, role: 'owner' }] })
          : json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
      }
      if (p === `/api/v1/projects/${PID}`) return json(PROJECT);
      if (p.endsWith('/notebooks/nb_a'))
        return json({
          id: 'nb_a',
          projectId: PID,
          title: '研究 Notebook',
          language: 'python',
          cellCount: 1,
          createdBy: { kind: 'user', id: USER.id, name: USER.name },
          updatedBy: null,
          createdAt: NOW,
          updatedAt: NOW,
          experimentId: null,
          kernel: { status: 'unavailable' },
        });
      if (p.endsWith('/members'))
        return json([{ projectId: PID, user: USER, role: 'owner', joinedAt: NOW }]);
      if (p === `/api/v1/projects/${PID}/threads/${THREAD.id}`) return json(THREAD);
      if (p.endsWith('/threads')) return json({ items: [THREAD], nextCursor: null });
      if (p.endsWith('/docs')) return json([]);
      if (p.endsWith('/agents') || p.endsWith('/claims') || p === '/api/v1/inbox') return json([]);
      return json({ items: [], nextCursor: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    // jsdom 里没有服务端：给一个永远连不上的 WebSocket
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('侧栏按顺序渲染中文主导航', async () => {
    renderAt(`/p/${PID}`);

    const nav = await screen.findByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('button', { name: '资料' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).getByRole('button', { name: '推进' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    fireEvent.click(within(nav).getByRole('button', { name: '资料' }));
    fireEvent.click(within(nav).getByRole('button', { name: '推进' }));
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent?.replace(/\d+$/u, '').trim())).toEqual([
      '协作台',
      '我的工作区',
      '个人文献库',
      '待我处理',
      '线程',
      '方案与依据',
      '文档',
      '项目文献库',
      '任务',
      '研究空间',
      '审阅',
      '组会汇报',
    ]);
    expect(within(nav).getByRole('link', { name: '个人文献库' })).toHaveAttribute(
      'href',
      '/library',
    );
    expect(within(nav).getByRole('link', { name: '个人文献库' }).closest('ul')).toHaveAttribute(
      'aria-label',
      '我的工作区资料',
    );
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['资源']);
    expect(within(nav).getByRole('link', { name: '协作台' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /^线程/u })).toHaveAttribute(
      'href',
      `/p/${PID}/threads`,
    );
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute(
      'href',
      `/p/${PID}/settings`,
    );
  });

  it('当前资料路由自动展开资料组，推进保持折叠', async () => {
    renderAt(`/p/${PID}/docs`);
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('button', { name: '资料' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(nav).getByRole('button', { name: '推进' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).getByRole('link', { name: '文档' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: '看板' })).toBeNull();
    fireEvent.click(within(nav).getByRole('button', { name: '资料' }));
    expect(within(nav).getByRole('button', { name: '资料' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(nav).queryByRole('link', { name: '文档' })).toBeNull();
  });

  it('设置使用专用目录，并保留返回课题入口', async () => {
    renderAt(`/p/${PID}/settings?tab=profile`);
    const nav = await screen.findByRole('navigation', { name: '设置分区' });
    expect(within(nav).getAllByRole('link')).toHaveLength(15);
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
    expect(screen.getByRole('link', { name: '返回课题' })).toHaveAttribute('href', `/p/${PID}`);
    expect(screen.getByRole('heading', { level: 1, name: '个人与外观' })).toBeInTheDocument();
  });

  it('协作台页面与服务状态', async () => {
    renderAt(`/p/${PID}`);

    expect(await screen.findByRole('heading', { level: 1, name: '协作台' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(
      await screen.findByRole('heading', { level: 2, name: '开始一项研究工作' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '拆解研究任务' }));
    expect(screen.getByPlaceholderText('向协调者描述需求…')).toHaveValue(
      '帮我拆解：下周组会前完成消融实验',
    );
    expect(screen.queryByText(/服务正常/u)).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '帮助' }));
    expect(await screen.findByRole('heading', { level: 1, name: '帮助中心' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('服务状态'));
    expect(await screen.findByText('服务正常')).toBeInTheDocument();
    expect(screen.getByText('版本 0.1.0 · 数据库 PGlite · 数据库延迟 1ms')).toBeInTheDocument();
  });

  it('服务异常时提供通向诊断的提示', async () => {
    healthUnavailable = true;
    renderAt(`/p/${PID}`);
    const link = await screen.findByRole('link', { name: '服务异常，查看状态' });
    expect(link).toHaveAttribute('href', `/p/${PID}/help#service-status`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: '帮助中心' })).toBeInTheDocument();
    expect(await screen.findByText(/数据库（PGlite）暂时不可用/u)).toBeInTheDocument();
  });

  it('讨论深链接取代其他辅助面板并保留草稿', async () => {
    renderAt(`/p/${PID}?discussion=project&thread=${THREAD.id}&preview=doc:doc_test`);
    const input = await screen.findByRole('textbox', { name: '发送到团队讨论' });
    fireEvent.change(screen.getByPlaceholderText('向协调者描述需求…'), {
      target: { value: '智能体中的独立草稿' },
    });
    expect(screen.queryByRole('heading', { name: '文档预览' })).toBeNull();
    fireEvent.change(input, { target: { value: '讨论中的独立草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭辅助面板' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '发送到团队讨论' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: '团队讨论' }));
    expect(await screen.findByRole('textbox', { name: '发送到团队讨论' })).toHaveValue(
      '讨论中的独立草稿',
    );
    expect(screen.getByPlaceholderText('向协调者描述需求…')).toHaveValue('智能体中的独立草稿');
  });

  it('根路径跳到我的第一个课题', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: '协作台' })).toBeInTheDocument();
  });

  it('未登录时跳到登录页', async () => {
    loggedIn = false;
    renderAt(`/p/${PID}/threads`);
    expect(await screen.findByRole('heading', { name: '登录研协' })).toBeInTheDocument();
  });

  it('线程页展示接口返回的线程', async () => {
    renderAt(`/p/${PID}/threads`);
    expect(await screen.findByRole('heading', { level: 1, name: '线程' })).toBeInTheDocument();
    expect((await screen.findAllByText(THREAD.title)).length).toBeGreaterThan(0);
  });

  it('命令面板按需打开，关闭后恢复搜索触发器焦点', async () => {
    renderAt(`/p/${PID}`);
    const trigger = await screen.findByRole('button', { name: '搜索与命令' });
    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('combobox', { name: '搜索命令' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox', { name: '搜索命令' }), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    expect(await screen.findByRole('combobox', { name: '搜索命令' })).toBeInTheDocument();
  });

  it('专业工作区不渲染背景水印，列表保留水印', async () => {
    const list = renderAt(`/p/${PID}/docs`);
    await screen.findByRole('navigation', { name: '主导航' });
    expect(document.querySelector('.workspace-watermark')).toBeInTheDocument();
    list.unmount();
    renderAt(`/p/${PID}/notebooks/nb_a`);
    await screen.findByRole('navigation', { name: '主导航' });
    expect(document.querySelector('.workspace-watermark')).not.toBeInTheDocument();
  });

  it('未知页面显示 404', async () => {
    renderAt(`/p/${PID}/nope`);
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument();
  });
});
