import { describe, expect, it } from 'vitest';
import { experimentLogPath, parseReportRef, reportRefPath } from './links';

describe('汇报正文里的站内引用', () => {
  it('认出 #tdo_ / #rev_ / #elg_，其他交给通用渲染', () => {
    expect(parseReportRef('#tdo_01ABC')).toEqual({ kind: 'todo', id: 'tdo_01ABC' });
    expect(parseReportRef('#rev_01ABC')).toEqual({ kind: 'review', id: 'rev_01ABC' });
    expect(parseReportRef('elg_01ABC')).toEqual({ kind: 'experimentLog', id: 'elg_01ABC' });
    expect(parseReportRef('#exp_01ABC')).toBeNull();
    expect(parseReportRef('#thr_01ABC')).toBeNull();
    expect(parseReportRef('https://example.com/#tdo_1')).toBeNull();
    expect(parseReportRef('#本周进展')).toBeNull();
    expect(parseReportRef(null)).toBeNull();
  });

  it('算出站内路由；旧日志直接进入移除说明', () => {
    expect(reportRefPath('p1', { kind: 'todo', id: 'tdo_1' })).toBe('/p/p1/todos?todo=tdo_1');
    expect(reportRefPath('p1', { kind: 'review', id: 'rev_1' })).toBe('/p/p1/reviews/rev_1');
    expect(reportRefPath('p1', { kind: 'experimentLog', id: 'elg_1' })).toBe('/p/p1/experiments');
    expect(experimentLogPath('p1', 'exp_1', 'elg_1')).toBe('/p/p1/experiments/exp_1?log=elg_1');
  });
});
