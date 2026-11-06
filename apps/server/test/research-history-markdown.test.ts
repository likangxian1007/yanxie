import { expect, it } from 'vitest';
import type { ResearchRecordDetail } from '@srh/shared';
import { researchHistoryMarkdown } from '../src/modules/research/history-markdown';

it('历史附录保留原单位、已移除字段、步骤报告和日志，不生成未填的模板步骤', () => {
  const detail = {
    record: {
      fieldValues: { length: { value: 20, unit: 'mm' }, removed: '原始观察' },
      stepState: { observed: true },
      stepReports: {
        observed: {
          reportedBy: { kind: 'agent', name: '助手' },
          origin: 'agent_work',
          verification: 'unverified',
        },
      },
    },
    template: {
      id: 'tpl_old',
      name: '早期方法',
      version: 1,
      fields: [{ id: 'length', label: '长度' }],
      steps: [
        { id: 'observed', title: '观察' },
        { id: 'not-started', title: '未使用的默认步骤' },
      ],
    },
    logs: [{ createdAt: '2026-10-28', createdBy: { name: '研究者' }, body: '原始过程' }],
  } as unknown as ResearchRecordDetail;
  const before = JSON.stringify(detail);
  const result = researchHistoryMarkdown(detail);
  expect(result).toContain('长度 [length]：20 mm');
  expect(result).toContain('removed [removed]：原始观察');
  expect(result).toContain('观察：报告完成；agent:助手；agent_work；unverified');
  expect(result).toContain('研究者');
  expect(result).toContain('原始过程');
  expect(result).not.toContain('未使用的默认步骤');
  expect(JSON.stringify(detail)).toBe(before);
});

it('空白研究不输出模板名称、字段和默认步骤', () => {
  expect(
    researchHistoryMarkdown({
      record: { fieldValues: {}, stepState: {} },
      template: { name: '通用模板', steps: [{ id: 'default', title: '模板步骤' }] },
      logs: [],
    } as unknown as ResearchRecordDetail),
  ).toBe('');
});
