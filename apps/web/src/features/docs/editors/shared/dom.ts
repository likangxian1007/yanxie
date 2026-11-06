import { useEffect, useState } from 'react';
import { tr } from '@/lib/i18n';

/** 下载文本文件（CSV、Markdown）。csv 默认加 BOM，Excel 打开中文不乱码。 */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const bom = mime.startsWith('text/csv') ? '\uFEFF' : '';
  downloadBlob(filename, new Blob([bom + text], { type: `${mime};charset=utf-8` }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名里去掉 Windows/macOS 不允许的字符。 */
export function safeFileName(name: string, fallback = tr('未命名')): string {
  const cleaned = name.replace(/[\\/:*?"<>|\n\r\t]+/gu, ' ').trim();
  return cleaned.slice(0, 120) || fallback;
}

/** 复制文本到剪贴板，失败时返回 false。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * 观察元素尺寸：`const [ref, size] = useElementSize<HTMLDivElement>()`，把 ref 挂在元素上。
 */
export function useElementSize<T extends HTMLElement>(): [(el: T | null) => void, ElementSize] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) =>
        Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5
          ? s
          : { width: r.width, height: r.height },
      );
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const raf = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [el]);
  return [setEl, size];
}

/**
 * 写 awareness 字段（表格 `cell`、幻灯片 `slide`）。连接已销毁（卸载顺序里 provider 先于编辑器清理）
 * 时 Hocuspocus 会抛错，这里吞掉。
 */
export function setAwareness(
  provider: { setAwarenessField: (key: string, value: unknown) => void },
  key: string,
  value: unknown,
): void {
  try {
    provider.setAwarenessField(key, value);
  } catch {
    // provider 已销毁：忽略
  }
}

/** 是否为 macOS（快捷键文案用 ⌘ 还是 Ctrl）。 */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);
}

/** 生成短 id（幻灯片 id 等）。 */
export function shortId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/gu, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}${raw.slice(0, 12)}`;
}
