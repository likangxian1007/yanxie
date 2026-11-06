import { X } from 'lucide-react';
import type { PickedImage } from '../image-files';
import { FEEDBACK_COPY } from '../copy';
import { tr } from '@/lib/i18n';

/** 待上传截图的缩略图行，每张右上角可删除（手机上删除按钮常显，不靠 hover）。 */
export function ImageThumbs({
  images,
  onRemove,
}: {
  images: PickedImage[];
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={FEEDBACK_COPY.dialog.shots}>
      {images.map((img) => (
        <li
          key={img.id}
          className="relative size-16 overflow-hidden rounded-md border border-line bg-subtle"
        >
          <img src={img.url} alt={img.file.name} className="size-full object-cover" />
          <button
            type="button"
            aria-label={tr('{label}：{name}', {
              label: FEEDBACK_COPY.dialog.removeShot,
              name: img.file.name,
            })}
            onClick={() => onRemove(img.id)}
            className="press absolute top-0.5 right-0.5 grid size-6 cursor-pointer place-items-center rounded-full bg-overlay text-accent-fg"
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
