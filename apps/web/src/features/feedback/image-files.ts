import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_IMAGE_MIMES,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
} from '@srh/shared';
import { toast } from '@/components/ui/toast-store';
import { FEEDBACK_COPY } from './copy';
import { tr } from '@/lib/i18n';

export interface PickedImage {
  id: string;
  file: File;
  url: string;
}

const MIMES: readonly string[] = FEEDBACK_IMAGE_MIMES;

/** 校验并截断到上限；返回被接受的文件与第一条拒绝原因。 */
export function acceptImages(
  incoming: File[],
  existing: number,
  max = FEEDBACK_MAX_ATTACHMENTS,
): { accepted: File[]; error: string | null } {
  const c = FEEDBACK_COPY.dialog;
  const accepted: File[] = [];
  let error: string | null = null;
  for (const f of incoming) {
    if (!MIMES.includes(f.type)) {
      error ??= c.badType;
      continue;
    }
    if (f.size > FEEDBACK_MAX_ATTACHMENT_BYTES) {
      error ??= c.tooLarge;
      continue;
    }
    if (existing + accepted.length >= max) {
      error ??= c.tooMany(max);
      break;
    }
    accepted.push(f);
  }
  return { accepted, error };
}

/** 从剪贴板事件里取图片（截图粘贴时文件名常为 image.png，补一个时间戳名）。 */
export function imagesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const f = item.getAsFile();
    if (!f) continue;
    const ext = f.type.split('/')[1] ?? 'png';
    out.push(
      f.name && f.name !== 'image.png'
        ? f
        : new File([f], `${tr('截图')}-${Date.now()}-${out.length + 1}.${ext}`, { type: f.type }),
    );
  }
  return out;
}

let seq = 0;

/** 截图列表：object URL 在删除与卸载时释放。 */
export function useImageList(max = FEEDBACK_MAX_ATTACHMENTS) {
  const [images, setImages] = useState<PickedImage[]>([]);
  const ref = useRef(images);
  useEffect(() => {
    ref.current = images;
  }, [images]);

  useEffect(() => () => ref.current.forEach((i) => URL.revokeObjectURL(i.url)), []);

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { accepted, error } = acceptImages(files, ref.current.length, max);
      if (error) toast({ title: error, tone: 'warning' });
      if (accepted.length === 0) return;
      setImages((prev) => [
        ...prev,
        ...accepted.map((file) => ({
          id: `img-${++seq}`,
          file,
          url: URL.createObjectURL(file),
        })),
      ]);
    },
    [max],
  );

  const remove = useCallback((id: string) => {
    setImages((prev) => {
      const hit = prev.find((i) => i.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setImages((prev) => {
      prev.forEach((i) => URL.revokeObjectURL(i.url));
      return [];
    });
  }, []);

  return { images, add, remove, clear, full: images.length >= max };
}
