import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { Composer } from './Composer';
const members = [
  {
    projectId: 'p',
    role: 'member',
    joinedAt: '2026-11-01T00:00:00Z',
    user: { id: 'usr_a', name: '张三', email: 'zhang@example.test', avatarColor: 0 },
  },
  {
    projectId: 'p',
    role: 'member',
    joinedAt: '2026-11-01T00:00:00Z',
    user: { id: 'usr_b', name: '张三甲', email: 'other@example.test', avatarColor: 1 },
  },
];
function mount(initial = '', draftKey?: string) {
  vi.spyOn(api, 'get').mockResolvedValue(members);
  const send = vi.fn();
  function Test() {
    const [value, setValue] = useState(initial);
    return (
      <Composer
        mentionProjectId="p"
        mentionDraftKey={draftKey}
        value={value}
        onChange={setValue}
        onSubmit={send}
      />
    );
  }
  const view = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Test />
    </QueryClientProvider>,
  );
  return { input: screen.getByRole('textbox'), send, view };
}
it('键盘选择成员并发送精确 ID，继续输入仍保留范围', async () => {
  const { input, send } = mount();
  fireEvent.change(input, { target: { value: '@张' } });
  await screen.findByRole('option', { name: /张三 zhang/ });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input).toHaveValue('@张三 ');
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '@张三 看看' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledWith({
    body: '@张三 看看',
    agentVisible: true,
    mentions: [{ userId: 'usr_a', label: '张三', start: 0, end: 3 }],
  });
});
it('邮箱筛选、取消及输入法不会误选或误发送', async () => {
  const { input, send } = mount();
  fireEvent.change(input, { target: { value: '@zhang@example' } });
  await screen.findByRole('option', { name: /张三 zhang/ });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty('mentions');
});

it('草稿恢复保留已选成员，切换作用域不会带入其它聊天的提及', async () => {
  const first = mount('', 'mentions:a');
  fireEvent.change(first.input, { target: { value: '@张' } });
  fireEvent.click(await screen.findByRole('option', { name: '张三 zhang@example.test' }));
  fireEvent.change(first.input, { target: { value: '@张三 稍后看' } });
  expect(localStorage.getItem('mentions:a')).toContain('usr_a');
  first.view.unmount();
  const restored = mount('@张三 稍后看', 'mentions:a');
  fireEvent.keyDown(restored.input, { key: 'Enter' });
  expect(restored.send).toHaveBeenCalledWith(
    expect.objectContaining({ mentions: [{ userId: 'usr_a', label: '张三', start: 0, end: 3 }] }),
  );
  restored.view.unmount();
  const other = mount('@张三 稍后看', 'mentions:b');
  fireEvent.keyDown(other.input, { key: 'Enter' });
  expect(other.send.mock.calls[0]?.[0]).not.toHaveProperty('mentions');
});
