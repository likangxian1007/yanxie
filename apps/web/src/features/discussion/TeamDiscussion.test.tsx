import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamDiscussion } from './TeamDiscussion';
import { useConversationDraft } from '@/components/chat/conversation-drafts';
const mocks = vi.hoisted(() => ({ send: vi.fn(), writable: true }));
vi.mock('@/lib/session', () => ({ useMeUser: () => ({ id: 'team-test-user', name: '自己' }) }));
vi.mock('@/lib/project', () => ({
  canWrite: () => mocks.writable,
  useMembers: () => ({ data: [], isPending: false, isError: false }),
  useMyRole: () => 'member',
  useThread: () => ({ data: { kind: 'project', title: '线程研究' } }),
}));
vi.mock('@/lib/messages', () => ({
  useSendMessage: () => ({ mutate: mocks.send, isPending: false, isError: false }),
}));
vi.mock('@/components/chat/MessageFeed', () => ({
  MessageFeed: ({
    onQuote,
    channel,
  }: {
    onQuote?: (message: unknown) => void;
    channel: string;
  }) => (
    <div>
      <span>频道：{channel}</span>
      {onQuote && (
        <button
          onClick={() =>
            onQuote({ id: 'msg_quote', author: { name: '合作者' }, body: '需要验证的结论' })
          }
        >
          引用测试记录
        </button>
      )}
    </div>
  ),
}));
function Context() {
  const [draft] = useConversationDraft('team-test', null, 'team-test-user');
  const location = useLocation();
  return (
    <>
      <output aria-label="智能体草稿">{draft}</output>
      <output aria-label="当前位置">
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
afterEach(() => {
  cleanup();
  mocks.send.mockReset();
  mocks.writable = true;
});
describe('team discussion', () => {
  it('quotes into the agent draft without sending and opens the relevant conversation', () => {
    render(
      <MemoryRouter initialEntries={['/p/team-test?discussion=project']}>
        <TeamDiscussion projectId="team-test" scope="project" />
        <Context />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '引用测试记录' }));
    expect(screen.getByLabelText('智能体草稿')).toHaveTextContent('引用 合作者');
    expect(screen.getByLabelText('智能体草稿')).toHaveTextContent('需要验证的结论');
    expect(screen.getByLabelText('智能体草稿')).toHaveTextContent('?discussion=project#msg_quote');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/p/team-test');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('sends literal team messages, never executes slash commands, and respects IME', () => {
    render(
      <MemoryRouter>
        <TeamDiscussion projectId="team-test" scope="project" />
      </MemoryRouter>,
    );
    const input = screen.getByRole('textbox', { name: '发送到团队讨论' });
    fireEvent.change(input, { target: { value: '/model 只是讨论草稿' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
    expect(mocks.send.mock.calls[0]?.[0]).toEqual({
      body: '/model 只是讨论草稿',
      agentVisible: false,
      fileIds: [],
    });
    expect(screen.queryByRole('button', { name: /模型/ })).not.toBeInTheDocument();
  });
  it('keeps discussion read-only for guests', () => {
    mocks.writable = false;
    render(
      <MemoryRouter>
        <TeamDiscussion projectId="guest-test" scope="project" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '引用测试记录' })).not.toBeInTheDocument();
  });
});
