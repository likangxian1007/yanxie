/** 是否苹果平台（决定快捷键显示 ⌘ 还是 Ctrl）。 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** 主修饰键的显示文字 */
export function modKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}
