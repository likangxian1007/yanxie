import { useState, type ReactNode } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import type { OutputRef } from '@srh/shared';
import { Dialog, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { fileAttachmentUrl, fileInlineUrl } from '@/lib/image-attachments';
import { tr } from '@/lib/i18n';

/**
 * 缩略图的框尺寸是固定的（不依赖图片加载后的真实尺寸），所以图片晚到不会改变消息高度，
 * 不会把吸底的消息流顶歪；加载失败换回小标签时高度变小，由 MessageFeed 的 ResizeObserver 重新贴底。
 */
const SINGLE_BOX = 'h-[180px] w-[240px] max-sm:h-[135px] max-sm:w-[180px]';
const GRID_TILE = 'size-[120px] max-sm:size-[96px]';

function Thumb({
  src,
  name,
  className,
  onOpen,
  onError,
}: {
  src: string;
  name: string;
  className: string;
  onOpen: () => void;
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      aria-label={tr('查看图片 {name}', { name })}
      title={name}
      onClick={onOpen}
      className={cn(
        'press group/thumb relative block max-w-full shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-line bg-subtle shadow-xs transition-colors duration-(--dur-fast) hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    >
      {!loaded && <Skeleton className="absolute inset-0 size-full rounded-none" />}
      <img
        src={src}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        data-loaded={loaded || undefined}
        onLoad={() => setLoaded(true)}
        onError={onError}
        className="relative size-full object-cover opacity-0 transition-[opacity,scale] duration-(--dur-base) ease-out data-loaded:opacity-100 motion-safe:group-hover/thumb:scale-[1.02] motion-reduce:transition-none"
      />
    </button>
  );
}

function Lightbox({
  projectId,
  image,
  onClose,
}: {
  projectId: string;
  image: OutputRef | null;
  onClose: () => void;
}) {
  // 关闭时 AnimatePresence 保留上一帧的面板播退出动画，内容不会先消失
  const shown = image;
  return (
    <Dialog
      open={image !== null}
      onOpenChange={(open) => !open && onClose()}
      title={<span className="block truncate">{shown?.title ?? tr('图片')}</span>}
      size="lg"
      footer={
        shown && (
          <>
            <a
              href={fileInlineUrl(projectId, shown.ref)}
              target="_blank"
              rel="noreferrer noopener"
              className="press inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-body font-medium text-fg-muted hover:bg-subtle hover:text-fg max-md:h-11"
            >
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
              {tr('打开原图')}
            </a>
            <a
              href={fileAttachmentUrl(projectId, shown.ref)}
              download={shown.title}
              className="press inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-body font-medium text-fg shadow-xs hover:bg-subtle max-md:h-11"
            >
              <Download size={16} strokeWidth={1.75} aria-hidden />
              {tr('下载')}
            </a>
          </>
        )
      }
    >
      {shown && <LightboxImage key={shown.ref} projectId={projectId} image={shown} />}
    </Dialog>
  );
}

function LightboxImage({ projectId, image }: { projectId: string; image: OutputRef }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  if (state === 'error') {
    return (
      <p className="rounded-lg bg-subtle px-4 py-10 text-center text-small text-fg-muted">
        {tr('图片没能加载出来，可以下载原图查看。')}
      </p>
    );
  }
  return (
    <div className="relative grid min-h-40 place-items-center overflow-hidden rounded-lg bg-subtle">
      {state === 'loading' && <Skeleton className="absolute inset-0 size-full rounded-none" />}
      <img
        src={fileInlineUrl(projectId, image.ref)}
        alt={image.title}
        decoding="async"
        data-loaded={state === 'ready' || undefined}
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        className="relative max-h-[70dvh] w-auto max-w-full object-contain opacity-0 transition-opacity duration-(--dur-base) data-loaded:opacity-100 motion-reduce:transition-none"
      />
    </div>
  );
}

/**
 * 消息里的图片附件：一张显示大缩略图，多张排成网格；点开是预览对话框（Esc 关闭，可下载、打开原图）。
 * 加载失败的图片交给 renderFallback 显示成原来的文件小标签。
 */
export function ImageAttachments({
  projectId,
  images,
  renderFallback,
}: {
  projectId: string;
  images: readonly OutputRef[];
  renderFallback: (outputs: OutputRef[]) => ReactNode;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = images.filter((image) => !failed.has(image.id));
  const broken = images.filter((image) => failed.has(image.id));
  const open = visible.find((image) => image.id === openId) ?? null;
  if (images.length === 0) return null;
  const single = visible.length === 1;
  return (
    <>
      {visible.length > 0 && (
        <ul
          aria-label={tr('图片附件')}
          className={cn(
            'mt-2 w-fit max-w-full gap-2',
            single ? 'flex' : visible.length === 2 ? 'grid grid-cols-2' : 'grid grid-cols-3',
          )}
        >
          {visible.map((image) => (
            <li key={image.id} className="min-w-0">
              <Thumb
                src={fileInlineUrl(projectId, image.ref)}
                name={image.title}
                className={single ? SINGLE_BOX : GRID_TILE}
                onOpen={() => setOpenId(image.id)}
                onError={() => setFailed((prev) => new Set(prev).add(image.id))}
              />
            </li>
          ))}
        </ul>
      )}
      {broken.length > 0 && renderFallback(broken)}
      <Lightbox projectId={projectId} image={open} onClose={() => setOpenId(null)} />
    </>
  );
}
