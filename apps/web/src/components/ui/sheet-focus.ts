/**
 * 浮层关闭后焦点该还给谁。
 *
 * 一般是打开前的焦点元素。但手机 Safari、桌面 Safari 点按钮不会让按钮获得焦点，
 * 打开时 activeElement 是 body，关闭后焦点就丢了（读屏和键盘用户找不到刚才的位置）。
 * 这时退回到「声明自己打开了对话框、且当前是展开状态」的触发按钮：
 * `aria-haspopup="dialog"` + `aria-expanded="true"`。
 */
export function focusReturnTarget(
  active: Element | null,
  panel: HTMLElement | null,
): HTMLElement | null {
  const usable = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement &&
    el !== document.body &&
    el !== document.documentElement &&
    !(panel && panel.contains(el));
  if (usable(active)) return active;
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-haspopup="dialog"][aria-expanded="true"]'),
  ).filter((el) => usable(el));
  return triggers.at(-1) ?? null;
}

/** 关闭时还原焦点：目标还在页面上才还。 */
export function restoreFocusTo(target: HTMLElement | null): void {
  if (target?.isConnected) target.focus({ preventScroll: true });
}
