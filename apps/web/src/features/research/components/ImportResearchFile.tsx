import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Dialog } from '@/components/ui';
import { uploadProjectFile } from '@/features/docs/import/api';
import { newImportId, runImport } from '@/features/docs/import/run';
import { withBase } from '@/lib/base-path';
import { researchApi, researchKey } from '../data';
import { tr } from '@/lib/i18n';

const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const ACCEPT = '.docx,.xlsx,.csv,.md,.txt';

/** 使用现有文档导入器；先保留原件快照，再将导入文档关联到原件。 */
export function ImportResearchFile({
  pid,
  open,
  onOpenChange,
}: {
  pid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ originalId: string; documentId: string } | null>(null);
  const submit = async () => {
    if (!file) {
      setError(tr('请先选择文件。'));
      return;
    }
    if (file.size > MAX_ORIGINAL_BYTES) {
      setError(tr('原件超过项目文件上传的 20 MB 上限。请选择较小文件。'));
      return;
    }
    setPending(true);
    setError('');
    setResult(null);
    try {
      const safeName =
        // eslint-disable-next-line no-control-regex
        file.name.replace(/[<>:"|?*\\/\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '') ||
        tr('原件');
      setStage(tr('保存原件'));
      const uploaded = await uploadProjectFile(
        pid,
        `research-originals/${newImportId()}/${safeName}`,
        file,
      );
      const original = await researchApi.createSource(pid, {
        kind: 'file',
        resourceId: uploaded.id,
        title: file.name,
        citation: '',
        url: null,
        recordId: null,
        originalSourceId: null,
      });
      await researchApi.createSnapshot(pid, original.id, { coverage: 'complete' });
      setStage(tr('导入可编辑文档'));
      const imported = await runImport({ pid, file, importId: newImportId() });
      const derived = await researchApi.createSource(pid, {
        kind: 'document',
        resourceId: imported.meta.id,
        title: imported.meta.title || file.name,
        citation: '',
        url: null,
        recordId: null,
        originalSourceId: original.id,
      });
      if (imported.meta.excerpt)
        await researchApi.createSnapshot(pid, derived.id, {
          coverage: 'excerpt',
          text: imported.meta.excerpt,
        });
      setResult({ originalId: original.id, documentId: derived.id });
      await qc.invalidateQueries({ queryKey: researchKey(pid) });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr('导入失败，请重试。若原件已保存，可在资料列表中找到。'),
      );
    } finally {
      setPending(false);
      setStage('');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={tr('导入研究资料')}
      description={tr(
        '支持 Word、Excel、CSV、Markdown 和纯文本。先保存原件完整快照，再创建可编辑文档；导入稿与原件分别可追溯。',
      )}
      size="md"
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {tr('关闭')}
          </Button>
          <Button
            variant="primary"
            disabled={!file || pending || !!result}
            loading={pending}
            onClick={() => void submit()}
          >
            {tr('导入文件')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError('');
            setResult(null);
          }}
        />
        <Button variant="secondary" onClick={() => input.current?.click()}>
          {tr('选择文件')}
        </Button>
        <p className="text-small text-fg-muted">
          {file
            ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
            : tr('尚未选择文件；原件上限 20 MB。')}
        </p>
        {pending && (
          <p role="status" className="text-small text-fg-muted">
            {tr('正在{stage}…', { stage })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-1 text-small text-success">
            <p>{tr('原件与导入文档已关联。')}</p>
            <a
              className="text-accent-text hover:underline"
              href={withBase(`/p/${pid}/research-sources/${result.originalId}`)}
            >
              {tr('查看原件')}
            </a>
            <span> · </span>
            <a
              className="text-accent-text hover:underline"
              href={withBase(`/p/${pid}/research-sources/${result.documentId}`)}
            >
              {tr('查看导入稿')}
            </a>
          </div>
        )}
      </div>
    </Dialog>
  );
}
