import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { TicketAttachment } from '@srh/shared';
import { Dialog } from '@/components/ui';
import { withBase } from '@/lib/base-path';
import { FEEDBACK_COPY } from '../copy';
import { tr } from '@/lib/i18n';

const c = FEEDBACK_COPY.detail;

/** 只放行反馈附件接口的地址，防止消息里混进外链被当成图片打开。 */
export function isFeedbackAttachmentUrl(url: string): boolean {
  return url.startsWith('/api/v1/feedback/');
}

/** 图片缩略图（点开大图）+ 日志下载链接。 */
export function AttachmentGallery({ items }: { items: TicketAttachment[] }) {
  const [open, setOpen] = useState<TicketAttachment | null>(null);
  const safe = items.filter((a) => isFeedbackAttachmentUrl(a.url));
  const images = safe.filter((a) => a.kind === 'image');
  const logs = safe.filter((a) => a.kind === 'log');
  if (safe.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                aria-label={tr('{label}：{name}', { label: c.openImage, name: a.name })}
                onClick={() => setOpen(a)}
                className="block size-20 cursor-zoom-in overflow-hidden rounded-md border border-line bg-subtle"
              >
                <img
                  src={withBase(a.url)}
                  alt={c.imageAlt(a.name)}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {logs.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {logs.map((a) => (
            <li key={a.id}>
              <a
                href={withBase(a.url)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line px-2 text-caption text-fg-muted hover:bg-subtle max-md:h-11"
              >
                <FileText size={14} strokeWidth={1.75} aria-hidden />
                {a.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open?.name ?? ''}
        size="lg"
      >
        {open && (
          <img
            src={withBase(open.url)}
            alt={c.imageAlt(open.name)}
            className="mx-auto max-h-[70dvh] w-auto rounded-md object-contain"
          />
        )}
      </Dialog>
    </div>
  );
}
