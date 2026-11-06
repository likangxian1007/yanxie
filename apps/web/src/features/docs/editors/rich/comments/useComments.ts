import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import type { DocCommentAnchor } from '@srh/shared';
import { useDocComments } from './api';
import { encodeAnchor, groupThreads, quoteOf, sortThreads, type AnchorRange } from './anchor';
import {
  PENDING_COMMENT_ID,
  commentKey,
  setActiveComment,
  setCommentAnchors,
  type CommentBridge,
} from './plugin';

export interface CommentDraft {
  anchor: DocCommentAnchor;
  quote: string;
}

const WIDE_QUERY = '(min-width: 1024px)';

/** ≥1024px 时评论在右侧栏，否则用抽屉 */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(WIDE_QUERY);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY).matches : true),
    () => true,
  );
}

const EMPTY_RANGES: ReadonlyMap<string, AnchorRange | null> = new Map();

/**
 * 行内评论的状态中枢：拉取评论、把锚点交给高亮插件、侧栏开关、当前评论串、新建草稿、
 * `?comment=<id>` 深链接（收件箱点进来直接定位）。
 */
export function useComments(
  editor: Editor,
  bridge: CommentBridge,
  projectId: string,
  docId: string,
) {
  const query = useDocComments(projectId, docId);
  const threads = useMemo(() => groupThreads(query.data ?? []), [query.data]);
  const [open, setOpen] = useState(false);
  const [active, setActiveState] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');

  const ranges = useEditorState({
    editor,
    selector: ({ editor: e }) => commentKey.getState(e.state)?.ranges ?? EMPTY_RANGES,
  });

  // 锚点交给插件：未解决的串、在“已解决”里正在查看的那串、新建草稿。
  // 别人解决了我正选中的评论 → 高亮照样消失（飞书同款）
  const activeResolved =
    open && filter === 'resolved'
      ? threads.find((t) => t.root.id === active && t.root.resolved)
      : undefined;
  useEffect(() => {
    if (editor.isDestroyed) return;
    const items = threads
      .filter((t) => !t.root.resolved || t === activeResolved)
      .map((t) => ({ id: t.root.id, anchor: t.root.anchor }));
    if (draft) items.push({ id: PENDING_COMMENT_ID, anchor: draft.anchor });
    editor.view.dispatch(setCommentAnchors(editor.state, items));
  }, [editor, threads, draft, activeResolved]);

  useEffect(() => {
    if (!editor.isDestroyed) editor.view.dispatch(setActiveComment(editor.state, active));
  }, [editor, active]);

  const scrollTo = useCallback(
    (id: string) => {
      const r = commentKey.getState(editor.state)?.ranges.get(id);
      if (!r) return;
      try {
        const { node } = editor.view.domAtPos(r.from);
        const el = node instanceof HTMLElement ? node : node.parentElement;
        el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      } catch {
        // 位置暂时不可用（文档正在同步）
      }
    },
    [editor],
  );

  const activate = useCallback(
    (id: string | null, scroll = true) => {
      setActiveState(id);
      if (id) {
        const t = threads.find((x) => x.root.id === id);
        if (t) setFilter(t.root.resolved ? 'resolved' : 'open');
        if (scroll) requestAnimationFrame(() => scrollTo(id));
      }
    },
    [threads, scrollTo],
  );

  // 点正文里的高亮 → 打开侧栏并定位
  useEffect(() => {
    bridge.onClick.set((id) => {
      setOpen(true);
      activate(id, false);
    });
    return () => bridge.onClick.set(null);
  }, [bridge, activate]);

  // 深链接 ?comment=<id>
  const [params, setParams] = useSearchParams();
  const linked = params.get('comment');
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!linked || handledLink.current === linked || !query.data) return;
    handledLink.current = linked;
    const t = threads.find((x) => x.root.id === linked || x.replies.some((r) => r.id === linked));
    if (t) {
      // 等编辑器把锚点解析出来再滚
      window.setTimeout(() => {
        setOpen(true);
        activate(t.root.id);
      }, 50);
    }
    const next = new URLSearchParams(params);
    next.delete('comment');
    setParams(next, { replace: true });
  }, [linked, query.data, threads, activate, params, setParams]);

  /** 对当前选区新建评论（返回 false = 选区不能评论） */
  const startDraft = useCallback((): boolean => {
    const { from, to, empty } = editor.state.selection;
    if (empty) return false;
    const anchor = encodeAnchor(editor.state, from, to);
    if (!anchor) return false;
    setDraft({ anchor, quote: quoteOf(editor.state.doc, from, to) });
    setFilter('open');
    setActiveState(null);
    setOpen(true);
    return true;
  }, [editor]);

  const sorted = useMemo(() => sortThreads(threads, ranges), [threads, ranges]);
  const openCount = threads.filter((t) => !t.root.resolved).length;

  return {
    query,
    threads: sorted,
    ranges,
    open,
    setOpen,
    active,
    activate,
    draft,
    setDraft,
    startDraft,
    filter,
    setFilter,
    openCount,
  };
}

export type CommentsController = ReturnType<typeof useComments>;
