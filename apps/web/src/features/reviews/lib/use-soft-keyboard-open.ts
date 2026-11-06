import { useEffect, useState } from 'react';
import { opensSoftKeyboard } from '@/components/layout/mobile-tabbar';

/**
 * 软键盘是否弹起：和底部标签栏同一个判断（焦点在可输入的元素里）。
 * 标签栏这时会收起，页面自己的吸底操作栏也应该一起让位。
 */
export function useSoftKeyboardOpen(): boolean {
  const [open, setOpen] = useState(() =>
    typeof document === 'undefined' ? false : opensSoftKeyboard(document.activeElement),
  );
  useEffect(() => {
    const onIn = (e: FocusEvent) => setOpen(opensSoftKeyboard(e.target));
    // focusout 时 relatedTarget 是下一个拿到焦点的元素（没有就是失焦到 body）
    const onOut = (e: FocusEvent) => setOpen(opensSoftKeyboard(e.relatedTarget));
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return open;
}
