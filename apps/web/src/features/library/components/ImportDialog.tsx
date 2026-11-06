import { useRef, useState } from 'react';
import { PAPER_PDF_MAX_BYTES } from '@srh/shared';
import { useNavigate } from 'react-router';
import { FileUp, Link2, Upload } from 'lucide-react';
import { Button, Dialog, Input, Tabs, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useImportPaper, type ImportInput } from '../api';
import { guessImportKind } from '../lib/format';
import { libraryPath } from '../lib/scope';
import { usePersonalLibrary } from '../lib/use-library-scope';
import { tr } from '@/lib/i18n';

type Mode = 'id' | 'upload';
const MAX_BYTES = PAPER_PDF_MAX_BYTES;

/**
 * 导入论文：粘贴 arXiv 编号 / DOI / PDF 链接（自动识别），或上传 PDF（可多选，逐个上传）。
 * 导入后立即出现在列表里，解析进度实时推送。
 */
export function ImportDialog({
  fromProject,
  open,
  onOpenChange,
}: {
  fromProject?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const pid = usePersonalLibrary();
  const imp = useImportPaper(pid);
  const [mode, setMode] = useState<Mode>('id');
  const [value, setValue] = useState('');
  const [tags, setTags] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const kind = guessImportKind(value);
  const tagList = tags
    .split(/[,，\s]+/u)
    .map((t) => t.trim())
    .filter(Boolean);

  const reset = () => {
    setValue('');
    setFiles([]);
    setError(null);
  };

  const pick = (list: FileList | null) => {
    if (!list) return;
    const pdfs = [...list].filter((f) => f.type === 'application/pdf' || /\.pdf$/iu.test(f.name));
    const big = pdfs.filter((f) => f.size > MAX_BYTES);
    setError(
      pdfs.length < list.length
        ? tr('只能上传 PDF 文件')
        : big.length
          ? tr('{value} 超过 100 MB', { value: big.map((f) => f.name).join(tr('、')) })
          : null,
    );
    setFiles(pdfs.filter((f) => f.size <= MAX_BYTES));
  };

  const run = async (inputs: ImportInput[]) => {
    setBusy(true);
    setError(null);
    let last: string | null = null;
    let dup = 0;
    try {
      for (const input of inputs) {
        const r = await imp.mutateAsync(input);
        last = r.paper.id;
        if (r.duplicate) dup += 1;
      }
      toast({
        tone: 'success',
        title:
          inputs.length === 1 && dup === 1
            ? tr('个人库里已经有这篇')
            : tr('已导入个人库 {value} 篇', { value: inputs.length - dup }),
        description:
          dup && inputs.length > 1
            ? tr('{dup} 篇已存在，没有重复导入', { dup })
            : tr('仅自己可见，解析进度会自动更新'),
      });
      reset();
      onOpenChange(false);
      navigate(libraryPath(pid, inputs.length === 1 && last ? last : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('导入失败'));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (busy) return;
    if (mode === 'id') {
      if (!kind) {
        setError(
          tr('没认出来：请填 arXiv 编号（如 1706.03762）、DOI（如 10.1145/3065386）或 PDF 链接'),
        );
        return;
      }
      void run([{ kind, value: value.trim(), tags: tagList }]);
    } else if (files.length) {
      void run(files.map((file) => ({ kind: 'upload' as const, file, tags: tagList })));
    }
  };

  const KIND_LABEL = { arxiv: tr('arXiv 论文'), doi: 'DOI', url: tr('PDF 链接') } as const;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
      title={tr('导入到个人库')}
      description={
        fromProject
          ? tr('论文先保存在你的个人库，项目成员看不到。本次导入不会发布到项目。')
          : tr('论文和阅读记录默认仅自己可见。支持 arXiv、DOI、PDF 链接与文件上传。')
      }
      size="sm"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {tr('取消')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={mode === 'id' ? !value.trim() : files.length === 0}
            onClick={submit}
          >
            {mode === 'upload' && files.length > 1
              ? tr('导入 {count} 篇', { count: files.length })
              : tr('导入论文')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs
          variant="segmented"
          layoutId="lib-import-mode"
          value={mode}
          onValueChange={(m) => {
            setMode(m);
            setError(null);
          }}
          items={[
            {
              value: 'id',
              label: tr('arXiv / DOI / 链接'),
              icon: <Link2 strokeWidth={1.75} aria-hidden />,
            },
            {
              value: 'upload',
              label: tr('上传 PDF'),
              icon: <Upload strokeWidth={1.75} aria-hidden />,
            },
          ]}
        />
        {mode === 'id' ? (
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              aria-label={tr('arXiv 编号、DOI 或 PDF 链接')}
              placeholder="1706.03762 · 10.1145/3065386 · https://…/paper.pdf"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
              }}
            />
            <p className="text-caption text-fg-muted">
              {kind
                ? tr('识别为 {value}', { value: KIND_LABEL[kind] })
                : tr('DOI 没有开放获取 PDF 时会先保存元数据，之后上传 PDF 即可解析。')}
            </p>
          </div>
        ) : (
          <div
            className={cn(
              'flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-subtle',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files);
            }}
          >
            <FileUp className="size-6 text-fg-muted" strokeWidth={1.5} aria-hidden />
            <p className="text-small text-fg">
              {files.length ? files.map((f) => f.name).join(tr('、')) : tr('把 PDF 拖到这里，或')}
            </p>
            <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
              {tr('选择文件')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="sr-only"
              onChange={(e) => pick(e.target.files)}
            />
            <p className="text-caption text-fg-subtle">
              {tr('单个不超过 100 MB；同一个文件只会导入一次')}
            </p>
          </div>
        )}
        <Input
          aria-label={tr('标签')}
          placeholder={tr('标签（可选），用逗号分隔')}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        {error && (
          <p className="text-small text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
