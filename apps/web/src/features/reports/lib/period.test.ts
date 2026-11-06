import { describe, expect, it } from 'vitest';
import {
  defaultReportTitle,
  formatPeriod,
  parseYmd,
  presetRange,
  rangeDays,
  toYmd,
  validateRange,
} from './period';

// 2026-10-26 是周一；2026-10-28 是周三；2026-11-01 是周日
const MON = new Date(2026, 9, 26, 18, 30);
const WED = new Date(2026, 9, 28, 9, 0);
const SUN = new Date(2026, 10, 1, 23, 0);

describe('presetRange', () => {
  it('本周：周一到今天', () => {
    expect(presetRange('this_week', WED)).toEqual({ start: '2026-10-26', end: '2026-10-28' });
    expect(presetRange('this_week', MON)).toEqual({ start: '2026-10-26', end: '2026-10-26' });
    // 周日仍属于周一开始的这一周
    expect(presetRange('this_week', SUN)).toEqual({ start: '2026-10-26', end: '2026-11-01' });
  });

  it('上周：上周一到上周日', () => {
    expect(presetRange('last_week', WED)).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(presetRange('last_week', SUN)).toEqual({ start: '2026-10-19', end: '2026-10-25' });
  });

  it('最近两周：含今天共 14 天', () => {
    const r = presetRange('two_weeks', WED);
    expect(r).toEqual({ start: '2026-10-15', end: '2026-10-28' });
    expect(rangeDays(r)).toBe(14);
  });

  it('本月：1 号到今天，跨月正确', () => {
    expect(presetRange('this_month', WED)).toEqual({ start: '2026-10-01', end: '2026-10-28' });
    expect(presetRange('this_month', SUN)).toEqual({ start: '2026-11-01', end: '2026-11-01' });
  });

  it('跨年的上周', () => {
    // 2027-01-01 是周五
    expect(presetRange('last_week', new Date(2027, 0, 1))).toEqual({
      start: '2026-12-21',
      end: '2026-12-27',
    });
  });
});

describe('日期工具', () => {
  it('toYmd / parseYmd 往返', () => {
    expect(toYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(parseYmd('2026-02-30')).toBeNull();
    expect(parseYmd('2026/02/01')).toBeNull();
    expect(toYmd(parseYmd('2026-12-31') as Date)).toBe('2026-12-31');
  });

  it('validateRange', () => {
    expect(validateRange({ start: '', end: '2026-10-26' })).toBe('请选择开始和结束日期');
    expect(validateRange({ start: '2026-10-27', end: '2026-10-26' })).toBe(
      '结束日期不能早于开始日期',
    );
    expect(validateRange({ start: '2024-01-01', end: '2026-01-01' })).toBe('时间段最长一年');
    expect(validateRange({ start: '2026-10-20', end: '2026-10-26' })).toBeNull();
  });

  it('默认标题与服务端一致', () => {
    expect(defaultReportTitle({ start: '2026-10-20', end: '2026-10-26' })).toBe(
      '组会汇报 · 10月20日–10月26日',
    );
    expect(defaultReportTitle({ start: '', end: '' })).toBe('组会汇报');
  });

  it('formatPeriod：今年省略年份，跨年带年份，同一天只显示一次', () => {
    expect(formatPeriod('2026-10-20', '2026-10-26', WED)).toBe('10月20日 – 10月26日');
    expect(formatPeriod('2026-12-28', '2027-01-03', WED)).toBe('2026年12月28日 – 2027年1月3日');
    expect(formatPeriod('2026-10-26', '2026-10-26', WED)).toBe('10月26日');
    expect(formatPeriod('bad', '2026-10-26', WED)).toBe('');
  });
});
