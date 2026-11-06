import { describe, expect, it } from 'vitest';
import { describeRoutineTarget, ROUTINE_TARGET_COORDINATOR, routineTargetOptions } from './lib';

const threads = [
  { id: 't1', title: '文献综述', resolved: false },
  { id: 't2', title: '旧实验', resolved: true },
  { id: 't3', title: '  ', resolved: false },
];

describe('routineTargetOptions', () => {
  it('第一项是协调者，只列出未解决的线程', () => {
    expect(routineTargetOptions(threads, ROUTINE_TARGET_COORDINATOR, false)).toEqual([
      { value: '', label: '协调者（默认）' },
      { value: 't1', label: '文献综述' },
      { value: 't3', label: '未命名线程' },
    ]);
  });

  it('编辑时保留原本指向的已解决线程', () => {
    const values = routineTargetOptions(threads, 't2', false).map((o) => o.label);
    expect(values).toContain('旧实验（已解决）');
  });

  it('列表里找不到原线程时仍保留这一项', () => {
    expect(routineTargetOptions(undefined, 'tx', true).at(-1)).toEqual({
      value: 'tx',
      label: '正在加载线程…',
    });
    expect(routineTargetOptions(threads, 'tx', false).at(-1)).toEqual({
      value: 'tx',
      label: '原来的线程（已找不到）',
    });
  });
});

describe('describeRoutineTarget', () => {
  it('协调者 / 线程标题 / 找不到时的兜底', () => {
    expect(describeRoutineTarget(null, threads)).toBe('唤醒：协调者');
    expect(describeRoutineTarget('t1', threads)).toBe('唤醒线程：文献综述');
    expect(describeRoutineTarget('tx', threads)).toBe('唤醒线程');
    expect(describeRoutineTarget('t1', undefined)).toBe('唤醒线程');
  });
});
