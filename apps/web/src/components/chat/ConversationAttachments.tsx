import { useCallback, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Spinner } from '@/components/ui';
import { fileInlineUrl, isPreviewableImage } from '@/lib/image-attachments';
import type { ConversationAttachment, ConversationAttachments } from './conversation-attachments';
import { tr } from '@/lib/i18n';

/**
 * 待发送图片的小缩略图：上传前后都用本地 File 的 object URL（不等网络），
 * 上传完成、本地 File 释放后改用服务端内联地址；读不出来时退回文件图标。
 */
function PendingPreview({ projectId, file }: { projectId: string; file: ConversationAttachment }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const local = file.file;
  // 本地文件：在 ref 里建 object URL，卸载或换文件时随 ref 清理一起释放
  const attachLocal = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || !local || typeof URL.createObjectURL !== 'function') return;
      const url = URL.createObjectURL(local);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [local],
  );
  if (!isPreviewableImage(file.name) || failed || (!local && !file.fileId)) {
    return <FileText size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />;
  }
  return (
    <span className="relative size-10 shrink-0 overflow-hidden rounded-sm border border-line bg-muted">
      <img
        key={local ? 'local' : 'remote'}
        alt=""
        data-testid="pending-image-preview"
        decoding="async"
        data-loaded={loaded || undefined}
        ref={local ? attachLocal : undefined}
        src={local ? undefined : fileInlineUrl(projectId, file.fileId!)}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="size-full object-cover opacity-0 transition-opacity duration-(--dur-base) data-loaded:opacity-100 motion-reduce:transition-none"
      />
    </span>
  );
}

export function ConversationAttachmentButton({
  attachments,
  disabled,
}: {
  attachments: ConversationAttachments;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        aria-label={tr('选择课题共享文件')}
        tabIndex={-1}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          if (event.currentTarget.files) attachments.add(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="press inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-60 max-md:min-h-11"
      >
        <Paperclip size={15} strokeWidth={1.75} aria-hidden />
        {tr('添加课题共享文件')}
      </button>
    </>
  );
}

/** 上传状态和移除操作始终可见，失败项可重试。 */
export function ConversationAttachmentList({
  attachments,
  disabled,
}: {
  attachments: ConversationAttachments;
  disabled?: boolean;
}) {
  if (!attachments.files.length && !attachments.notice) return null;
  return (
    <div className="px-3 pt-3">
      <p className="pb-1 text-caption text-fg-muted">
        {tr('文件上传到课题共享文件夹，课题成员可访问。')}
      </p>
      <ul
        aria-label={tr('待发送附件')}
        className="flex max-h-40 flex-wrap gap-2 overflow-y-auto overscroll-contain"
      >
        {attachments.files.map((file) => (
          <li
            key={file.id}
            className="flex min-w-0 max-w-full items-start gap-1 rounded-md border border-line bg-subtle px-2 py-2 text-small"
          >
            <PendingPreview projectId={attachments.projectId} file={file} />
            <span className="min-w-0 flex-1">
              <span className="block max-w-48 truncate text-fg" title={file.name}>
                {file.name}
              </span>
              {file.status === 'uploading' && (
                <span className="flex items-center gap-1 text-caption text-fg-muted">
                  <Spinner size={12} />
                  {tr('上传中，请稍候')}
                </span>
              )}
              {file.status === 'ready' && (
                <span className="block text-caption text-fg-muted">{tr('已上传')}</span>
              )}
              {file.status === 'error' && (
                <span className="block text-caption text-danger">
                  {file.error ?? tr('上传失败，请重试。')}
                </span>
              )}
            </span>
            {file.status === 'error' && file.size <= 20 * 1024 * 1024 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => attachments.retry(file.id)}
                className="shrink-0 rounded-sm px-1 text-caption text-accent-text underline disabled:opacity-60"
              >
                {tr('重试')}
              </button>
            )}
            <button
              type="button"
              aria-label={tr('移除附件 {name}', { name: file.name })}
              disabled={disabled}
              onClick={() => attachments.remove(file.id)}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-muted hover:bg-muted disabled:opacity-60 max-md:size-10"
            >
              <X size={15} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {attachments.notice && (
        <p role="alert" className="pt-1 text-caption text-danger">
          {attachments.notice}
        </p>
      )}
      {attachments.hasErrors && (
        <p className="pt-1 text-caption text-danger">{tr('请重试或移除上传失败的文件后发送。')}</p>
      )}
    </div>
  );
}
