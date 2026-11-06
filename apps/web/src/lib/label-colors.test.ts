import { describe, expect, it } from 'vitest';
import { labelColor, labelColorIndex, UNLABELED_COLOR } from './label-colors';
import { paletteFromString } from './palette';

describe('labelColor', () => {
  it('与 Badge / LabelFilter 同一映射，且稳定', () => {
    expect(labelColorIndex('文献')).toBe(paletteFromString('文献'));
    expect(labelColor('文献')).toEqual(labelColor('文献'));
    const c = labelColor('实验');
    expect(c.dot).toBe(`bg-palette-${paletteFromString('实验')}`);
    expect(c.borderTop).toBe(`border-t-palette-${paletteFromString('实验')}`);
  });

  it('空标签是中性色', () => {
    expect(labelColor(null)).toBe(UNLABELED_COLOR);
    expect(labelColor('   ')).toBe(UNLABELED_COLOR);
    expect(labelColorIndex('')).toBeNull();
  });
});
