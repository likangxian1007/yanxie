import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@srh/shared';
import { EditablePlan } from './EditablePlan';

const mutate = vi.fn();
vi.mock('../thread-api', () => ({
  useUpdateThread: () => ({ mutate, isPending: false }),
}));

const thread = (statusText: string): Thread => ({
  id: 'thr_1',
  projectId: 'prj_1',
  kind: 'project',
  rootMessageId: 'msg_1',
  title: '复现',
  label: null,
  ownerUserId: 'usr_1',
  statusBucket: 'working',
  statusText,
  resolved: false,
  replyCount: 0,
  forwardedAt: null,
  agentSessionId: null,
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

const TEXT = '复现 GraphCL\n✓ 读论文\n✱ 跑基线\n○ 写结果表';

beforeEach(() => mutate.mockReset());

describe('EditablePlan', () => {
  it('访客 / 只读没有编辑入口', () => {
    render(<EditablePlan thread={thread(TEXT)} canEdit={false} />);
    expect(screen.getByText('跑基线')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑计划' })).toBeNull();
  });

  it('成员改目标、改步骤、加一步、调顺序、删一步，保存写回状态清单', () => {
    render(<EditablePlan thread={thread(TEXT)} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: '编辑计划' }));

    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '复现 GraphCL v2' } });
    fireEvent.change(screen.getByLabelText('第 3 步'), { target: { value: '写结果表和图' } });
    fireEvent.click(screen.getByRole('button', { name: '添加一步' }));
    fireEvent.change(screen.getByLabelText('第 4 步'), { target: { value: '送导师审阅' } });
    fireEvent.click(screen.getByRole('button', { name: '第 4 步上移' }));
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 步' }));
    // 第 1 步（原「跑基线」）进行中 → 已完成
    fireEvent.click(screen.getByRole('button', { name: /第 1 步：进行中/u }));
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual({
      id: 'thr_1',
      patch: { statusText: '复现 GraphCL v2\n✓ 跑基线\n○ 送导师审阅\n○ 写结果表和图' },
    });
  });

  it('在步骤里按回车插入下一步；取消不保存', () => {
    render(<EditablePlan thread={thread(TEXT)} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: '编辑计划' }));
    fireEvent.keyDown(screen.getByLabelText('第 1 步'), { key: 'Enter' });
    expect(screen.getByLabelText('第 4 步')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('第 2 步'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '编辑计划' })).toBeTruthy();
  });

  it('还没有计划时成员可以自己写', () => {
    render(<EditablePlan thread={thread('')} canEdit emptyText="agent 列出计划后会显示在这里。" />);
    fireEvent.click(screen.getByRole('button', { name: '写计划' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '整理相关工作' } });
    fireEvent.click(screen.getByRole('button', { name: '添加一步' }));
    fireEvent.change(screen.getByLabelText('第 1 步'), { target: { value: '检索' } });
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    expect(mutate.mock.calls[0]![0].patch).toEqual({ statusText: '整理相关工作\n○ 检索' });
  });
});
