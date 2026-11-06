import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from '@/lib/theme';
import { AppearanceSettings } from './AppearanceSettings';

beforeEach(() => useThemeStore.getState().reset());
describe('外观设置', () => {
  it('原生单选保持各自分组（配色、材质、明暗、界面语言），并独立保存三种偏好', () => {
    render(<AppearanceSettings />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(10);
    expect(radios.every((node) => node.tagName === 'INPUT')).toBe(true);
    expect(screen.getByRole('radio', { name: '复旦蓝' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '玻璃' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '石墨灰' }));
    fireEvent.click(screen.getByRole('radio', { name: '实底' }));
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(useThemeStore.getState()).toMatchObject({
      palette: 'graphite',
      material: 'solid',
      preference: 'dark',
    });
    expect(screen.getByRole('radio', { name: '石墨灰' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '实底' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked();
    expect(window.localStorage.getItem('srh-palette')).toBe('graphite');
    expect(window.localStorage.getItem('srh-material')).toBe('solid');
    expect(window.localStorage.getItem('srh-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '重置默认' }));
    expect(useThemeStore.getState()).toMatchObject({
      palette: 'fudan',
      material: 'glass',
      preference: 'system',
    });
  });
});
