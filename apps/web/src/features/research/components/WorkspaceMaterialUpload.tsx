import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FileObject } from '@srh/shared';
import { Button } from '@/components/ui';
import { uploadProjectFile } from '@/features/docs/import/api';
import { clientId } from '@/lib/client-id';
import { api } from '@/lib/api';
import { researchApi } from '../data';
import { tr } from '@/lib/i18n';

/** 上传原件后引用同一项目文件，不隐式导入或复制成研究笔记。 */
export function WorkspaceMaterialUpload({
  pid,
  disabled,
  onUploaded,
}: {
  pid: string;
  disabled?: boolean;
  onUploaded: (file: FileObject) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<{ file: File; path: string; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const qc = useQueryClient();
  const upload = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) {
      setRetryFile(null);
      setError(tr('文件超过 20 MB，请选择较小文件。'));
      return;
    }
    setRetryFile(file);
    // 同一选择重试保持路径；请求丢失响应时可找回已经保存的原件。
    const safeName = file.name.replace(/[\\/<>:"|?*]/gu, '_').replace(/[. ]+$/u, '') || tr('材料');
    if (current.current?.file !== file) {
      const key = clientId();
      current.current = { file, path: `research-materials/${key}/${safeName}`, key };
    }
    const path = current.current.path;
    const key = current.current.key;
    setPending(true);
    setError('');
    try {
      let saved: FileObject;
      try {
        saved = await uploadProjectFile(pid, path, file);
      } catch (cause) {
        const files = await api.get<FileObject[]>(`/projects/${pid}/files`).catch(() => []);
        const existing = files.find((entry) => entry.path === path);
        if (!existing) throw cause;
        saved = existing;
      }
      const source = await researchApi.createSource(pid, {
        kind: 'file',
        resourceId: saved.id,
        title: file.name,
        idempotencyKey: `upload-source-${key}`,
      });
      await researchApi.createSnapshot(pid, source.id, {
        coverage: 'complete',
        idempotencyKey: `upload-snapshot-${key}`,
      });
      await qc.invalidateQueries({ queryKey: ['p', pid, 'resource-picker'] });
      onUploaded(saved);
      setRetryFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('文件没有上传，请重试。'));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2 sm:col-span-2">
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label={tr('上传研究材料文件')}
        disabled={disabled || pending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          loading={pending}
          onClick={() => input.current?.click()}
        >
          {tr('上传文件')}
        </Button>
        <span className="text-caption text-fg-muted">{tr('保留项目原件 · 最大 20 MB')}</span>
        {error && retryFile && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void upload(retryFile)}
          >
            {tr('重试上传')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
