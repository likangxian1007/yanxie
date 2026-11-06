import type { ReactNode } from 'react';
import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** 毫秒，默认 4000；0 = 不自动消失 */
  duration?: number;
}

export interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastState {
  items: ToastItem[];
  push: (t: ToastOptions) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const MAX = 3;

export const useToastStore = create<ToastState>()((set) => ({
  items: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ items: [...s.items, { ...t, id }].slice(-MAX) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

/** 弹一条提示（右下角，最多同时 3 条，4s 后淡出，悬停暂停计时）。 */
export function toast(options: ToastOptions): number {
  return useToastStore.getState().push(options);
}
toast.success = (title: ReactNode, description?: ReactNode) =>
  toast({ title, description, tone: 'success' });
toast.error = (title: ReactNode, description?: ReactNode) =>
  toast({ title, description, tone: 'danger' });
toast.dismiss = (id: number) => useToastStore.getState().dismiss(id);
