import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentSession, Thread } from '@srh/shared';
import { AgentHaltedBanner } from './AgentHaltedBanner';

const THREAD: Thread = {
  id: 'thr_1',
  projectId: 'prj_1',
  kind: 'project',
  rootMessageId: 'msg_1',
  title: '相关工作调研',
  label: null,
  ownerUserId: 'usr_1',
  statusBucket: 'review_ready',
  statusText: ['相关工作调研', '✓ 检索', '✱ 写《相关工作》文档', '○ 送审'].join('\n'),
  resolved: false,
  replyCount: 1,
  forwardedAt: null,
  agentSessionId: 'agt_1',
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

const agent = (status: AgentSession['status']): AgentSession => ({
  id: 'agt_1',
  projectId: 'prj_1',
  threadId: 'thr_1',
  role: 'thread',
  status,
  model: 'deepseek-chat',
  activity: null,
  workingForUserId: null,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  effort: null,
  profile: null,
  goal: null,
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

function renderBanner(status: AgentSession['status'], writable = true) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentHaltedBanner
        projectId="prj_1"
        thread={THREAD}
        agent={agent(status)}
        writable={writable}
      />
    </QueryClientProvider>,
  );
}

describe('AgentHaltedBanner', () => {
  it('agent 出错或步数用完：说明停在哪一步，并给「继续」', () => {
    renderBanner('failed');
    expect(screen.getByText('agent 停下了，这件事还没做完')).toBeInTheDocument();
    expect(screen.getByText(/停在「写《相关工作》文档」/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });

  it('访客看不到「继续」', () => {
    renderBanner('failed', false);
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
  });

  it('agent 空闲（在等人回复）时不显示', () => {
    const { container } = renderBanner('idle');
    expect(container).toBeEmptyDOMElement();
  });
});
