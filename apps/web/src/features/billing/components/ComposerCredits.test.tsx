import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BillingOverview, ProjectBillingView } from '@srh/shared';
import { billingKeys } from '../api';
import { ComposerCredits } from './ComposerCredits';

const me: BillingOverview = {
  enabled: true,
  exempt: false,
  balance: 2800,
  topupEnabled: true,
  packs: [],
  prices: [
    { modelId: 'deepseek/pro', name: 'DeepSeek', inputPerMillion: 600, outputPerMillion: 2400 },
  ],
  recent: [],
  teams: [],
};

function team(over: Partial<ProjectBillingView> = {}): ProjectBillingView {
  return {
    enabled: true,
    exempt: false,
    projectId: 'p1',
    projectName: '课题',
    canManage: false,
    balance: 12340,
    monthUsed: 0,
    monthlyCap: null,
    personalBalance: 2800,
    source: 'team',
    members: null,
    ...over,
  };
}

function wrap(node: ReactNode, data: { me?: BillingOverview; project?: ProjectBillingView } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(billingKeys.me, data.me ?? me);
  if (data.project) client.setQueryData(billingKeys.project('p1'), data.project);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ComposerCredits', () => {
  it('项目里先显示团队积分', () => {
    wrap(<ComposerCredits projectId="p1" modelId="deepseek/pro" />, { project: team() });
    expect(screen.getByRole('button', { name: '团队积分 12,340' })).toBeInTheDocument();
  });

  it('团队用完时显示个人积分', () => {
    wrap(<ComposerCredits projectId="p1" />, {
      project: team({ balance: 0, source: 'personal' }),
    });
    expect(screen.getByRole('button', { name: '个人积分 2,800' })).toBeInTheDocument();
  });

  it('个人会话只看个人积分', () => {
    wrap(<ComposerCredits projectId="p1" personal />, { project: team() });
    expect(screen.getByRole('button', { name: '个人积分 2,800' })).toBeInTheDocument();
  });

  it('两个钱包都空了提示去充值', () => {
    wrap(<ComposerCredits projectId="p1" personal />, { me: { ...me, balance: 0 } });
    expect(screen.getByRole('button', { name: '余额不足，去充值' })).toHaveClass('text-danger');
  });

  it('计费关闭或免扣费时不显示', () => {
    const { container } = wrap(<ComposerCredits projectId="p1" personal />, {
      me: { ...me, exempt: true },
    });
    expect(container).toBeEmptyDOMElement();
  });
});
