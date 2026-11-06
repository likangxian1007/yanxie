import type { DocumentKind, DocumentMeta } from '@srh/shared';
import { keepViewerFields } from '@/features/sharing/viewer-fields';

/** 列表页的纯逻辑：过滤、排序、组装树、缓存更新。 */

export type DocSort = 'updated' | 'title';
export type DocKindFilter = 'all' | DocumentKind;

export interface DocNode {
  doc: DocumentMeta;
  children: DocNode[];
}

/** 标题 + 摘要模糊匹配（大小写不敏感，空格分词全部命中） */
export function matchesQuery(doc: DocumentMeta, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${doc.title}\n${doc.excerpt}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function compareDocs(sort: DocSort) {
  return (a: DocumentMeta, b: DocumentMeta): number => {
    if (sort === 'title') {
      const t = a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true });
      return t !== 0 ? t : b.updatedAt.localeCompare(a.updatedAt);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  };
}

export function filterDocs(
  docs: DocumentMeta[],
  { kind, query }: { kind: DocKindFilter; query: string },
): DocumentMeta[] {
  return docs.filter((d) => (kind === 'all' || d.kind === kind) && matchesQuery(d, query));
}

/**
 * 按 parentId 组装树。父文档不在列表里（被过滤 / 归档 / 无权限）的节点提升为根。
 * 每一层按 sort 排序；防御环引用。
 */
export function buildTree(docs: DocumentMeta[], sort: DocSort): DocNode[] {
  const ids = new Set(docs.map((d) => d.id));
  const byParent = new Map<string | null, DocumentMeta[]>();
  for (const d of docs) {
    const parent = d.parentId && ids.has(d.parentId) && d.parentId !== d.id ? d.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(d);
    byParent.set(parent, list);
  }
  const cmp = compareDocs(sort);
  const seen = new Set<string>();
  const build = (parent: string | null): DocNode[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort(cmp)
      .filter((d) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      })
      .map((doc) => ({ doc, children: build(doc.id) }));
  const roots = build(null);
  // 环里的节点（互为父子、都不在根上）兜底挂到根
  const orphans = docs.filter((d) => !seen.has(d.id));
  return orphans.length
    ? [
        ...roots,
        ...buildTree(
          orphans.map((d) => ({ ...d, parentId: null })),
          sort,
        ),
      ]
    : roots;
}

/** 某文档及其全部后代的 id（“移动到…”时排除，避免把父文档移进自己的子孙） */
export function descendantIds(docs: DocumentMeta[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of docs) {
      if (d.parentId && out.has(d.parentId) && !out.has(d.id)) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return out;
}

/** 文档在缓存列表里的增改：archived 列表只放已归档的，活跃列表只放未归档的 */
export function upsertDoc(
  list: DocumentMeta[] | undefined,
  doc: DocumentMeta,
  archivedList: boolean,
): DocumentMeta[] | undefined {
  if (!list) return list;
  const belongs = Boolean(doc.archivedAt) === archivedList;
  const i = list.findIndex((d) => d.id === doc.id);
  if (!belongs) return i === -1 ? list : list.filter((d) => d.id !== doc.id);
  if (i === -1) return [doc, ...list];
  const next = list.slice();
  next[i] = keepViewerFields(list[i], doc);
  return next;
}

export function removeDoc(list: DocumentMeta[] | undefined, id: string) {
  return list?.filter((d) => d.id !== id);
}

/** 置顶的排到最前面（按置顶的先后），其余保持原顺序 */
export function pinnedFirst<T>(
  items: T[],
  pins: readonly string[],
  idOf: (item: T) => string,
): T[] {
  if (pins.length === 0) return items;
  const rank = new Map(pins.map((id, i) => [id, i]));
  const top = items.filter((x) => rank.has(idOf(x)));
  if (top.length === 0) return items;
  top.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0));
  return [...top, ...items.filter((x) => !rank.has(idOf(x)))];
}

/** 每种类型的数量（Tabs 计数） */
export function countByKind(docs: DocumentMeta[]): Record<DocKindFilter, number> {
  const out: Record<DocKindFilter, number> = {
    all: docs.length,
    doc: 0,
    sheet: 0,
    slides: 0,
    latex: 0,
  };
  for (const d of docs) out[d.kind] += 1;
  return out;
}
