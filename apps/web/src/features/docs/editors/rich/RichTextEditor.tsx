import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension, type Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { motion } from 'motion/react';
import type * as Y from 'yjs';
import { YDOC_FIELD, type DocumentAiAction, type DocumentOutlineItem } from '@srh/shared';
import { Skeleton, toast } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import type { DocEditorProps } from '../types';
import { contentExtensions } from './extensions';
import { renderCaret, renderSelection } from './ext/caret';
import { SlashCommand, createSlashBridge } from './ext/slash';
import { AiSession, createAiBridge, flashTr, unflashTr } from './ext/ai-session';
import { MentionSuggest, createMentionBridge } from './ext/mention-suggest';
import { Slot } from './ext/slot';
import { collectHeadings, extractOutline, sameOutline } from './lib/outline';
import { countWords } from './lib/text';
import { useRichAi } from './ai/useRichAi';
import { Toolbar } from './components/Toolbar';
import { BubbleToolbar } from './components/BubbleToolbar';
import { SlashMenu } from './components/SlashMenu';
import { MentionMenu } from './components/MentionMenu';
import { AiPanel } from './components/AiPanel';
import { MathPopover, type MathTarget } from './components/MathPopover';
import { StatusBar } from './components/StatusBar';
import { coordsAt, type AnchorRect } from './components/anchor';
import { insertEmbed, type SlashContext } from './commands';
import { RichEnvContext, type RichEnv } from './context';
import { MediaUpload, pickFiles, uploadFiles } from './media/upload-plugin';
import { DocPicker, type EmbedKind } from './embed/DocPicker';
import { CommentHighlights, createCommentBridge } from './comments/plugin';
import { useComments, useWideLayout } from './comments/useComments';
import { CommentsPanel } from './comments/CommentsPanel';
import { Pagination } from './word/pagination';
import { SearchReplace } from './word/search';
import { FormatPainter } from './word/format-painter';
import { FindReplace } from './components/ribbon/FindReplace';
import { useWordFeatures } from './components/ribbon/useWordFeatures';
import { FootnoteList } from './nodes/FootnoteList';
import { cn } from '@/lib/cn';
import 'katex/dist/katex.min.css';
import './rich.css';
import { tr } from '@/lib/i18n';

const PLACEHOLDER = tr('输入 / 唤起菜单，按空格让 AI 帮你写');
const OUTLINE_DEBOUNCE = 300;
const JUMP_FLASH_MS = 1200;

/**
 * 富文本协同编辑器（飞书 / 腾讯文档式，内嵌 AI）。
 * 正文 = Y.Doc 的 XmlFragment('default')；等首次同步完成后才创建编辑器（之前显示骨架），
 * 避免空文档的默认段落先写进 Y.Doc、和服务端内容合并出多余的空行。
 * 另有：图片 / 附件上传、@成员、内嵌表格 / 幻灯片 / 文档、行内评论（右侧栏）。
 */
export function RichTextEditor(props: DocEditorProps) {
  const { collab } = props;
  // 同步过一次就一直显示编辑器（断线重连时 synced 可能短暂变回 false）
  const [syncedDoc, setSyncedDoc] = useState<Y.Doc | null>(collab.synced ? collab.doc : null);
  if (collab.synced && syncedDoc !== collab.doc) setSyncedDoc(collab.doc);
  const ready = syncedDoc === collab.doc;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ready ? <RichEditorBody key={collab.doc.guid} {...props} /> : <EditorSkeleton />}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-label={tr('正在加载文档')}>
      <div className="h-11 shrink-0 border-b border-line" />
      <div className="mx-auto w-full max-w-(--doc-max) px-4 py-8 sm:px-8">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-2/5" />
          <Skeleton className="w-full" />
          <Skeleton className="w-11/12" />
          <Skeleton className="w-4/5" />
          <Skeleton className="mt-4 h-5 w-1/3" />
          <Skeleton className="w-full" />
          <Skeleton className="w-3/4" />
        </div>
      </div>
    </div>
  );
}

interface Bridges {
  slash: ReturnType<typeof createSlashBridge>;
  ai: ReturnType<typeof createAiBridge>;
  mathClick: Slot<(node: PMNode, pos: number, kind: 'inline' | 'block') => void>;
  mention: ReturnType<typeof createMentionBridge>;
  comment: ReturnType<typeof createCommentBridge>;
  /** Mod-Alt-m：对选区发起评论 */
  startComment: Slot<() => boolean>;
  /** Mod-f / Mod-h：查找 / 替换 */
  find: Slot<(replace: boolean) => boolean>;
}

function createBridges(): Bridges {
  return {
    slash: createSlashBridge(),
    ai: createAiBridge(),
    mathClick: new Slot(),
    mention: createMentionBridge(),
    comment: createCommentBridge(),
    startComment: new Slot(),
    find: new Slot(),
  };
}

const FindShortcut = Extension.create<{ bridge: Slot<(replace: boolean) => boolean> }>({
  name: 'richFindShortcut',
  addOptions() {
    return { bridge: new Slot() };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-f': () => this.options.bridge.get()?.(false) ?? false,
      'Mod-h': () => this.options.bridge.get()?.(true) ?? false,
    };
  },
});

const CommentShortcut = Extension.create<{ bridge: Slot<() => boolean> }>({
  name: 'richCommentShortcut',
  addOptions() {
    return { bridge: new Slot() };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Alt-m': () => this.options.bridge.get()?.() ?? false };
  },
});

function RichEditorBody({
  projectId,
  docId,
  meta,
  collab,
  editable,
  canComment = editable,
  onOutline,
  jumpTo,
}: DocEditorProps) {
  const [bridges] = useState(createBridges);
  const { doc, provider, me } = collab;
  const [user] = useState(() => ({ ...me }));

  const editor = useEditor(
    {
      extensions: [
        ...contentExtensions({
          onMathClick: (node, pos, kind) => bridges.mathClick.get()?.(node, pos, kind),
        }),
        Collaboration.configure({ document: doc, field: YDOC_FIELD.doc }),
        CollaborationCaret.configure({
          provider,
          user,
          render: renderCaret,
          selectionRender: renderSelection,
        }),
        Placeholder.configure({
          showOnlyCurrent: true,
          placeholder: ({ node }) => {
            if (node.type.name === 'paragraph') return PLACEHOLDER;
            if (node.type.name === 'heading')
              return tr('标题 {value}', { value: String(node.attrs.level ?? '') });
            return '';
          },
        }),
        CharacterCount.configure({ wordCounter: countWords }),
        SlashCommand.configure({ bridge: bridges.slash }),
        AiSession.configure({ bridge: bridges.ai }),
        MentionSuggest.configure({ bridge: bridges.mention }),
        CommentHighlights.configure({ bridge: bridges.comment }),
        CommentShortcut.configure({ bridge: bridges.startComment }),
        MediaUpload.configure({ projectId }),
        Pagination,
        SearchReplace,
        FormatPainter,
        FindShortcut.configure({ bridge: bridges.find }),
      ],
      editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'rich-prose',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': tr('文档正文'),
        },
      },
    },
    [doc, provider],
  );

  return (
    <EditorShell
      editor={editor}
      bridges={bridges}
      projectId={projectId}
      docId={docId}
      title={meta.title}
      ydoc={doc}
      editable={editable}
      canComment={canComment}
      peers={collab.peers}
      onOutline={onOutline}
      jumpTo={jumpTo}
    />
  );
}

interface ShellProps {
  editor: Editor;
  bridges: Bridges;
  projectId: string;
  docId: string;
  title: string;
  ydoc: Y.Doc;
  editable: boolean;
  canComment: boolean;
  peers: DocEditorProps['collab']['peers'];
  onOutline: DocEditorProps['onOutline'];
  jumpTo: DocEditorProps['jumpTo'];
}

function EditorShell({
  editor,
  bridges,
  projectId,
  docId,
  title,
  ydoc,
  editable,
  canComment,
  peers,
  onOutline,
  jumpTo,
}: ShellProps) {
  const { measure: measurePane, ...word } = useWordFeatures({
    editor,
    findSlot: bridges.find,
    ydoc,
    projectId,
    docId,
    title,
  });
  const hostRef = useRef<HTMLDivElement>(null);
  const { variants, reduced } = useMotionPreset();
  const ai = useRichAi(editor, bridges.ai, projectId, docId);
  const [math, setMath] = useState<MathTarget | null>(null);
  const [words, setWords] = useState(() => countWords(editor.state.doc.textContent));
  const [chars, setChars] = useState(0);
  const env = useMemo<RichEnv>(
    () => ({ projectId, docId, editable }),
    [projectId, docId, editable],
  );
  const comments = useComments(editor, bridges.comment, projectId, docId);
  const wide = useWideLayout();
  const [picker, setPicker] = useState<{ kind: EmbedKind; createFirst: boolean } | null>(null);

  // 只读 / 可编辑
  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // 点击公式：编辑 latex
  useEffect(() => {
    bridges.mathClick.set((node, pos, kind) => {
      if (!editor.isEditable) return;
      const dom = editor.view.nodeDOM(pos);
      const rect: AnchorRect =
        dom instanceof HTMLElement ? dom.getBoundingClientRect() : coordsAt(editor.view, pos);
      setMath({
        mode: 'edit',
        kind,
        pos,
        latex: String(node.attrs.latex ?? ''),
        anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      });
    });
    return () => bridges.mathClick.set(null);
  }, [bridges, editor]);

  // 评论：选中文字后 Mod-Alt-m / 气泡菜单“评论”
  const { startDraft } = comments;
  const startComment = useCallback(() => {
    if (!editor.isEditable && !canComment) return false;
    const ok = startDraft();
    if (!ok) toast({ title: tr('先选中一段文字再评论'), tone: 'info' });
    return true;
  }, [editor, startDraft, canComment]);
  useEffect(() => {
    bridges.startComment.set(startComment);
    return () => bridges.startComment.set(null);
  }, [bridges, startComment]);

  // 大纲 + 字数：内容变化后防抖 300ms
  const onOutlineRef = useRef(onOutline);
  useEffect(() => {
    onOutlineRef.current = onOutline;
  });
  useEffect(() => {
    let timer = 0;
    let last: DocumentOutlineItem[] | null = null;
    const flush = () => {
      if (editor.isDestroyed) return;
      const items = extractOutline(editor.state.doc);
      if (!last || !sameOutline(last, items)) {
        last = items;
        onOutlineRef.current?.(items);
      }
      setWords(editor.storage.characterCount.words());
      setChars(editor.state.doc.textContent.replace(/\s/gu, '').length);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, OUTLINE_DEBOUNCE);
    };
    timer = window.setTimeout(flush, 0);
    editor.on('update', schedule);
    return () => {
      window.clearTimeout(timer);
      editor.off('update', schedule);
    };
  }, [editor]);

  // 大纲跳转：滚到第 index 个标题并短暂高亮
  const jumpNonce = jumpTo?.nonce;
  const jumpIndex = jumpTo?.index;
  useEffect(() => {
    if (jumpNonce === undefined || jumpIndex === undefined || editor.isDestroyed) return;
    const target = collectHeadings(editor.state.doc)[jumpIndex];
    if (!target) return;
    const node = editor.state.doc.nodeAt(target.pos);
    if (!node) return;
    const dom = editor.view.nodeDOM(target.pos);
    if (dom instanceof HTMLElement && typeof dom.scrollIntoView === 'function') {
      dom.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    }
    const tr = editor.state.tr;
    const id = flashTr(tr, target.pos, target.pos + node.nodeSize, 'rich-jump-flash');
    editor.view.dispatch(tr);
    const t = window.setTimeout(() => {
      if (!editor.isDestroyed) editor.view.dispatch(unflashTr(editor.state, id));
    }, JUMP_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [editor, jumpNonce, jumpIndex, reduced]);

  const openMathInsert = useCallback(
    (kind: 'inline' | 'block') => {
      if (!editor.isEditable) return;
      const anchor = coordsAt(editor.view, editor.state.selection.from);
      setMath({ mode: 'insert', kind, pos: null, latex: '', anchor });
    },
    [editor],
  );

  const pickMedia = useCallback(
    (kind: 'image' | 'attachment') => {
      if (!editor.isEditable) return;
      const at = editor.state.selection.from;
      void pickFiles(kind === 'image' ? 'image/*' : '*/*').then((files) => {
        if (files.length && !editor.isDestroyed) {
          uploadFiles(editor, projectId, files, at, kind === 'attachment');
        }
      });
    },
    [editor, projectId],
  );

  // 打开“嵌入”选择框时记下光标位置（对话框会拿走焦点）
  const embedAt = useRef(0);
  const openEmbed = useCallback(
    (kind: EmbedKind, createFirst = false) => {
      if (!editor.isEditable) return;
      embedAt.current = editor.state.selection.from;
      setPicker({ kind, createFirst });
    },
    [editor],
  );

  const { open: openAi } = ai;
  const slashCtx = useMemo<SlashContext>(
    () => ({
      openMath: openMathInsert,
      startAi: (action: DocumentAiAction) => openAi(action),
      pickMedia,
      openEmbed,
    }),
    [openMathInsert, openAi, pickMedia, openEmbed],
  );

  const commentToggle = {
    open: comments.open,
    count: comments.openCount,
    toggle: () => {
      comments.setOpen(!comments.open);
      if (comments.open) comments.setDraft(null);
    },
  };

  return (
    <RichEnvContext.Provider value={env}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={measurePane}
            className={cn(
              'group/doc relative min-h-0 min-w-0 flex-1 overflow-y-auto',
              word.paged && 'bg-subtle',
            )}
          >
            {editable && (
              // 手机上先是阅读视图：点进正文开始编辑时才出现格式工具栏，不占读文档的首屏
              <div className="contents max-md:hidden max-md:group-focus-within/doc:contents">
                <Toolbar
                  editor={editor}
                  onAi={() => openAi()}
                  onMath={openMathInsert}
                  onMedia={pickMedia}
                  onEmbed={openEmbed}
                  comments={commentToggle}
                  word={word.controls}
                />
              </div>
            )}
            <motion.div
              variants={variants.fadeIn}
              initial="hidden"
              animate="visible"
              className={
                word.paged
                  ? 'rich-paged flex w-full justify-center px-4 pt-6 pb-16'
                  : 'mx-auto w-full max-w-(--doc-max) px-4 pt-8 pb-16 sm:px-8'
              }
              style={word.pagedStyle}
            >
              <div ref={hostRef} className="relative">
                <EditorContent editor={editor} />
                <FootnoteList editor={editor} />
                {editable && (
                  <AiPanel editor={editor} bridge={bridges.ai} ai={ai} hostRef={hostRef} />
                )}
              </div>
            </motion.div>
            {editable && (
              <>
                <BubbleToolbar
                  editor={editor}
                  onAi={(action) => openAi(action)}
                  onComment={() => void startComment()}
                />
                <SlashMenu editor={editor} bridge={bridges.slash} ctx={slashCtx} />
                <MentionMenu
                  editor={editor}
                  bridge={bridges.mention}
                  projectId={projectId}
                  docId={docId}
                />
              </>
            )}
            {!editable && canComment && (
              // 可评论的只读文档：选中文字只弹「评论」
              <BubbleToolbar
                editor={editor}
                commentOnly
                onAi={() => undefined}
                onComment={() => void startComment()}
              />
            )}
            {math && (
              <MathPopover
                key={`${math.mode}:${math.pos ?? 'new'}`}
                editor={editor}
                target={math}
                onClose={() => setMath(null)}
              />
            )}
          </div>
          {word.find && (
            <div className={cn('absolute right-3 z-sticky', editable ? 'top-[5.5rem]' : 'top-3')}>
              <FindReplace
                key={word.find.nonce}
                editor={editor}
                withReplace={word.find.replace}
                onClose={word.closeFind}
              />
            </div>
          )}
          <CommentsPanel
            ctl={comments}
            projectId={projectId}
            docId={docId}
            canComment={canComment}
            wide={wide}
          />
        </div>
        <StatusBar
          words={words}
          chars={chars}
          pages={word.pageCount}
          peers={peers}
          editable={editable}
          comments={commentToggle}
        />
        {word.dialogs}
        {editable && (
          <DocPicker
            open={picker !== null}
            onOpenChange={(o) => {
              if (!o) setPicker(null);
            }}
            projectId={projectId}
            docId={docId}
            kind={picker?.kind ?? 'sheet'}
            createFirst={picker?.createFirst ?? false}
            onPick={(d) => {
              if (editor.isDestroyed) return;
              const pos = Math.min(embedAt.current, editor.state.doc.content.size);
              insertEmbed(editor, { id: d.id, kind: d.kind, title: d.title }, pos);
            }}
          />
        )}
      </div>
    </RichEnvContext.Provider>
  );
}
