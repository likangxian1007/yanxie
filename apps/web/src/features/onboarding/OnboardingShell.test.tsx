import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ProjectRole } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';
import { configureOnboarding, readIntroRecord, readTourRecord, writeIntroRecord } from './storage';
import { useTourStore } from './tour-store';

const PID = 'prj_01JBTEST000000000000000000';
const NOW = '2026-10-26T08:00:00.000Z';
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installBackend(role: ProjectRole) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const p = new URL(String(input), 'http://localhost').pathname;
      if (p === '/api/health')
        return json({
          status: 'ok',
          version: '0.1.0',
          uptimeSec: 1,
          time: NOW,
          db: { ok: true, driver: 'pglite', latencyMs: 1 },
          llm: { configured: false, model: '' },
        });
      if (p === '/api/v1/auth/me') return json({ user: USER, projects: [{ ...PROJECT, role }] });
      if (p === `/api/v1/projects/${PID}`) return json(PROJECT);
      if (p.endsWith('/members'))
        return json([{ projectId: PID, user: USER, role, joinedAt: NOW }]);
      if (
        p.endsWith('/agents') ||
        p.endsWith('/claims') ||
        p.endsWith('/reviews') ||
        p.endsWith('/docs') ||
        p === '/api/v1/inbox'
      )
        return json([]);
      return json({ items: [], nextCursor: null });
    }),
  );
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
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

beforeEach(() => {
  useTourStore.setState({ active: null, welcomeOpen: false, request: null });
});

afterEach(() => {
  configureOnboarding(null);
  vi.unstubAllGlobals();
});

describe('首次进入课题的引导', () => {
  it('默认（测试环境）不会自动弹出', async () => {
    installBackend('owner');
    renderAt(`/p/${PID}`);
    expect(await screen.findByRole('heading', { level: 1, name: '协作台' })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('成员主动打开后，键盘切换步骤，目标找不到时说明位置，Esc 跳过并记住', async () => {
    configureOnboarding({ autoStart: true });
    installBackend('member');
    renderAt(`/p/${PID}`);

    await screen.findByRole('heading', { level: 1, name: '协作台' });
    act(() => useTourStore.getState().requestTour());
    const card = await screen.findByRole('dialog', { name: '协作台：从一个需求开始' });
    expect(within(card).getByText('1 / 8')).toBeInTheDocument();
    // jsdom 没有布局：所有目标都“看不见”，退回居中卡片 + 位置说明
    expect(await within(card).findByText(/在底部标签栏里点「协作台」/u)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /上一步/u })).toBeNull();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(
      await screen.findByRole('dialog', { name: '线程：每件事的进度和产出' }),
    ).toBeInTheDocument();
    // 读屏：每换一步朗读“第 n 步，共 m 步”
    expect(screen.getByText(/^第 2 步，共 8 步。线程/u)).toHaveAttribute('aria-live', 'polite');
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(
      await screen.findByRole('dialog', { name: '协作台：从一个需求开始' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /下一步/u }));
    await screen.findByRole('dialog', { name: '线程：每件事的进度和产出' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(useTourStore.getState().active).toBeNull());
    expect(readTourRecord(USER.id, PID)).toMatchObject({ status: 'skipped', step: 1 });
  });

  it('未完成的引导不会打断进入，主动重看后可以完成', async () => {
    configureOnboarding({ autoStart: true });
    installBackend('owner');
    window.localStorage.setItem(
      `srh-onboarding:v1:${USER.id}:${PID}`,
      JSON.stringify({ status: 'active', step: 8, variant: 'member', at: NOW }),
    );
    renderAt(`/p/${PID}`);
    await screen.findByRole('heading', { level: 1, name: '协作台' });
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readTourRecord(USER.id, PID)).toMatchObject({ status: 'active', step: 8 });
    act(() => {
      useTourStore.getState().requestTour();
    });
    await screen.findByRole('dialog', { name: '协作台：从一个需求开始' });
    act(() => useTourStore.getState().goTo(8));
    const card = await screen.findByRole('dialog', { name: '⌘K：随时搜索和跳转' });
    expect(within(card).queryByRole('button', { name: '跳过引导' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '开始使用' }));
    await waitFor(() => expect(useTourStore.getState().active).toBeNull());
    expect(readTourRecord(USER.id, PID)?.status).toBe('done');
  });

  it('导师首次进入不显示欢迎框，主动帮助直接开始导师版引导', async () => {
    configureOnboarding({ autoStart: true });
    installBackend('advisor');
    renderAt(`/p/${PID}`);
    await screen.findByRole('heading', { level: 1, name: '协作台' });
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useTourStore.getState().active).toBeNull();
    act(() => useTourStore.getState().requestTour());
    const card = await screen.findByRole('dialog', { name: '协作台：学生的计划都在这' });
    expect(within(card).getByText('1 / 6')).toBeInTheDocument();
    expect(useTourStore.getState().active?.variant).toBe('advisor');
  });

  it('导师主动引导可以跳过并记住，下次进入仍不打断', async () => {
    configureOnboarding({ autoStart: true });
    installBackend('advisor');
    renderAt(`/p/${PID}`);
    await screen.findByRole('heading', { level: 1, name: '协作台' });
    act(() => useTourStore.getState().requestTour());
    await screen.findByRole('dialog', { name: '协作台：学生的计划都在这' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(useTourStore.getState().active).toBeNull());
    expect(readTourRecord(USER.id, PID)).toMatchObject({ status: 'skipped', welcomed: true });
  });
});

describe('帮助入口', () => {
  it('侧栏底部有「帮助」，? 打开帮助中心', async () => {
    installBackend('owner');
    const router = renderAt(`/p/${PID}`);
    expect(await screen.findByRole('link', { name: '帮助' })).toHaveAttribute(
      'href',
      `/p/${PID}/help`,
    );
    // 外壳先于懒加载页面出现；等首次导航完成，再模拟用户在页面上使用快捷键。
    await screen.findByRole('heading', { level: 1, name: '协作台' });
    fireEvent.keyDown(window, { key: '?' });
    expect(await screen.findByRole('heading', { level: 1, name: '帮助中心' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/p/${PID}/help`);
  });

  it('命令面板里能搜到「重看新手引导」和「帮助中心」', async () => {
    installBackend('owner');
    renderAt(`/p/${PID}/threads`);
    await screen.findByRole('heading', { level: 1, name: '线程' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: '搜索命令' });
    fireEvent.change(input, { target: { value: '引导' } });
    const option = await screen.findByRole('option', { name: /重看新手引导/u });
    fireEvent.click(option);
    expect(
      await screen.findByRole('dialog', { name: '协作台：从一个需求开始' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(useTourStore.getState().active).toBeNull());
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(await screen.findByRole('combobox', { name: '搜索命令' }), {
      target: { value: '帮助' },
    });
    expect(await screen.findByRole('option', { name: /帮助中心/u })).toBeInTheDocument();
  });
});

describe('帮助中心', () => {
  it('分模块的说明、给导师、快捷键、常见问题都在，可以搜索', async () => {
    installBackend('owner');
    renderAt(`/p/${PID}/help`);
    expect(await screen.findByRole('heading', { level: 1, name: '帮助中心' })).toBeInTheDocument();
    for (const id of ['coordinator', 'threads', 'workspace', 'docs', 'reviews']) {
      expect(document.getElementById(id)).toHaveAttribute('aria-labelledby', `${id}-title`);
    }
    for (const id of ['reports', 'inbox', 'advisor', 'shortcuts', 'faq']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(screen.getByRole('heading', { level: 2, name: '给导师' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '快捷键' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'agent 会不会乱改我的文档？' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '怎么邀请导师？' })).toBeInTheDocument();

    const search = screen.getByRole('searchbox', { name: '搜索帮助' });
    fireEvent.change(search, { target: { value: 'LaTeX' } });
    expect(screen.getByRole('heading', { level: 3, name: '文档' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: '看板' })).toBeNull();

    fireEvent.change(search, { target: { value: '完全不存在的词' } });
    expect(screen.getByText('没有找到和「完全不存在的词」相关的帮助')).toBeInTheDocument();
    // 输入框里的 × 和空状态里的按钮都能清除
    expect(screen.getAllByRole('button', { name: '清除搜索' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '清除搜索' })[1]!);
    expect(screen.getByRole('heading', { level: 3, name: '看板' })).toBeInTheDocument();
  });

  it('“重看新手引导”回到协作台并开始引导', async () => {
    installBackend('advisor');
    const router = renderAt(`/p/${PID}/help`);
    fireEvent.click(await screen.findByRole('button', { name: '重看新手引导' }));
    // 页面和引导各自按需加载，先等待路由提交，避免仍在旧帮助页中查找浮层。
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/${PID}`));
    expect(
      await screen.findByRole('dialog', { name: '协作台：学生的计划都在这' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/p/${PID}`);
  });
});

describe('模块介绍条', () => {
  it('常规模块页不再插入教学条，原介绍记录不被改写', async () => {
    configureOnboarding({ moduleIntro: true });
    installBackend('owner');
    writeIntroRecord(USER.id, 'reviews', { views: 1, dismissed: false });
    const router = renderAt(`/p/${PID}/reviews`);
    await screen.findByRole('heading', { level: 1, name: '审阅' });
    expect(screen.queryByRole('region', { name: '审阅是什么' })).toBeNull();
    expect(readIntroRecord(USER.id, 'reviews')).toMatchObject({ views: 1, dismissed: false });
    await act(() => router.navigate(`/p/${PID}/docs`));
    await screen.findByRole('heading', { level: 1, name: '文档' });
    expect(screen.queryByRole('region', { name: '文档是什么' })).toBeNull();
  });

  it('看过 3 次后不再自动出现', async () => {
    configureOnboarding({ moduleIntro: true });
    installBackend('owner');
    writeIntroRecord(USER.id, 'threads', { views: 3, dismissed: false });
    renderAt(`/p/${PID}/threads`);
    await screen.findByRole('heading', { level: 1, name: '线程' });
    expect(screen.queryByRole('region', { name: '线程是什么' })).toBeNull();
  });
});
