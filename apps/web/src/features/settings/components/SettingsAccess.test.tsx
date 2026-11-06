import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ProjectRole } from '@srh/shared';
import { describe, expect, it } from 'vitest';
import { qk } from '@/lib/query-keys';
import { GeneralSection } from './GeneralSection';
import { InvitesSection } from './InvitesSection';

const NOW = '2026-10-26T08:00:00.000Z';
const PROJECT = {
  id: 'project',
  name: '研究课题',
  description: '',
  icon: '研',
  color: 0,
  instructions: '',
  visibility: 'team',
  createdBy: 'user',
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};
function renderSection(role: ProjectRole, section: 'general' | 'invites') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(qk.me, {
    user: {
      id: 'user',
      email: 'a@lab.edu',
      name: '成员',
      avatarColor: 0,
      avatarUrl: null,
      createdAt: NOW,
    },
    projects: [{ ...PROJECT, role }],
  });
  client.setQueryData(qk.project('project'), PROJECT);
  client.setQueryData(qk.invites('project'), []);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {section === 'general' ? (
          <GeneralSection pid="project" />
        ) : (
          <InvitesSection pid="project" />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('纵向设置保留原有角色权限', () => {
  it.each(['owner', 'advisor'] as const)('%s 可以修改项目信息', (role) => {
    renderSection(role, 'general');
    const name = screen.getByRole('textbox', { name: '项目名称' });
    expect(name).toBeEnabled();
    fireEvent.change(name, { target: { value: '新课题' } });
    expect(screen.getByRole('button', { name: '保存更改' })).toBeEnabled();
    if (role === 'owner')
      expect(screen.getByRole('button', { name: '删除项目' })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: '删除项目' })).toBeNull();
  });
  it.each(['member', 'guest'] as const)('%s 只能查看项目信息', (role) => {
    renderSection(role, 'general');
    expect(screen.getByRole('textbox', { name: '项目名称' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存更改' })).toBeDisabled();
    expect(screen.getByText('只有负责人和导师可以修改')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除项目' })).toBeNull();
  });
  it.each(['member', 'guest'] as const)('%s 无法生成邀请', (role) => {
    renderSection(role, 'invites');
    expect(
      screen.getByRole('heading', { name: '只有负责人和导师可以邀请成员' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成邀请链接' })).toBeNull();
  });
  it.each(['owner', 'advisor'] as const)('%s 保留生成邀请入口', (role) => {
    renderSection(role, 'invites');
    expect(screen.getByRole('heading', { name: '邀请成员' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成邀请链接' })).toBeEnabled();
  });
});
