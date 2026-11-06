import { create } from 'zustand';
import { tr } from '@/lib/i18n';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ThemePalette = 'fudan' | 'graphite' | 'paper';
export type ThemeMaterial = 'glass' | 'solid';
export const THEME_STORAGE_KEY = 'srh-theme';
export const PALETTE_STORAGE_KEY = 'srh-palette';
export const MATERIAL_STORAGE_KEY = 'srh-material';
export const THEME_LABEL: Record<ThemePreference, string> = {
  light: tr('浅色'),
  dark: tr('深色'),
  system: tr('跟随系统'),
};
export const PALETTE_LABEL: Record<ThemePalette, string> = {
  fudan: tr('复旦蓝'),
  graphite: tr('石墨灰'),
  paper: tr('暖纸棕'),
};
export const MATERIAL_LABEL: Record<ThemeMaterial, string> = {
  glass: tr('玻璃'),
  solid: tr('实底'),
};
const NEXT: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};
const DARK_QUERY = '(prefers-color-scheme: dark)';
const isPreference = (v: unknown): v is ThemePreference =>
  v === 'light' || v === 'dark' || v === 'system';
const isPalette = (v: unknown): v is ThemePalette =>
  v === 'fudan' || v === 'graphite' || v === 'paper';
const isMaterial = (v: unknown): v is ThemeMaterial => v === 'glass' || v === 'solid';
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 内存切换仍然有效 */
  }
}
function savedAppearance() {
  const preference = read(THEME_STORAGE_KEY);
  const palette = read(PALETTE_STORAGE_KEY);
  const material = read(MATERIAL_STORAGE_KEY);
  return {
    preference: isPreference(preference) ? preference : ('system' as const),
    palette: isPalette(palette) ? palette : ('fudan' as const),
    material: isMaterial(material) ? material : ('glass' as const),
  };
}
function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system'
    ? typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches
      ? 'dark'
      : 'light'
    : preference;
}
const TRANSITION_MS = 180;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
interface Appearance {
  resolved: ResolvedTheme;
  palette: ThemePalette;
  material: ThemeMaterial;
}
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
let activeTransition: Pick<ViewTransition, 'skipTransition'> | undefined;
let appearanceRevision = 0;

function stopTransition() {
  clearTimeout(transitionTimer);
  transitionTimer = undefined;
  const previous = activeTransition;
  activeTransition = undefined;
  // skipTransition 仍会执行尚未开始的 update callback，由 revision 防止旧值回写。
  previous?.skipTransition();
  document.documentElement.classList.remove('theme-transition', 'theme-view-transition');
}
function writeAppearance(appearance: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = appearance.resolved;
  root.dataset.palette = appearance.palette;
  root.dataset.material = appearance.material;
}
function apply(appearance: Appearance, animate: boolean) {
  if (typeof document === 'undefined') return;
  const revision = ++appearanceRevision;
  stopTransition();
  const root = document.documentElement;
  const changed =
    root.dataset.theme !== appearance.resolved ||
    root.dataset.palette !== appearance.palette ||
    root.dataset.material !== appearance.material;
  if (
    !changed ||
    !animate ||
    document.visibilityState === 'hidden' ||
    window.matchMedia?.(REDUCED_MOTION_QUERY).matches
  ) {
    writeAppearance(appearance);
    return;
  }
  if (typeof document.startViewTransition === 'function') {
    root.classList.add('theme-view-transition');
    try {
      const transition = document.startViewTransition(() => {
        if (revision === appearanceRevision) writeAppearance(appearance);
      });
      activeTransition = transition;
      const finish = () => {
        if (revision !== appearanceRevision) return;
        // 捕获失败、后台跳过等情况也必须落到最终外观。
        writeAppearance(appearance);
        if (activeTransition === transition) {
          activeTransition = undefined;
          root.classList.remove('theme-view-transition');
        }
      };
      void transition.ready.catch(() => {});
      void transition.updateCallbackDone.catch(finish);
      void transition.finished.then(finish, finish);
      return;
    } catch {
      root.classList.remove('theme-view-transition');
    }
  }
  root.classList.add('theme-transition');
  transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), TRANSITION_MS);
  writeAppearance(appearance);
}
interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  palette: ThemePalette;
  material: ThemeMaterial;
  setPreference: (value: ThemePreference) => void;
  setPalette: (value: ThemePalette) => void;
  setMaterial: (value: ThemeMaterial) => void;
  reset: () => void;
  cycle: () => void;
}
const initial = savedAppearance();
export const useThemeStore = create<ThemeState>()((set, get) => ({
  ...initial,
  resolved: resolve(initial.preference),
  setPreference: (value) => {
    const preference = isPreference(value) ? value : 'system';
    const resolved = resolve(preference);
    write(THEME_STORAGE_KEY, preference);
    apply({ ...get(), resolved }, true);
    set({ preference, resolved });
  },
  setPalette: (value) => {
    const palette = isPalette(value) ? value : 'fudan';
    write(PALETTE_STORAGE_KEY, palette);
    apply({ ...get(), palette }, true);
    set({ palette });
  },
  setMaterial: (value) => {
    const material = isMaterial(value) ? value : 'glass';
    write(MATERIAL_STORAGE_KEY, material);
    apply({ ...get(), material }, true);
    set({ material });
  },
  reset: () => {
    const appearance = {
      preference: 'system' as const,
      resolved: resolve('system'),
      palette: 'fudan' as const,
      material: 'glass' as const,
    };
    write(THEME_STORAGE_KEY, appearance.preference);
    write(PALETTE_STORAGE_KEY, appearance.palette);
    write(MATERIAL_STORAGE_KEY, appearance.material);
    apply(appearance, true);
    set(appearance);
  },
  cycle: () => get().setPreference(NEXT[get().preference]),
}));

/** 一次初始化，返回完整清理函数；存储被禁用时不覆盖当前内存偏好。 */
export function initTheme(): () => void {
  if (typeof window === 'undefined') return () => {};
  const state = useThemeStore.getState();
  const resolved = resolve(state.preference);
  apply({ ...state, resolved }, false);
  useThemeStore.setState({ resolved });
  const mql = window.matchMedia?.(DARK_QUERY);
  const motionQuery = window.matchMedia?.(REDUCED_MOTION_QUERY);
  const systemChanged = () => {
    const current = useThemeStore.getState();
    if (current.preference !== 'system') return;
    const next = resolve(current.preference);
    apply({ ...current, resolved: next }, true);
    useThemeStore.setState({ resolved: next });
  };
  const storageChanged = (event: StorageEvent) => {
    if (
      event.key !== null &&
      ![THEME_STORAGE_KEY, PALETTE_STORAGE_KEY, MATERIAL_STORAGE_KEY].includes(event.key)
    )
      return;
    // 使用事件的新值，remove/clear 恢复该维度的默认值。
    const current = useThemeStore.getState();
    const next = {
      preference:
        event.key === null || event.key === THEME_STORAGE_KEY
          ? isPreference(event.newValue)
            ? event.newValue
            : ('system' as const)
          : current.preference,
      palette:
        event.key === null || event.key === PALETTE_STORAGE_KEY
          ? isPalette(event.newValue)
            ? event.newValue
            : ('fudan' as const)
          : current.palette,
      material:
        event.key === null || event.key === MATERIAL_STORAGE_KEY
          ? isMaterial(event.newValue)
            ? event.newValue
            : ('glass' as const)
          : current.material,
    };
    const appearance = { ...next, resolved: resolve(next.preference) };
    apply(appearance, true);
    useThemeStore.setState(appearance);
  };
  const motionChanged = () => {
    if (document.visibilityState === 'hidden' || motionQuery?.matches)
      apply(useThemeStore.getState(), false);
  };
  mql?.addEventListener?.('change', systemChanged);
  motionQuery?.addEventListener?.('change', motionChanged);
  document.addEventListener('visibilitychange', motionChanged);
  window.addEventListener('storage', storageChanged);
  return () => {
    mql?.removeEventListener?.('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
    motionQuery?.removeEventListener?.('change', motionChanged);
    document.removeEventListener('visibilitychange', motionChanged);
    apply(useThemeStore.getState(), false);
  };
}
