import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseChecklist, type AgentSession } from '@srh/shared';
import { PlanView } from './PlanView';
import { summarizePlan } from './plan-summary';

const TEXT = [
  '扩散模型医学分割代表工作梳理',
  '✓ 确认范围',
  '✓ 检查项目内资料',
  '✓ 确认检索能力',
  '**✓ 建好文档骨架**',
  '✱ 等 kk 提供论文 PDF',
  '○ 逐篇核对数据集与 Dice',
  '○ 填写表格',
].join('\n');

const agent = (status: AgentSession['status'], activity: string | null = null): AgentSession => ({
  id: 'agt_1',
  projectId: 'prj_1',
  threadId: 'thr_1',
  role: 'thread',
  status,
  model: 'deepseek-chat',
  effort: null,
  profile: null,
  goal: null,
  activity,
  workingForUserId: null,
  tokenUsage: { input: 0, output: 0, cached: 0 },
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

describe('summarizePlan', () => {
  it('当前一步取第一个 ✱，写成「第 x 步，共 y 步」', () => {
    expect(summarizePlan(parseChecklist(TEXT))).toMatchObject({
      total: 7,
      done: 4,
      current: 5,
      label: '第 5 步，共 7 步',
    });
  });

  it('没有 ✱ 时取第一个未完成的步骤；全部完成时写明', () => {
    expect(summarizePlan(parseChecklist('目标\n✓ a\n○ b')).current).toBe(2);
    expect(summarizePlan(parseChecklist('目标\n✓ a\n✓ b')).label).toBe('2 步全部完成');
  });
});

describe('PlanView', () => {
  it('显示目标、第几步和进度条', () => {
    render(<PlanView text={TEXT} />);
    expect(screen.getByText('扩散模型医学分割代表工作梳理')).toBeInTheDocument();
    expect(screen.getByText('第 5 步，共 7 步')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: '计划进度' });
    expect(bar).toHaveAttribute('aria-valuenow', '4');
    expect(bar).toHaveAttribute('aria-valuemax', '7');
  });

  it('较早完成的步骤默认收起，只留最近完成的一步；可以展开', () => {
    render(<PlanView text={TEXT} />);
    const list = screen.getByRole('list', { name: '扩散模型医学分割代表工作梳理' });
    const states = () =>
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.dataset.state)
        .filter(Boolean);
    expect(states()).toEqual(['done', 'current', 'todo', 'todo']);
    fireEvent.click(screen.getByRole('button', { name: '显示更早完成的 3 步' }));
    expect(states()).toEqual(['done', 'done', 'done', 'done', 'current', 'todo', 'todo']);
  });

  it('agent 工作中时，当前一步下面写出它正在做什么', () => {
    render(<PlanView text={TEXT} agent={agent('running', '正在读上传的 PDF')} />);
    expect(screen.getByText('正在读上传的 PDF')).toBeInTheDocument();
  });

  it('agent 没在工作时显示说明（如等你回复），不显示活动', () => {
    render(<PlanView text={TEXT} agent={agent('idle', '旧的活动')} idleNote="等你回复" />);
    expect(screen.getByText('等你回复')).toBeInTheDocument();
    expect(screen.queryByText('旧的活动')).not.toBeInTheDocument();
  });

  it('给读屏标出每一步的状态', () => {
    render(<PlanView text={TEXT} collapseDoneAfter={10} />);
    expect(screen.getAllByText('已完成：')).toHaveLength(4);
    expect(screen.getByText('当前步骤：')).toBeInTheDocument();
    expect(screen.getAllByText('未开始：')).toHaveLength(2);
  });

  it('空清单不渲染', () => {
    const { container } = render(<PlanView text="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
