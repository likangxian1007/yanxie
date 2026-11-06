import type { HTMLAttributes } from 'react';
import { FileText, Presentation, Sigma, Table2, type LucideIcon } from 'lucide-react';
import { DOCUMENT_KIND_LABEL, type DocumentKind } from '@srh/shared';
import { cn } from '@/lib/cn';
import { paletteSoft, paletteVar } from '@/lib/palette';
import { tr } from '@/lib/i18n';

/**
 * 四类协同文档的展示元数据（列表、详情页、模板画廊共用）。
 * tone 为 STYLE §1.2 色板序号：文档蓝、表格绿、幻灯片橙、LaTeX 青。
 */
export interface DocKindMeta {
  label: string;
  icon: LucideIcon;
  /** 一句话介绍（空状态、新建菜单、模板画廊里用） */
  description: string;
  /** 色板序号 0–7 */
  tone: number;
}

// 这个文件按约定同时导出元数据与图标组件（文档详情页等处直接引用）
// eslint-disable-next-line react-refresh/only-export-components
export const DOC_KINDS: readonly DocumentKind[] = ['doc', 'sheet', 'slides', 'latex'];

// eslint-disable-next-line react-refresh/only-export-components
export const DOC_KIND_META: Record<DocumentKind, DocKindMeta> = {
  doc: {
    label: DOCUMENT_KIND_LABEL.doc,
    icon: FileText,
    description: tr('富文本协同写作：周报、读书笔记、研究计划'),
    tone: 2,
  },
  sheet: {
    label: DOCUMENT_KIND_LABEL.sheet,
    icon: Table2,
    description: tr('记录实验数据与文献清单，支持公式'),
    tone: 4,
  },
  slides: {
    label: DOCUMENT_KIND_LABEL.slides,
    icon: Presentation,
    description: tr('组会汇报、论文分享，一页一页地讲'),
    tone: 5,
  },
  latex: {
    label: DOCUMENT_KIND_LABEL.latex,
    icon: Sigma,
    description: tr('多人同写 LaTeX 源码，实时预览公式与排版'),
    tone: 3,
  },
};

export type DocKindIconSize = 'sm' | 'md' | 'lg';

const SIZE: Record<DocKindIconSize, { box: string; icon: number }> = {
  sm: { box: 'size-5 rounded-xs', icon: 12 },
  md: { box: 'size-7 rounded-sm', icon: 16 },
  lg: { box: 'size-10 rounded-md', icon: 20 },
};

export interface DocKindIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  kind: DocumentKind;
  /** sm 20px / md 28px / lg 40px */
  size?: DocKindIconSize;
  /** 给读屏的文字；默认作装饰（aria-hidden） */
  label?: string;
}

/** 类型图标：色板柔和底的小方块 + 同色线性图标。 */
export function DocKindIcon({
  kind,
  size = 'md',
  label,
  className,
  style,
  ...props
}: DocKindIconProps) {
  const meta = DOC_KIND_META[kind] ?? DOC_KIND_META.doc;
  const s = SIZE[size];
  const Icon = meta.icon;
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-kind={kind}
      className={cn('inline-flex shrink-0 items-center justify-center', s.box, className)}
      style={{ backgroundColor: paletteSoft(meta.tone), color: paletteVar(meta.tone), ...style }}
      {...props}
    >
      <Icon size={s.icon} strokeWidth={1.75} aria-hidden />
    </span>
  );
}
