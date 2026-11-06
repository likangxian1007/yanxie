import { create } from 'zustand';

/**
 * 外壳布局状态：侧栏收起（持久化 localStorage['srh-sidebar']）、移动端抽屉、右侧面板。
 */

export const SIDEBAR_STORAGE_KEY = 'srh-sidebar';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // 忽略
  }
}

/** 专业工作区拥有自己的面板；全局面板在这些路由上始终互斥。 */
export function isProfessionalWorkspace(pathname: string): boolean {
  return /\/p\/[^/]+\/(?:docs|library|notebooks|reviews|reports|research)\/[^/]+/.test(pathname);
}

interface LayoutState {
  sidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  rightPanelOpen: boolean;
  paletteOpen: boolean;
  panelTab: 'threads' | 'activity';
  setPanelTab: (tab: 'threads' | 'activity') => void;
  setPaletteOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setMobileNavOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  sidebarCollapsed: typeof window === 'undefined' ? false : readCollapsed(),
  mobileNavOpen: false,
  rightPanelOpen: false,
  panelTab: 'threads',
  setPanelTab: (panelTab) => set({ panelTab }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    writeCollapsed(next);
    set({ sidebarCollapsed: next });
  },
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  toggleRightPanel: () => set({ rightPanelOpen: !get().rightPanelOpen }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
}));
