import { useRef, useState, type DragEvent } from 'react';

/** 拖进来的东西里有没有文件（拖文字、链接不响应） */
export function dragHasFiles(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * 把一块区域变成拖放上传区：返回要展开到容器上的事件处理和“正在拖入”状态。
 * 用计数器处理子元素之间的 dragenter / dragleave 抖动。
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const props = enabled
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          depth.current += 1;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (e: DragEvent) => {
          if (!dragHasFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) onFiles(files);
        },
      }
    : {};
  return { dragging, props };
}
