import { describe, expect, it } from 'vitest';
import { parseChecklist } from '@srh/shared';
import {
  draftFromText,
  draftToText,
  insertStep,
  moveStep,
  removeStep,
  samePlan,
} from './plan-edit';

const TEXT = '复现 GraphCL\n✓ 读论文\n**✱ 跑基线**\n○ 写结果表';

describe('plan-edit', () => {
  it('原文 → 草稿 → 原文：格式和 update_status 一致，加粗高亮去掉', () => {
    const d = draftFromText(TEXT);
    expect(d.goal).toBe('复现 GraphCL');
    expect(d.steps.map((s) => [s.mark, s.text])).toEqual([
      ['done', '读论文'],
      ['active', '跑基线'],
      ['todo', '写结果表'],
    ]);
    expect(draftToText(d)).toBe('复现 GraphCL\n✓ 读论文\n✱ 跑基线\n○ 写结果表');
  });

  it('空步骤丢掉，换行压成一行；没有目标时第 1 行留空也能解析', () => {
    const d = draftFromText(TEXT);
    d.goal = '';
    d.steps[0]!.text = '  ';
    d.steps[1]!.text = '跑\n基线';
    const text = draftToText(d);
    expect(text).toBe('\n✱ 跑 基线\n○ 写结果表');
    expect(parseChecklist(text)).toMatchObject({ title: '', lines: [{ text: '跑 基线' }, {}] });
  });

  it('上移、下移、插入、删除', () => {
    const steps = draftFromText(TEXT).steps;
    expect(moveStep(steps, 2, -1).map((s) => s.text)).toEqual(['读论文', '写结果表', '跑基线']);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 1)).toBe(steps);
    const added = insertStep(steps, 1);
    expect(added).toHaveLength(4);
    expect(added[1]).toMatchObject({ mark: 'todo', text: '' });
    expect(removeStep(steps, 0).map((s) => s.text)).toEqual(['跑基线', '写结果表']);
  });

  it('samePlan 忽略高亮和空行', () => {
    expect(samePlan(TEXT, '复现 GraphCL\n\n✓ 读论文\n✱ 跑基线\n○ 写结果表\n')).toBe(true);
    expect(samePlan(TEXT, '复现 GraphCL\n✓ 读论文')).toBe(false);
  });
});
