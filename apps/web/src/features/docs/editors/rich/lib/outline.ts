import type { DocumentOutlineItem } from '@srh/shared';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface HeadingEntry extends DocumentOutlineItem {
  /** 标题节点在文档里的位置（节点起点） */
  pos: number;
}

/**
 * 按文档顺序收集标题（跳过空标题）。大纲的第 index 项 = 这里的第 index 项，
 * 详情页的 jumpTo.index 也按这个顺序找。
 */
export function collectHeadings(doc: PMNode): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const heading = node.textContent.replace(/\s+/g, ' ').trim();
      if (heading) {
        const raw = Number(node.attrs.level);
        const level = Number.isFinite(raw) ? Math.min(6, Math.max(1, Math.trunc(raw))) : 1;
        out.push({ heading, level, pos });
      }
      return false;
    }
    // 只有块容器里可能还有标题；行内内容不用再往下走
    return !node.isTextblock;
  });
  return out;
}

export function extractOutline(doc: PMNode): DocumentOutlineItem[] {
  return collectHeadings(doc).map(({ heading, level }) => ({ heading, level }));
}

export function sameOutline(a: DocumentOutlineItem[], b: DocumentOutlineItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.heading === b[i]?.heading && item.level === b[i]?.level);
}
