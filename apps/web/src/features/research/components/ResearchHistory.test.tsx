import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ResearchRecordDetail } from '@srh/shared';
import { ResearchHistory } from './ResearchHistory';

it('历史内容只读，保留字段名称、原单位、停用字段、报告者和未核验状态', () => {
  const detail = {
    record: {
      version: 3,
      fieldValues: { length: { value: 20, unit: 'mm' }, retired_field: '原始观察' },
      resources: [{ kind: 'file', id: 'samples.csv' }],
      stepState: { observe: true },
      stepReports: {
        observe: {
          reportedBy: { name: '分析助手' },
          origin: 'agent_work',
          verification: 'unverified',
        },
      },
    },
    template: {
      name: '旧实验模板',
      fields: [{ id: 'length', label: '样品长度' }],
      steps: [{ id: 'observe', title: '观察样品' }],
    },
    logs: [
      {
        id: 'log_1',
        body: '人工记录的原始偏差',
        createdBy: { name: '研究者' },
        createdAt: '2026-10-28T00:00:00Z',
      },
    ],
    sources: [],
  } as unknown as ResearchRecordDetail;
  const before = JSON.stringify(detail);
  render(<ResearchHistory detail={detail} />);
  expect(screen.getByText('样品长度')).toBeTruthy();
  expect(screen.getByText('20 mm')).toBeTruthy();
  expect(screen.getByText('retired_field')).toBeTruthy();
  expect(screen.getByText('原始观察')).toBeTruthy();
  expect(screen.getByText('file: samples.csv')).toBeTruthy();
  expect(screen.getByText('分析助手 · AI 工作 · 未核验')).toBeTruthy();
  expect(screen.getByText('人工记录的原始偏差')).toBeTruthy();
  expect(screen.queryByText('旧实验模板')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(JSON.stringify(detail)).toBe(before);
});

it('空白研究没有旧流程引导', () => {
  render(
    <ResearchHistory
      detail={
        {
          record: { version: 1, fieldValues: {}, resources: [], stepState: {}, stepReports: {} },
          template: { fields: [], steps: [] },
          logs: [],
        } as unknown as ResearchRecordDetail
      }
    />,
  );
  expect(screen.getByText('暂无早期内容。')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
});
