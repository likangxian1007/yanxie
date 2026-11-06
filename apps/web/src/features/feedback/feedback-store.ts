import { create } from 'zustand';

interface FeedbackDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** 全局的「提交反馈」对话框开关：顶栏、账号菜单、帮助页、Alt+B 都调它。 */
export const useFeedbackDialog = create<FeedbackDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openFeedbackDialog() {
  useFeedbackDialog.getState().setOpen(true);
}
