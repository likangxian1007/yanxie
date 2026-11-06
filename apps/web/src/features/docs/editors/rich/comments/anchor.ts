import * as Y from 'yjs';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import type { DocComment, DocCommentAnchor } from '@srh/shared';

/**
 * 评论锚点：选区两端换成 Y.RelativePosition（挂在 Yjs 的字符上，不是数字下标），
 * 别人在前面插字、删段，锚点仍跟着原来那段文字走；那段文字整个被删掉时两端重合 → 失效。
 */
interface SyncState {
  doc: Y.Doc;
  type: Y.XmlFragment;
  binding: { mapping: Parameters<typeof absolutePositionToRelativePosition>[2] } | null;
}

function syncState(state: EditorState): SyncState | null {
  const s = ySyncPluginKey.getState(state) as SyncState | undefined;
  return s?.binding ? s : null;
}

/**
 * y-tiptap 生成的相对位置挂在“左边那个字”上；评论起点要挂在“右边那个字”（评论的第一个字）上，
 * 否则别人在评论文字正前方（比如段首）打字，高亮会把新字也包进去。
 */
function rightAssoc(doc: Y.Doc, rel: Y.RelativePosition): Y.RelativePosition {
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (!abs || !(abs.type instanceof Y.XmlText)) return rel;
  return Y.createRelativePositionFromTypeIndex(abs.type, abs.index, 0);
}

export function encodeAnchor(
  state: EditorState,
  from: number,
  to: number,
): DocCommentAnchor | null {
  const ys = syncState(state);
  if (!ys?.binding || from >= to) return null;
  const start = rightAssoc(
    ys.doc,
    absolutePositionToRelativePosition(from, ys.type, ys.binding.mapping),
  );
  const end = absolutePositionToRelativePosition(to, ys.type, ys.binding.mapping);
  return {
    start: Y.relativePositionToJSON(start) as Record<string, unknown>,
    end: Y.relativePositionToJSON(end) as Record<string, unknown>,
  };
}

export interface AnchorRange {
  from: number;
  to: number;
}

/** 锚点 → 当前文档里的区间；文字已被删掉（区间塌成空）或无法解析时返回 null */
export function resolveAnchor(
  state: EditorState,
  anchor: DocCommentAnchor | null,
): AnchorRange | null {
  if (!anchor) return null;
  const ys = syncState(state);
  if (!ys?.binding) return null;
  try {
    const start = Y.createRelativePositionFromJSON(anchor.start);
    const end = Y.createRelativePositionFromJSON(anchor.end);
    const from = relativePositionToAbsolutePosition(ys.doc, ys.type, start, ys.binding.mapping);
    const to = relativePositionToAbsolutePosition(ys.doc, ys.type, end, ys.binding.mapping);
    if (from === null || to === null) return null;
    const size = state.doc.content.size;
    const a = Math.max(0, Math.min(from, size));
    const b = Math.max(0, Math.min(to, size));
    if (b <= a) return null;
    if (!state.doc.textBetween(a, b, ' ', ' ').trim()) return null;
    return { from: a, to: b };
  } catch {
    return null;
  }
}

/** 一串评论：首条 + 回复（旧到新） */
export interface CommentThread {
  root: DocComment;
  replies: DocComment[];
}

/** 把平铺的评论按 parentId 分串；回复的首条不存在（被删）时丢弃 */
export function groupThreads(comments: readonly DocComment[]): CommentThread[] {
  const roots = new Map<string, CommentThread>();
  for (const c of comments) if (!c.parentId) roots.set(c.id, { root: c, replies: [] });
  for (const c of comments) {
    if (c.parentId) roots.get(c.parentId)?.replies.push(c);
  }
  for (const t of roots.values()) t.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...roots.values()];
}

/**
 * 侧栏排序：有位置的按在文中的先后，同位置按时间；原文已删的排在最后。
 */
export function sortThreads(
  threads: readonly CommentThread[],
  ranges: ReadonlyMap<string, AnchorRange | null>,
): CommentThread[] {
  return [...threads].sort((a, b) => {
    const ra = ranges.get(a.root.id) ?? null;
    const rb = ranges.get(b.root.id) ?? null;
    if (ra && rb) return ra.from - rb.from || a.root.createdAt.localeCompare(b.root.createdAt);
    if (ra) return -1;
    if (rb) return 1;
    return a.root.createdAt.localeCompare(b.root.createdAt);
  });
}

/** 选区的原文（引用用，最多 200 字） */
export function quoteOf(doc: PMNode, from: number, to: number): string {
  const text = doc.textBetween(from, to, ' ', ' ').replace(/\s+/gu, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** 评论正文里 “@名字” 对应的成员 id（只认候选里出现过、且正文还保留着的） */
export function mentionsInBody(body: string, picked: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [id, name] of picked) {
    if (body.includes(`@${name}`) && !out.includes(id)) out.push(id);
  }
  return out;
}
