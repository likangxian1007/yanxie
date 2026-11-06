import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import {
  Download,
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Trash2,
} from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ICON_STROKE } from '../components/icons';
import { formatBytes } from '../media/upload';
import { tr } from '@/lib/i18n';

type FileKind = 'sheet' | 'archive' | 'code' | 'text' | 'file';

function fileKind(name: string, mime: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['csv', 'xls', 'xlsx', 'tsv'].includes(ext)) return 'sheet';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archive';
  if (['py', 'js', 'ts', 'ipynb', 'json', 'yaml', 'yml', 'sh', 'tex', 'm', 'r'].includes(ext))
    return 'code';
  if (mime.startsWith('text/') || ['pdf', 'doc', 'docx', 'md', 'txt'].includes(ext)) return 'text';
  return 'file';
}

const ICON_PROPS = { size: 18, strokeWidth: ICON_STROKE, 'aria-hidden': true } as const;

function FileKindIcon({ name, mime }: { name: string; mime: string }) {
  switch (fileKind(name, mime)) {
    case 'sheet':
      return <FileSpreadsheet {...ICON_PROPS} />;
    case 'archive':
      return <FileArchive {...ICON_PROPS} />;
    case 'code':
      return <FileCode {...ICON_PROPS} />;
    case 'text':
      return <FileText {...ICON_PROPS} />;
    default:
      return <File {...ICON_PROPS} />;
  }
}

function downloadHref(href: string): string {
  if (!href || /[?&]download=1/u.test(href) || !/\/files\/fil_/u.test(href)) return href;
  return `${href}${href.includes('?') ? '&' : '?'}download=1`;
}

/** 附件卡片：图标、文件名、大小，点击下载。 */
export function AttachmentView({ node, selected, editor, deleteNode }: ReactNodeViewProps) {
  const name = String(node.attrs.name || tr('附件'));
  const mime = String(node.attrs.mime ?? '');
  const size = node.attrs.size === null ? null : Number(node.attrs.size);
  const href = downloadHref(String(node.attrs.href ?? ''));
  const editable = editor.isEditable;
  const sizeText = formatBytes(size);
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : '';

  return (
    <NodeViewWrapper data-type="file-attachment" className="my-1">
      <div
        data-drag-handle
        className={cn(
          'flex max-w-md items-center gap-3 rounded-lg border border-line bg-surface p-2.5 pr-2 transition-colors duration-(--dur-fast) hover:border-line-strong',
          selected && editable && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
          <FileKindIcon name={name} mime={mime} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-fg" title={name}>
            {name}
          </span>
          <span className="block truncate text-caption text-fg-subtle">
            {[ext, sizeText].filter(Boolean).join(' · ') || tr('文件')}
          </span>
        </span>
        <a
          data-node-interactive
          href={href}
          download={name}
          aria-label={tr('下载 {name}', { name })}
          title={tr('下载')}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-(--dur-fast) hover:bg-subtle hover:text-fg"
        >
          <Download size={16} strokeWidth={ICON_STROKE} aria-hidden />
        </a>
        {editable && selected && (
          <span data-node-interactive>
            <IconButton
              size="sm"
              label={tr('删除附件')}
              className="hover:bg-danger-soft hover:text-danger"
              onClick={() => deleteNode()}
            >
              <Trash2 strokeWidth={ICON_STROKE} />
            </IconButton>
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}
