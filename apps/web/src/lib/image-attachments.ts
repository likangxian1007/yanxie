import type { OutputRef } from '@srh/shared';
import { resolveApiUrl } from './api';

/**
 * 可以直接用 <img> 预览的图片扩展名。与服务端 files 模块的内联白名单一致
 * （png / jpeg / gif / webp 以 inline + nosniff 返回）。SVG 不在其中：服务端把它按附件下载、
 * 带 CSP sandbox，也不该在站内渲染（可能带脚本）。服务端按扩展名推断 mime，所以扩展名可靠。
 */
const PREVIEWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isPreviewableImage(name: string | null | undefined): boolean {
  if (!name) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return PREVIEWABLE.has(name.slice(dot + 1).toLowerCase());
}

/** 内联读取文件字节（同源 + 会话 cookie），用于 <img src>。 */
export function fileInlineUrl(projectId: string, fileId: string): string {
  return resolveApiUrl(`/projects/${projectId}/files/${encodeURIComponent(fileId)}`);
}

/** 以附件下载原文件。 */
export function fileAttachmentUrl(projectId: string, fileId: string): string {
  return resolveApiUrl(`/projects/${projectId}/files/${encodeURIComponent(fileId)}`, {
    download: 1,
  });
}

/** 消息产出拆成图片附件（显示缩略图）与其余产出（保持原来的小标签）。 */
export function splitImageOutputs(outputs: readonly OutputRef[]): {
  images: OutputRef[];
  others: OutputRef[];
} {
  const images: OutputRef[] = [];
  const others: OutputRef[] = [];
  for (const output of outputs) {
    if (output.kind === 'file' && isPreviewableImage(output.title)) images.push(output);
    else others.push(output);
  }
  return { images, others };
}
