import type { DocumentKind } from '@srh/shared';
import { DOC_IMPORT_FILE_MAX_BYTES } from '@srh/shared';
import { fileExt, formatSize } from './text';
import type { Importer } from './types';
import { tr } from '@/lib/i18n';

export type { ImportContext, ImportResult, Importer } from './types';
export { ImportError } from './types';

/**
 * 文件导入注册表：扩展名 → 文档类型 + 导入器。
 *
 * 导入器按需加载（mammoth / SheetJS / pptx 解析器都不小）。各类型线程实现自己的导入器文件
 * （docx.ts / xlsx.ts / pptx.ts，签名见 types.ts 的 Importer）；这里只负责路由与限制。
 */
export interface ImportFormat {
  /** 不带点的小写扩展名 */
  exts: readonly string[];
  kind: DocumentKind;
  /** 给用户看的格式名 */
  label: string;
  /** 原始文件大小上限 */
  maxBytes: number;
  load: () => Promise<Importer>;
}

const MB = 1024 * 1024;

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  {
    exts: ['docx'],
    kind: 'doc',
    label: tr('Word 文档'),
    maxBytes: DOC_IMPORT_FILE_MAX_BYTES,
    load: () => import('./docx').then((m) => m.importDocx),
  },
  {
    exts: ['xlsx', 'xls', 'csv'],
    kind: 'sheet',
    label: tr('Excel 表格'),
    maxBytes: DOC_IMPORT_FILE_MAX_BYTES,
    load: () => import('./xlsx').then((m) => m.importXlsx),
  },
  {
    exts: ['pptx'],
    kind: 'slides',
    label: tr('PowerPoint 幻灯片'),
    maxBytes: DOC_IMPORT_FILE_MAX_BYTES,
    load: () => import('./pptx').then((m) => m.importPptx),
  },
  {
    exts: ['tex'],
    kind: 'latex',
    label: tr('LaTeX 源码'),
    maxBytes: 4 * MB,
    load: () => import('./tex').then((m) => m.importTex),
  },
  {
    exts: ['zip'],
    kind: 'latex',
    label: tr('LaTeX 工程压缩包'),
    maxBytes: DOC_IMPORT_FILE_MAX_BYTES,
    load: () => import('./tex').then((m) => m.importTex),
  },
  {
    exts: ['md', 'markdown'],
    kind: 'doc',
    label: 'Markdown',
    maxBytes: 8 * MB,
    load: () => import('./markup').then((m) => m.importMarkdown),
  },
  {
    exts: ['txt'],
    kind: 'doc',
    label: tr('纯文本'),
    maxBytes: 8 * MB,
    load: () => import('./markup').then((m) => m.importPlainText),
  },
  {
    exts: ['html', 'htm'],
    kind: 'doc',
    label: tr('网页'),
    maxBytes: 8 * MB,
    load: () => import('./markup').then((m) => m.importHtml),
  },
];

/** <input accept>：全部支持的扩展名；传 kind 时只列这一类 */
export function importAccept(kind?: DocumentKind): string {
  return IMPORT_FORMATS.filter((f) => !kind || f.kind === kind)
    .flatMap((f) => f.exts.map((e) => `.${e}`))
    .join(',');
}

/** 支持的格式说明（对话框里显示） */
export const IMPORT_HINT = tr(
  'Word、Excel、CSV、PowerPoint、LaTeX（.tex 或工程 .zip）、Markdown、纯文本、网页',
);

export type ImportRoute =
  { ok: true; format: ImportFormat; kind: DocumentKind } | { ok: false; error: string };

/** 选文件后的第一道检查：类型、大小（可限定只接受某一类，例如在已有文档里导入） */
export function routeImport(
  file: { name: string; size: number },
  onlyKind?: DocumentKind,
): ImportRoute {
  const ext = fileExt(file.name);
  const format = IMPORT_FORMATS.find((f) => f.exts.includes(ext));
  if (!format) {
    if (ext === 'doc' || ext === 'ppt') {
      return {
        ok: false,
        error: tr('不支持旧版 .{ext} 文件，请先在 Office 里另存为 .{ext2}x 再上传', {
          ext,
          ext2: ext,
        }),
      };
    }
    return {
      ok: false,
      error: ext
        ? tr('不支持 .{ext} 文件。可以上传 {IMPORT_HINT}', { ext, IMPORT_HINT })
        : tr('认不出这个文件的类型'),
    };
  }
  if (onlyKind && format.kind !== onlyKind) {
    return {
      ok: false,
      error: tr('这里只能导入同类型的文件，{label}请回到文档列表上传', { label: format.label }),
    };
  }
  if (file.size === 0) return { ok: false, error: tr('这个文件是空的') };
  if (file.size > format.maxBytes) {
    return {
      ok: false,
      error: tr('文件太大了（{value}），{label}最大 {value2}', {
        value: formatSize(file.size),
        label: format.label,
        value2: formatSize(format.maxBytes),
      }),
    };
  }
  return { ok: true, format, kind: format.kind };
}
