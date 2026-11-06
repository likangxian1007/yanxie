import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Thread } from '@srh/shared';
import { ThreadCard } from './ThreadCard';

const THREAD: Thread = {
  id: 'thr_1',
  projectId: 'prj_1',
  kind: 'project',
  rootMessageId: 'msg_1',
  title: '调研：扩散模型用于医学图像分割',
  label: '文献调研',
  ownerUserId: 'usr_1',
  statusBucket: 'working',
  statusText: ['调研扩散模型分割', '✓ 检索相关工作', '✱ 提取方法与数据集', '○ 整理对比表'].join(
    '\n',
  ),
  resolved: false,
  replyCount: 8,
  forwardedAt: null,
  agentSessionId: 'ses_1',
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

function renderCard(props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ThreadCard thread={THREAD} href="/p/prj_1/threads/thr_1" {...props} />
    </MemoryRouter>,
  );
}

describe('ThreadCard', () => {
  it('标题是链接，显示状态、当前步骤、回复数和负责人', () => {
    renderCard({ owner: { name: '张三', color: 1 }, activity: '正在阅读 MedSegDiff-V2' });
    expect(screen.getByRole('link', { name: THREAD.title })).toHaveAttribute(
      'href',
      '/p/prj_1/threads/thr_1',
    );
    expect(screen.getByText(/提取方法与数据集/, { selector: 'p span' })).toBeInTheDocument();
    expect(screen.getByText('8 条回复')).toBeInTheDocument();
    expect(screen.getByText('张三')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在阅读 MedSegDiff-V2');
  });

  it('列表标题打开辅助详情，独立完整页入口保持可用', () => {
    renderCard({
      href: '/p/prj_1/threads?q=扩散&thread=thr_1',
      fullHref: '/p/prj_1/threads/thr_1',
      returnHref: '/p/prj_1/threads?q=扩散',
    });
    expect(screen.getByRole('link', { name: THREAD.title })).toHaveAttribute(
      'href',
      '/p/prj_1/threads?q=扩散&thread=thr_1',
    );
    expect(screen.getByRole('link', { name: `在完整页面打开：${THREAD.title}` })).toHaveAttribute(
      'href',
      '/p/prj_1/threads/thr_1',
    );
  });

  it('不分配动画名额时，agent 动态是静态文字', () => {
    renderCard({ activity: '正在阅读', animate: false });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('正在阅读')).toBeInTheDocument();
  });

  it('compact 只显示进度，不展开清单', () => {
    renderCard({ density: 'compact' });
    expect(screen.getByRole('progressbar', { name: '清单进度' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
