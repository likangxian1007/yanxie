import { useRef, useState } from 'react';
import {
  BookMarked,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import type * as Y from 'yjs';
import { LATEX_LIMITS } from '@srh/shared';
import {
  Button,
  Dialog,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  toast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  BIB_TEMPLATE,
  checkFileName,
  createTextFile,
  deleteFile,
  renameFile,
  suggestName,
  type ProjectFile,
} from '../project/files';
import { tr } from '@/lib/i18n';

interface FileBarProps {
  doc: Y.Doc;
  files: ProjectFile[];
  active: string;
  editable: boolean;
  onSelect: (name: string) => void;
  /** 上传图片（返回后由调用方写入工程） */
  onUpload: (name: string, file: File) => Promise<void>;
  /** 在光标处插入 \includegraphics */
  onInsertImage: (name: string) => void;
  imageUrl: (fileId: string) => string;
}

type NameDialog =
  | { mode: 'new'; ext: 'bib' | 'tex' }
  | { mode: 'rename'; from: string }
  | { mode: 'upload'; file: File };

function fileIcon(f: ProjectFile) {
  if (f.kind === 'image') return <ImageIcon size={14} strokeWidth={1.75} aria-hidden />;
  if (f.name.endsWith('.bib')) return <BookMarked size={14} strokeWidth={1.75} aria-hidden />;
  if (f.kind === 'main') return <FileCode2 size={14} strokeWidth={1.75} aria-hidden />;
  return <FileText size={14} strokeWidth={1.75} aria-hidden />;
}

function cleanUploadName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'png';
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return `figures/${stem || 'figure'}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/** LaTeX 工程的文件栏：main.tex、references.bib…，新建 / 改名 / 删除 / 上传图片 */
export function FileBar({
  doc,
  files,
  active,
  editable,
  onSelect,
  onUpload,
  onInsertImage,
  imageUrl,
}: FileBarProps) {
  const [dialog, setDialog] = useState<NameDialog | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const open = (d: NameDialog, initial: string) => {
    setDialog(d);
    setName(initial);
    setError(null);
  };

  const submit = async () => {
    if (!dialog) return;
    const check = checkFileName(
      doc,
      name,
      dialog.mode === 'upload' ? 'image' : dialog.mode === 'new' ? 'text' : undefined,
      dialog.mode === 'rename' ? dialog.from : undefined,
    );
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (dialog.mode === 'new') {
      createTextFile(doc, check.name, dialog.ext === 'bib' ? BIB_TEMPLATE : '');
      onSelect(check.name);
    } else if (dialog.mode === 'rename') {
      const from = dialog.from;
      const isImage = files.find((f) => f.name === from)?.kind === 'image';
      if (isImage !== (check.kind === 'image')) {
        setError(
          isImage ? tr('图片要保留 .png / .jpg / .pdf 扩展名') : tr('文本文件不能改成图片扩展名'),
        );
        return;
      }
      renameFile(doc, from, check.name);
      if (active === from) onSelect(check.name);
    } else {
      setBusy(true);
      try {
        await onUpload(check.name, dialog.file);
      } catch (err) {
        setError(err instanceof Error ? err.message : tr('上传失败，请重试'));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setDialog(null);
  };

  const remove = (f: ProjectFile) => {
    deleteFile(doc, f.name);
    toast({
      title: tr('已从工程里删除 {name}', { name: f.name }),
      description:
        f.kind === 'image' ? tr('图片文件仍保留在项目文件夹里。') : tr('可以用撤销恢复版本找回。'),
      tone: 'info',
    });
  };

  const textFiles = files.filter((f) => f.kind !== 'image');
  const images = files.filter((f) => f.kind === 'image');
  const activeFile = files.find((f) => f.name === active);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-surface px-1.5"
      role="tablist"
      aria-label={tr('工程文件')}
    >
      <div className="ltx-toolbar-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {textFiles.map((f) => {
          const selected = f.name === active;
          return (
            <button
              key={f.name}
              type="button"
              role="tab"
              aria-selected={selected}
              title={f.name}
              onClick={() => onSelect(f.name)}
              className={cn(
                'press flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-small',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selected ? 'bg-subtle text-fg' : 'text-fg-muted hover:bg-subtle hover:text-fg',
              )}
            >
              <span className={cn('shrink-0', selected ? 'text-accent' : 'text-fg-subtle')}>
                {fileIcon(f)}
              </span>
              <span className="truncate">{f.name}</span>
            </button>
          );
        })}
        {images.length > 0 && (
          <Menu
            label={tr('图片')}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-fg-muted"
                leftIcon={<ImageIcon strokeWidth={1.75} aria-hidden />}
              >
                {tr('图片 {count}', { count: images.length })}
              </Button>
            }
          >
            <MenuLabel>{tr('点一张图片插入 \\includegraphics')}</MenuLabel>
            {images.map((f) => (
              <MenuItem
                key={f.name}
                icon={<ImageIcon strokeWidth={1.75} aria-hidden />}
                description={`${Math.max(1, Math.round((f.asset?.size ?? 0) / 1024))} KB`}
                disabled={!editable}
                onSelect={() => onInsertImage(f.name)}
              >
                {f.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            {images.map((f) => (
              <MenuItem
                key={`open-${f.name}`}
                icon={<ExternalLink strokeWidth={1.75} aria-hidden />}
                onSelect={() => {
                  if (f.asset) window.open(imageUrl(f.asset.fileId), '_blank', 'noopener');
                }}
              >
                {tr('查看 {name}', { name: f.name })}
              </MenuItem>
            ))}
            {editable && <MenuSeparator />}
            {editable &&
              images.map((f) => (
                <MenuItem
                  key={`del-${f.name}`}
                  danger
                  icon={<Trash2 strokeWidth={1.75} aria-hidden />}
                  onSelect={() => remove(f)}
                >
                  {tr('移除 {name}', { name: f.name })}
                </MenuItem>
              ))}
          </Menu>
        )}
      </div>

      {editable && activeFile && activeFile.kind === 'text' && (
        <Menu
          label={tr('文件操作')}
          align="end"
          trigger={
            <IconButton label={tr('{name} 的操作', { name: activeFile.name })} size="sm">
              <MoreHorizontal strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          <MenuItem
            icon={<Pencil strokeWidth={1.75} aria-hidden />}
            onSelect={() => open({ mode: 'rename', from: activeFile.name }, activeFile.name)}
          >
            {tr('改名')}
          </MenuItem>
          <MenuItem
            danger
            icon={<Trash2 strokeWidth={1.75} aria-hidden />}
            onSelect={() => {
              onSelect('main.tex');
              remove(activeFile);
            }}
          >
            {tr('删除')}
          </MenuItem>
        </Menu>
      )}
      {editable && (
        <Menu
          label={tr('添加文件')}
          align="end"
          trigger={
            <IconButton label={tr('添加文件')} size="sm">
              <Plus strokeWidth={1.75} aria-hidden />
            </IconButton>
          }
        >
          <MenuLabel>{tr('工程最多 {files} 个文件', { files: LATEX_LIMITS.files })}</MenuLabel>
          <MenuItem
            icon={<BookMarked strokeWidth={1.75} aria-hidden />}
            description={tr('BibTeX 参考文献库，配合 \\cite 使用')}
            onSelect={() =>
              open({ mode: 'new', ext: 'bib' }, suggestName(doc, 'references', 'bib'))
            }
          >
            {tr('新建 .bib 文件')}
          </MenuItem>
          <MenuItem
            icon={<FilePlus2 strokeWidth={1.75} aria-hidden />}
            description={tr('章节文件，在 main.tex 里用 \\input 引入')}
            onSelect={() =>
              open({ mode: 'new', ext: 'tex' }, suggestName(doc, 'sections/section', 'tex'))
            }
          >
            {tr('新建 .tex 文件')}
          </MenuItem>
          <MenuItem
            icon={<Upload strokeWidth={1.75} aria-hidden />}
            description={tr('PNG、JPG 或 PDF，最大 20 MB')}
            onSelect={() => fileInput.current?.click()}
          >
            {tr('上传图片')}
          </MenuItem>
        </Menu>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > LATEX_LIMITS.assetBytes) {
            toast.error(tr('图片太大了'), tr('单个文件最大 20 MB。'));
            return;
          }
          open({ mode: 'upload', file }, cleanUploadName(file.name));
        }}
      />

      <Dialog
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setDialog(null);
        }}
        title={
          dialog?.mode === 'rename'
            ? tr('文件改名')
            : dialog?.mode === 'upload'
              ? tr('上传图片')
              : dialog?.mode === 'new' && dialog.ext === 'bib'
                ? tr('新建参考文献文件')
                : tr('新建 .tex 文件')
        }
        description={
          dialog?.mode === 'upload'
            ? tr('图片会存到项目文件夹，在正文里用 \\includegraphics{文件名} 引用。')
            : dialog?.mode === 'new' && dialog.ext === 'bib'
              ? tr(
                  '在 main.tex 里写 \\bibliography{文件名（不带 .bib）}，编译时会自动运行 BibTeX。',
                )
              : tr('路径里可以带目录，例如 sections/intro.tex。')
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setDialog(null)}>
              {tr('取消')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {dialog?.mode === 'rename'
                ? tr('改名')
                : dialog?.mode === 'upload'
                  ? tr('上传')
                  : tr('新建')}
            </Button>
          </>
        }
      >
        <Input
          data-autofocus
          aria-label={tr('文件名')}
          value={name}
          error={error ?? undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </Dialog>
    </div>
  );
}
