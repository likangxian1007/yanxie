import type { DocumentMeta, DocumentOutlineItem } from '@srh/shared';
import { tr } from '@/lib/i18n';

export const UNTITLED = tr('未命名文档');

/**
 * 新建的富文本文档还没起标题时，标题跟随正文的第一个一级标题（与飞书一致）。
 * 已经改过标题的文档不动；返回 null 表示不用改。
 */
export function titleFromOutline(
  meta: Pick<DocumentMeta, 'kind' | 'title'>,
  outline: readonly DocumentOutlineItem[],
): string | null {
  if (meta.kind !== 'doc') return null;
  const current = meta.title.trim();
  if (current && current !== UNTITLED) return null;
  const first = outline[0];
  if (!first || first.level !== 1) return null;
  const heading = first.heading.replace(/\s+/gu, ' ').trim().slice(0, 200);
  if (!heading || heading === current) return null;
  return heading;
}
