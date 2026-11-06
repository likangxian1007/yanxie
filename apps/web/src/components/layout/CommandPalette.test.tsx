import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from './layout-store';
import { DOC_SEARCH_DEBOUNCE_MS } from './palette-sources';
import { DOC_HIT, installFakeBackend, MENTOR, PID, renderShell } from './shell-test-utils';

function sleep(ms: number) {
  return act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function openWithShortcut() {
  await screen.findByRole('heading', { level: 1, name: '协作台' });
  // 和真实按键一样：Ctrl 按下 → K 按下 → 松开（事件从当前焦点冒泡到 window）
  const from = document.activeElement ?? document.body;
  fireEvent.keyDown(from, { key: 'Control', ctrlKey: true });
  fireEvent.keyDown(from, { key: 'k', code: 'KeyK', ctrlKey: true });
  fireEvent.keyUp(from, { key: 'k', code: 'KeyK', ctrlKey: true });
  fireEvent.keyUp(from, { key: 'Control' });
  const dialog = await screen.findByRole('dialog', { name: '命令面板' });
  const input = within(dialog).getByRole('combobox', { name: '搜索命令' });
  await waitFor(() => expect(input).toHaveFocus());
  return { dialog, input };
}

describe('CommandPalette', () => {
  beforeEach(() => {
    useLayoutStore.setState({ paletteOpen: false, mobileNavOpen: false });
  });

  afterEach(() => {
    useLayoutStore.setState({ paletteOpen: false, mobileNavOpen: false });
    vi.unstubAllGlobals();
  });

  it('Ctrl+K 打开后，等一会儿按一次 Esc 就关闭', async () => {
    installFakeBackend();
    renderShell();
    const { input } = await openWithShortcut();

    // 复现步骤：打开后停 0.5–1.2 秒，让线程、成员等数据加载完再按 Esc
    await sleep(700);
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    expect(useLayoutStore.getState().paletteOpen).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull());
  });

  it('Esc 不会被页面上其他 keydown 监听拦下', async () => {
    installFakeBackend();
    renderShell();
    // 模拟一个在面板打开前就注册、吞掉 Esc 的 document 级监听（如别处的浮层 / 焦点还原逻辑）
    const swallow = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', swallow);
    try {
      const { input } = await openWithShortcut();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(useLayoutStore.getState().paletteOpen).toBe(false);
    } finally {
      document.removeEventListener('keydown', swallow);
    }
  });

  it('输入法组合中的 Esc 只取消组合，不关面板', async () => {
    installFakeBackend();
    renderShell();
    const { input } = await openWithShortcut();
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(useLayoutStore.getState().paletteOpen).toBe(true);
  });

  it('能搜到文档（防抖后请求一次），回车打开文档', async () => {
    const fetchMock = installFakeBackend();
    const { router } = renderShell();
    const { input } = await openWithShortcut();

    fireEvent.change(input, { target: { value: '综' } });
    fireEvent.change(input, { target: { value: '综述' } });

    const group = await screen.findByRole('group', { name: '文档' });
    const option = within(group).getByRole('option', { name: /文献综述/u });
    const searches = fetchMock.mock.calls
      .map(([u]) => new URL(String(u), 'http://localhost'))
      .filter((u) => u.pathname.endsWith('/docs/search'));
    // 连续输入只在停下后搜一次
    expect(searches.map((u) => u.searchParams.get('q'))).toEqual(['综述']);

    // 键盘：活动项跟着 aria-activedescendant 走
    while (input.getAttribute('aria-activedescendant') !== option.id) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    expect(option).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(
      () => expect(router.state.location.pathname).toBe(`/p/${PID}/docs/${DOC_HIT.id}`),
      { timeout: 3000 },
    );
    expect(useLayoutStore.getState().paletteOpen).toBe(false);
  });

  it('研究搜索仅在输入后请求，展示记录、书目和结论命中', async () => {
    const fetchMock = installFakeBackend({
      researchHits: [
        { kind: 'record', id: 'rrc_a', recordId: 'rrc_a', title: '社区访谈', snippet: '服务覆盖' },
        { kind: 'source', id: 'rsr_a', recordId: null, title: '社区报告', snippet: '旧版书目' },
        {
          kind: 'finding',
          id: 'rfd_a',
          recordId: 'rrc_a',
          title: '社区覆盖有差异',
          snippet: '样本局限',
        },
      ],
    });
    const { router } = renderShell();
    const { input } = await openWithShortcut();
    const researchRequests = () =>
      fetchMock.mock.calls
        .map(([u]) => new URL(String(u), 'http://localhost'))
        .filter((u) => u.pathname.includes('/research'));
    expect(researchRequests()).toEqual([]);
    fireEvent.change(input, { target: { value: '社' } });
    fireEvent.change(input, { target: { value: '社区' } });
    const findings = await screen.findByRole('group', { name: '研究结论' });
    expect(within(findings).getByRole('option', { name: /社区覆盖有差异/u })).toBeTruthy();
    expect(screen.getByRole('group', { name: '研究空间' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '研究资料' })).toBeTruthy();
    expect(researchRequests().map((u) => [u.pathname, u.searchParams.get('q')])).toEqual([
      [`/api/v1/projects/${PID}/research/search`, '社区'],
    ]);
    fireEvent.click(within(findings).getByRole('option', { name: /社区覆盖有差异/u }));
    await waitFor(() =>
      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
        `/p/${PID}/research/rrc_a?section=findings`,
      ),
    );
  });

  it('能按名字找到成员，选中后打开成员设置', async () => {
    installFakeBackend();
    const { router } = renderShell();
    const { input } = await openWithShortcut();

    fireEvent.change(input, { target: { value: '王' } });
    const group = await screen.findByRole('group', { name: '成员' });
    const option = within(group).getByRole('option', { name: new RegExp(MENTOR.name, 'u') });
    fireEvent.click(option);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/${PID}/settings`));
    expect(router.state.location.search).toBe('?tab=members');
  });

  it('第一下 Esc 立即从页面移除（不等退出动画）', async () => {
    installFakeBackend();
    renderShell();
    const { input } = await openWithShortcut();
    fireEvent.change(input, { target: { value: 'mcp' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useLayoutStore.getState().paletteOpen).toBe(false);
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull();
  });

  it.each([
    ['MCP', '设置', /^设置 · MCP 连接$/u, '?tab=mcp'],
    ['定时任务', '设置', /设置 · 定时任务/u, '?tab=routines'],
    ['Skill', '设置', /^设置 · 技能$/u, '?tab=skills'],
    ['技能', '设置', /^设置 · 技能$/u, '?tab=skills'],
    ['Profile', '设置', /^设置 · 角色配置$/u, '?tab=agent-profiles'],
    ['角色配置', '设置', /^设置 · 角色配置$/u, '?tab=agent-profiles'],
    ['快捷指令', '设置', /^设置 · 快捷指令$/u, '?tab=commands'],
    ['实验卡', 'Skill、指令与 MCP', /实验卡/u, '?tab=skills'],
    ['weekly', 'Skill、指令与 MCP', /\/weekly/u, '?tab=commands'],
    ['arxiv', 'Skill、指令与 MCP', /arxiv-search/u, '?tab=mcp'],
  ])('搜「%s」能跳到设置里对应的分区', async (q, groupName, optionName, search) => {
    installFakeBackend();
    const { router } = renderShell();
    const { input } = await openWithShortcut();
    fireEvent.change(input, { target: { value: q } });
    const group = await screen.findByRole('group', { name: groupName });
    fireEvent.click(await within(group).findByRole('option', { name: optionName }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/p/${PID}/settings`));
    expect(router.state.location.search).toBe(search);
  });

  it('内置斜杠指令不列；空面板里不列设置分区和 Skill', async () => {
    installFakeBackend();
    renderShell();
    const { input } = await openWithShortcut();
    await sleep(50);
    expect(screen.queryByRole('group', { name: '设置' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Skill、指令与 MCP' })).toBeNull();
    fireEvent.change(input, { target: { value: 'stop' } });
    await sleep(50);
    expect(screen.queryByRole('option', { name: /\/stop/u })).toBeNull();
  });

  it('文档搜索接口 404 时没有文档结果，其他结果照常', async () => {
    installFakeBackend({ docSearch: 'missing' });
    renderShell();
    const { input } = await openWithShortcut();

    fireEvent.change(input, { target: { value: '王' } });
    expect(await screen.findByRole('group', { name: '成员' })).toBeInTheDocument();
    // 防抖结束、请求失败后：“正在搜索文档…”消失，也没有文档分组
    await sleep(DOC_SEARCH_DEBOUNCE_MS);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 3000 });
    expect(screen.queryByRole('group', { name: '文档' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeInTheDocument();
  });
});
