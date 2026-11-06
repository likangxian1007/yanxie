import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChecklistView } from './ChecklistView';

const TEXT = [
  '调研扩散模型分割',
  '✓ 检索相关工作',
  '**✓ 筛选出 12 篇论文**',
  '✱ 提取方法与数据集',
  '○ 整理对比表',
].join('\n');

describe('ChecklistView', () => {
  it('解析标题、步骤状态与加粗高亮', () => {
    render(<ChecklistView text={TEXT} />);

    expect(screen.getByText('调研扩散模型分割')).toBeInTheDocument();
    expect(screen.getByText('2/4')).toBeInTheDocument();

    const list = screen.getByRole('list', { name: '调研扩散模型分割' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.dataset.mark)).toEqual(['done', 'done', 'active', 'todo']);

    const highlighted = items.filter((li) => li.dataset.highlight === 'true');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('筛选出 12 篇论文');
    // 加粗标记本身不显示
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it('给读屏提供每一步的状态', () => {
    render(<ChecklistView text={TEXT} />);
    expect(screen.getAllByText('已完成：')).toHaveLength(2);
    expect(screen.getByText('进行中：')).toBeInTheDocument();
    expect(screen.getByText('未开始：')).toBeInTheDocument();
  });

  it('显示进度条', () => {
    render(<ChecklistView text={TEXT} />);
    const bar = screen.getByRole('progressbar', { name: '清单进度' });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
  });

  it('空清单不渲染', () => {
    const { container } = render(<ChecklistView text="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
