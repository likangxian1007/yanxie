import { describe, expect, it } from 'vitest';
import { autoTextColor, cssOfStyle } from './style';

describe('cssOfStyle：有底色没设字色', () => {
  it('浅底配深字、深底配白字，不跟界面主题（深色模式下浅底格子也看得清）', () => {
    expect(cssOfStyle({ bg: '#DDEBF7' }, 'ViT-B/16').color).toBe('#1f1f1f');
    expect(cssOfStyle({ bg: '#FFF2CC' }, 1).color).toBe('#1f1f1f');
    expect(cssOfStyle({ bg: '#1F4E79' }, 'x').color).toBe('#ffffff');
    expect(autoTextColor('#000')).toBe('#ffffff');
    expect(autoTextColor('not-a-color')).toBe('#1f1f1f');
  });

  it('显式字色、数字格式颜色优先；没有底色时不设字色（跟主题）', () => {
    expect(cssOfStyle({ bg: '#2E75B6', fc: '#FFFFFF' }, '模型').color).toBe('#FFFFFF');
    expect(cssOfStyle({ bg: '#DDEBF7' }, -1, '#ff0000').color).toBe('#ff0000');
    expect(cssOfStyle({ b: true }, 'x').color).toBeUndefined();
    expect(cssOfStyle(undefined, 'x').color).toBeUndefined();
  });
});
