import { useEffect, useRef } from 'react';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export interface ShortcutHandlers {
  /** ⌘K / Ctrl+K */
  onPalette: () => void;
  /** G 然后 T：回协作台 */
  onGoTimeline: () => void;
  /** G 然后 I：待我处理 */
  onGoInbox?: () => void;
  /** G 然后 W：我的工作区 */
  onGoWorkspace?: () => void;
}

/** 全局快捷键（STYLE §7）：⌘K 命令面板，G→T 协作台，G→I 收件箱，G→W 工作区。 */
export function useGlobalShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // 按住不放会连发 keydown，面板会开了又关
        if (e.repeat) return;
        ref.current.onPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const modalOpen = Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
        (el) => el.getClientRects().length > 0,
      );
      if (modalOpen) return;
      const key = e.key.toLowerCase();
      if (key === 'g') {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt > 1200) return;
      gAt = 0;
      if (key === 't') ref.current.onGoTimeline();
      else if (key === 'i') ref.current.onGoInbox?.();
      else if (key === 'w') ref.current.onGoWorkspace?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
