import { describe, expect, it } from 'vitest';
import { cn } from './cn';
import { initials, paletteFromString, paletteIndex, paletteSoft, paletteVar } from './palette';

describe('palette', () => {
  it('规整色号并生成 CSS 变量', () => {
    expect(paletteIndex(9)).toBe(1);
    expect(paletteIndex(-1)).toBe(7);
    expect(paletteIndex(Number.NaN)).toBe(0);
    expect(paletteVar(3)).toBe('var(--palette-3)');
    expect(paletteSoft(6)).toBe('color-mix(in oklab, var(--palette-6) 14%, transparent)');
  });

  it('头像首字：中文取最后一个字，英文取首字母', () => {
    expect(initials('张三')).toBe('三');
    expect(initials('欧阳娜娜')).toBe('娜');
    expect(initials('alice wang')).toBe('A');
    expect(initials('  ')).toBe('?');
  });

  it('按字符串取色：稳定、在 0–7 之间，常用科研标签互不撞色', () => {
    for (const s of ['', 'a', '实验', 'usr_01M5WBX6X23SNPN3EVK1YZHKGP']) {
      const n = paletteFromString(s);
      expect(n).toBe(paletteFromString(s));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(8);
    }
    const labels = ['实验', '数据', '汇报', '文献', '写作'];
    expect(new Set(labels.map(paletteFromString)).size).toBe(labels.length);
  });
});

describe('cn', () => {
  it('认识自定义字号，不和文字颜色互相覆盖', () => {
    expect(cn('text-h1 text-fg', 'text-fg-muted')).toBe('text-h1 text-fg-muted');
    expect(cn('text-body', 'text-small')).toBe('text-small');
    expect(cn('shadow-sm', 'shadow-glow')).toBe('shadow-glow');
  });
});
