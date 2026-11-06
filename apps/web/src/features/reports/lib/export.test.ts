import { describe, expect, it } from 'vitest';
import { reportFileName, reportMarkdown, statsSummary } from './export';

const PERIOD = {
  periodStart: '2026-10-19T16:00:00.000Z',
  periodEnd: '2026-10-26T15:59:59.999Z',
};

describe('reportFileName', () => {
  it('用标题，去掉文件名非法字符', () => {
    expect(reportFileName({ title: '组会汇报 · 10月20日–10月26日', ...PERIOD })).toBe(
      '组会汇报 · 10月20日–10月26日.md',
    );
    expect(reportFileName({ title: 'A/B 测试: "v2" <final>?', ...PERIOD })).toBe(
      'A B 测试 v2 final.md',
    );
    expect(reportFileName({ title: '  ..周报..  ', ...PERIOD })).toBe('周报.md');
  });

  it('标题为空时用期间', () => {
    const name = reportFileName({ title: '  ', ...PERIOD });
    expect(name).toMatch(/^组会汇报-\d{4}-\d{2}-\d{2}至\d{4}-\d{2}-\d{2}\.md$/u);
    expect(reportFileName({ title: '', periodStart: 'x', periodEnd: 'y' })).toBe('组会汇报.md');
  });

  it('过长标题截断到 80 字', () => {
    expect(reportFileName({ title: '汇'.repeat(200), ...PERIOD })).toBe(`${'汇'.repeat(80)}.md`);
  });
});

describe('reportMarkdown', () => {
  it('正文没有一级标题时补上标题与期间', () => {
    const md = reportMarkdown({ title: '第 8 周', content: '## 进展\n- a', ...PERIOD });
    expect(md.startsWith('# 第 8 周\n\n> ')).toBe(true);
    expect(md.endsWith('## 进展\n- a\n')).toBe(true);
  });
  it('已有一级标题则原样导出', () => {
    expect(reportMarkdown({ title: 'x', content: '# 自带标题\n\n正文', ...PERIOD })).toBe(
      '# 自带标题\n\n正文\n',
    );
  });
});

describe('statsSummary', () => {
  it('只列出非零项', () => {
    expect(
      statsSummary({
        threads: 12,
        messages: 80,
        experiments: 5,
        reviews: 3,
        todos: 0,
        documents: 0,
      }),
    ).toBe('整理了 12 个线程 · 5 个实验 · 3 个审阅');
  });
  it('都为零 / 无统计', () => {
    expect(
      statsSummary({ threads: 0, messages: 0, experiments: 0, reviews: 0, todos: 0, documents: 0 }),
    ).toBe('这一期没有找到可整理的上下文');
    expect(
      statsSummary({ threads: 0, messages: 7, experiments: 0, reviews: 0, todos: 0, documents: 0 }),
    ).toBe('整理了 7 条讨论');
    expect(statsSummary(null)).toBeNull();
  });
});
