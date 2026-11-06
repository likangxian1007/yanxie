import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { SettingsNavigation } from '../components/SettingsNavigation';
import { SETTINGS_TABS, SETTINGS_TAB_LABEL } from '../lib';

vi.mock('../components/GeneralSection', () => ({
  GeneralSection: () => <div>section:general</div>,
}));
vi.mock('../components/MembersSection', () => ({
  MembersSection: () => <div>section:members</div>,
}));
vi.mock('../components/InvitesSection', () => ({
  InvitesSection: () => <div>section:invites</div>,
}));
vi.mock('../components/InstructionsSection', () => ({
  InstructionsSection: () => <div>section:instructions</div>,
}));
vi.mock('../components/MemorySection', () => ({ MemorySection: () => <div>section:memory</div> }));
vi.mock('../components/RoutinesSection', () => ({
  RoutinesSection: () => <div>section:routines</div>,
}));
vi.mock('../components/ProfileSection', () => ({
  ProfileSection: () => <div>section:profile</div>,
}));
vi.mock('../components/IntegrationsSection', () => ({
  IntegrationsSection: () => <div>section:integrations</div>,
}));
vi.mock('../components/NotifySection', () => ({
  NotifySection: () => <div>section:notify</div>,
}));
vi.mock('@/features/versioning/components/VersioningSection', () => ({
  VersioningSection: () => <div>section:versioning</div>,
}));
vi.mock('../components/harness/ModelsSection', () => ({
  ModelsSection: () => <div>section:models</div>,
}));
vi.mock('../components/harness/McpSection', () => ({ McpSection: () => <div>section:mcp</div> }));
vi.mock('../components/harness/SkillsSection', () => ({
  SkillsSection: () => <div>section:skills</div>,
}));
vi.mock('../components/harness/CommandsSection', () => ({
  CommandsSection: () => <div>section:commands</div>,
}));
vi.mock('../components/harness/AgentProfilesSection', () => ({
  AgentProfilesSection: () => <div>section:agent-profiles</div>,
}));

const PATH = '/p/project/settings';
function renderAt(search = '', directory = false) {
  const router = createMemoryRouter(
    [
      {
        path: '/p/:projectId/settings',
        element: directory ? <SettingsNavigation projectId="project" /> : <SettingsPage />,
      },
    ],
    { initialEntries: [PATH + search] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
function mobile() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 767.98px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('设置目录与分区路由', () => {
  it.each(SETTINGS_TABS)('保留 ?tab=%s 的直接入口', (tab) => {
    const router = renderAt(`?tab=${tab}&file=notes.md`);
    expect(screen.getByRole('region', { name: SETTINGS_TAB_LABEL[tab] })).toHaveTextContent(
      `section:${tab}`,
    );
    expect(router.state.location.search).toBe(`?tab=${tab}&file=notes.md`);
    expect(screen.queryByRole('tablist')).toBeNull();
  });
  it('桌面不带分区或无效分区时显示项目设置', () => {
    renderAt();
    expect(screen.getByText('section:general')).toBeInTheDocument();
  });
  it('未知分区安全回到项目设置', () => {
    renderAt('?tab=unknown');
    expect(screen.getByText('section:general')).toBeInTheDocument();
  });
  it('全部 15 个分区按个人、课题、智能体分组，保留路径并支持键盘移动', () => {
    renderAt('?tab=commands', true);
    const nav = screen.getByRole('navigation', { name: '设置分区' });
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((node) => node.textContent),
    ).toEqual(['个人', '课题', '智能体']);
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(15);
    expect(links.map((node) => node.textContent)).toEqual([
      '个人与外观',
      '接入',
      '通知',
      '项目信息',
      '成员',
      '邀请',
      '项目记忆',
      '版本与提案',
      '协调者指令',
      '定时任务',
      '模型',
      'MCP 连接',
      '技能',
      '快捷指令',
      '角色配置',
    ]);
    expect(
      new Set(
        links.map((node) =>
          new URL(node.getAttribute('href')!, 'http://localhost').searchParams.get('tab'),
        ),
      ),
    ).toEqual(new Set(SETTINGS_TABS));
    expect(within(nav).getByRole('link', { name: '快捷指令' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: 'ArrowDown' });
    expect(links[1]).toHaveFocus();
    fireEvent.keyDown(links[1]!, { key: 'End' });
    expect(links.at(-1)).toHaveFocus();
    fireEvent.keyDown(links.at(-1)!, { key: 'ArrowDown' });
    expect(links[0]).toHaveFocus();
    fireEvent.keyDown(links[0]!, { key: 'ArrowUp' });
    expect(links.at(-1)).toHaveFocus();
    fireEvent.keyDown(links.at(-1)!, { key: 'Home' });
    expect(links[0]).toHaveFocus();
  });
  it('选择分区时移除上一个分区的 file 参数', async () => {
    const router = renderAt('?tab=memory&file=notes.md', true);
    fireEvent.click(screen.getByRole('link', { name: '模型' }));
    expect(await screen.findByRole('link', { name: '模型' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(router.state.location.search).toBe('?tab=models');
  });
  it('手机默认显示目录，选择分区后可返回目录', async () => {
    mobile();
    const router = renderAt();
    expect(screen.getByRole('navigation', { name: '设置分区' })).toBeInTheDocument();
    expect(screen.queryByText('section:general')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '个人与外观' }));
    expect(await screen.findByText('section:profile')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '设置分区' })).toBeNull();
    expect(router.state.location.search).toBe('?tab=profile');
    fireEvent.click(screen.getByRole('link', { name: '设置目录' }));
    expect(await screen.findByRole('navigation', { name: '设置分区' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });
});
