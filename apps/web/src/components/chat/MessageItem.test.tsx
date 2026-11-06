import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, User } from '@srh/shared';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
vi.mock('@/lib/project', () => ({
  useCoordinator: () => ({ id: 'coordinator' }),
  useMembers: () => ({ data: [] }),
}));
vi.mock('@/lib/messages', () => ({
  useDeleteMessage: () => ({}),
  useEditMessage: () => ({}),
  useToggleReaction: () => ({}),
}));
const me = { id: 'self', name: '同名成员' } as User;
const message = (authorId: string, kind: 'user' | 'agent' = 'user'): Message => ({
  id: 'msg_test',
  projectId: 'p',
  threadId: null,
  author: { id: authorId, name: '同名成员', kind },
  kind: 'text',
  body: '内容',
  meta: {},
  agentVisible: true,
  reactions: [],
  outputs: [],
  rootOfThreadId: null,
  editedAt: null,
  createdAt: '2026-10-27T00:00:00Z',
});
afterEach(cleanup);
describe('conversation identity and brand', () => {
  it('offers quote as an accessible toolbar icon without repeated body text', () => {
    const onQuote = vi.fn();
    const item = message('other');
    render(
      <MemoryRouter>
        <MessageItem projectId="p" message={item} me={me} onQuote={onQuote} />
      </MemoryRouter>,
    );
    const quote = screen.getByRole('button', { name: '引用到智能体对话' });
    expect(quote.textContent).toBe('');
    fireEvent.click(quote);
    expect(onQuote).toHaveBeenCalledWith(item);
    expect(screen.getByRole('button', { name: '更多操作' }).closest('.absolute')).toHaveClass(
      'top-0',
    );
  });
  it('aligns the current user by ID, not display name', () => {
    const view = render(
      <MemoryRouter>
        <MessageItem projectId="p" message={message('self')} me={me} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('article')).toHaveClass('flex-row-reverse');
    view.rerender(
      <MemoryRouter>
        <MessageItem projectId="p" message={message('other')} me={me} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('article')).not.toHaveClass('flex-row-reverse');
  });
  it('uses the same circular brand for personal assistant history and streaming', () => {
    const view = render(
      <MemoryRouter>
        <MessageItem projectId="p" message={message('personal-agent', 'agent')} me={me} />
      </MemoryRouter>,
    );
    const historical = view.container.querySelector('[data-kind="agent"] svg')?.outerHTML;
    expect(historical).toContain('viewBox="0 0 40 40"');
    view.rerender(<StreamingMessage name="个人智能体" kind="agent" text="正在整理" />);
    expect(view.container.querySelector('[data-kind="agent"] svg')?.outerHTML).toBe(historical);
    expect(view.container.querySelector('.lucide-sparkles')).toBeNull();
  });
});
