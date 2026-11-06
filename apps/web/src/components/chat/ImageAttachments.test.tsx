import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, OutputRef, User } from '@srh/shared';
import { MessageItem } from './MessageItem';

vi.mock('@/lib/project', () => ({
  useCoordinator: () => ({ id: 'coordinator' }),
  useMembers: () => ({ data: [] }),
}));
vi.mock('@/lib/messages', () => ({
  useDeleteMessage: () => ({}),
  useEditMessage: () => ({}),
  useToggleReaction: () => ({}),
}));

const me = { id: 'self', name: '成员' } as User;
const file = (id: string, title: string): OutputRef => ({ id, kind: 'file', ref: id, title });
const message = (outputs: OutputRef[]): Message => ({
  id: 'msg_img',
  projectId: 'p',
  threadId: null,
  author: { id: 'other', name: '成员', kind: 'user' },
  kind: 'text',
  body: '看图',
  meta: { fileIds: outputs.map((o) => o.ref) },
  agentVisible: true,
  reactions: [],
  outputs,
  rootOfThreadId: null,
  editedAt: null,
  createdAt: '2026-10-27T00:00:00Z',
});

function renderMessage(outputs: OutputRef[]) {
  return render(
    <MemoryRouter>
      <MessageItem projectId="p" message={message(outputs)} me={me} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('消息里的图片附件', () => {
  it('图片显示为懒加载缩略图，非图片和 SVG 保持文件标签', () => {
    renderMessage([file('f1', '曲线.png'), file('f2', '数据.csv'), file('f3', 'logo.svg')]);
    const list = screen.getByRole('list', { name: '图片附件' });
    const img = within(list).getByRole('img', { name: '曲线.png' });
    expect(img).toHaveAttribute('src', '/api/v1/projects/p/files/f1');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveClass('object-cover');
    // 框尺寸固定，图片晚到不改变消息高度
    expect(img.closest('button')).toHaveClass('h-[180px]', 'w-[240px]');
    expect(screen.getByText('数据.csv')).toBeInTheDocument();
    expect(screen.getByText('logo.svg')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'logo.svg' })).toBeNull();
  });

  it('多张图片排成网格，加载完成后去掉骨架', () => {
    const view = renderMessage([file('a', 'a.png'), file('b', 'b.jpg'), file('c', 'c.webp')]);
    const list = screen.getByRole('list', { name: '图片附件' });
    expect(list).toHaveClass('grid', 'grid-cols-3');
    expect(view.container.querySelectorAll('.skeleton-shimmer')).toHaveLength(3);
    fireEvent.load(within(list).getByRole('img', { name: 'a.png' }));
    expect(view.container.querySelectorAll('.skeleton-shimmer')).toHaveLength(2);
  });

  it('加载失败时退回原来的文件标签', () => {
    renderMessage([file('f1', '坏图.png')]);
    fireEvent.error(screen.getByRole('img', { name: '坏图.png' }));
    expect(screen.queryByRole('list', { name: '图片附件' })).toBeNull();
    const chip = screen.getByText('坏图.png').closest('a');
    expect(chip).toHaveAttribute('href', expect.stringContaining('/files/f1?download=1'));
  });

  it('点击打开预览，可下载、打开原图，Esc 关闭', async () => {
    renderMessage([file('f1', '曲线.png')]);
    fireEvent.click(screen.getByRole('button', { name: '查看图片 曲线.png' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: '下载' })).toHaveAttribute(
      'href',
      '/api/v1/projects/p/files/f1?download=1',
    );
    expect(within(dialog).getByRole('link', { name: '打开原图' })).toHaveAttribute(
      'href',
      '/api/v1/projects/p/files/f1',
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
