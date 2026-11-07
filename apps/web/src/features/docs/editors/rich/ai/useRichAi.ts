import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { DocumentAiAction, DocumentAiInput } from '@srh/shared';
import { useDocAi } from '../../../ai/useDocAi';
import {
  closeAiSessionTr,
  openAiSessionTr,
  readAiSession,
  unflashTr,
  type AiBridge,
} from '../ext/ai-session';
import { markdownToHtml } from '../lib/markdown';

export type AiPhase = 'prompt' | 'result';

export interface AiRequest {
  action: DocumentAiAction;
  prompt: string;
  selection: string;
}

export interface AiSessionView {
  phase: AiPhase;
  request: AiRequest | null;
  /** 打开时有选中文字（改写类动作的目标） */
  hasTarget: boolean;
  selection: string;
}

/** 改写类动作：结果替换选区 */
export const REWRITE_ACTIONS: readonly DocumentAiAction[] = [
  'polish',
  'shorten',
  'expand',
  'academic',
  'translate_en',
  'translate_zh',
  'custom',
];

const FLASH_MS = 1200;
/** 续写时把光标前这么多字作为 selection 发给服务端（告诉它从哪里接着写） */
const CONTINUE_CONTEXT = 1500;

export interface InsertPlan {
  range: { from: number; to: number };
  preferInline: boolean;
}

/**
 * 决定结果插到哪：
 * - replace 且有目标选区：替换选区；选区在同一个文本块里时按行内内容插入（不劈开段落）；
 * - 否则插到锚点（目标所在顶层块之后）；锚点前是空段落（空行按空格唤起）时替换这个空段落。
 */
export function planInsert(
  editor: Editor,
  mode: 'replace' | 'below',
  session: { from: number; to: number; anchor: number },
): InsertPlan {
  const doc = editor.state.doc;
  const size = doc.content.size;
  const from = Math.min(session.from, size);
  const to = Math.min(session.to, size);
  if (mode === 'replace' && to > from) {
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    return { range: { from, to }, preferInline: $from.sameParent($to) && $from.parent.isTextblock };
  }
  const anchor = Math.min(session.anchor, size);
  const before = doc.resolve(anchor).nodeBefore;
  if (before && before.type.name === 'paragraph' && before.content.size === 0) {
    return { range: { from: anchor - before.nodeSize, to: anchor }, preferInline: false };
  }
  return { range: { from: anchor, to: anchor }, preferInline: false };
}

/**
 * 富文本编辑器的内嵌 AI 会话：打开（输入条 / 直接执行动作）→ 流式预览 → 替换 / 插入 / 重试 / 丢弃。
 * 生成过程中只在本地预览，确认后一次性写进文档（一个事务 = 一次 Yjs 更新 = 一步撤销）。
 */
export function useRichAi(editor: Editor, bridge: AiBridge, projectId: string, docId: string) {
  const ai = useDocAi(projectId, docId);
  const [session, setSession] = useState<AiSessionView | null>(null);
  const timers = useRef<number[]>([]);
  const { run, stop, reset } = ai;

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );

  const execute = useCallback(
    (request: AiRequest) => {
      const input: DocumentAiInput = request;
      void run(input);
    },
    [run],
  );

  const open = useCallback(
    (action?: DocumentAiAction, prompt = '') => {
      if (!editor.isEditable || editor.isDestroyed) return;
      stop();
      reset();
      const { state } = editor;
      const { from, to, empty } = state.selection;
      const selection = empty ? '' : state.doc.textBetween(from, to, '\n\n', ' ').trim();
      const hasTarget = selection.length > 0;
      editor.view.dispatch(openAiSessionTr(state, hasTarget ? { from, to } : { from, to: from }));
      if (!action) {
        setSession({ phase: 'prompt', request: null, hasTarget, selection });
        return;
      }
      let context = selection;
      if (action === 'continue' && !hasTarget) {
        const start = Math.max(0, from - CONTINUE_CONTEXT * 2);
        context = state.doc.textBetween(start, from, '\n\n', ' ').slice(-CONTINUE_CONTEXT);
      }
      const request: AiRequest = { action, prompt, selection: context };
      setSession({ phase: 'result', request, hasTarget, selection });
      execute(request);
    },
    [editor, execute, reset, stop],
  );

  const submit = useCallback(
    (action: DocumentAiAction, prompt = '') => {
      if (!session) return;
      let context = session.selection;
      if (action === 'continue' && !session.hasTarget) {
        const from = Math.min(readAiSession(editor.state).from, editor.state.doc.content.size);
        const start = Math.max(0, from - CONTINUE_CONTEXT * 2);
        context = editor.state.doc.textBetween(start, from, '\n\n', ' ').slice(-CONTINUE_CONTEXT);
      }
      const request: AiRequest = { action, prompt, selection: context };
      setSession({ ...session, phase: 'result', request });
      execute(request);
    },
    [editor, execute, session],
  );

  const retry = useCallback(() => {
    if (session?.request) execute(session.request);
  }, [execute, session]);

  const close = useCallback(() => {
    stop();
    reset();
    setSession(null);
    if (!editor.isDestroyed) {
      const tr = editor.state.tr;
      closeAiSessionTr(tr);
      editor.view.dispatch(tr);
    }
  }, [editor, reset, stop]);

  const discard = useCallback(() => {
    close();
    if (!editor.isDestroyed) editor.commands.focus();
  }, [close, editor]);

  const accept = useCallback(
    (mode: 'replace' | 'below') => {
      const text = ai.text;
      if (!text.trim() || editor.isDestroyed) return;
      const info = readAiSession(editor.state);
      const plan = planInsert(editor, mode, info);
      const { html } = markdownToHtml(text, plan.preferInline);
      if (!html) return;
      const sizeBefore = editor.state.doc.content.size;
      let flashId: number | null = null;
      editor
        .chain()
        .focus()
        .insertContentAt(plan.range, html, {
          updateSelection: true,
          parseOptions: { preserveWhitespace: false },
        })
        .command(({ tr }) => {
          const delta = tr.doc.content.size - sizeBefore;
          const end = plan.range.to + delta;
          flashId = closeAiSessionTr(tr, {
            from: plan.range.from,
            to: Math.max(plan.range.from, end),
            className: 'rich-ai-flash',
          });
          return true;
        })
        .run();
      stop();
      reset();
      setSession(null);
      if (flashId !== null) {
        const id = flashId;
        const t = window.setTimeout(() => {
          if (!editor.isDestroyed) editor.view.dispatch(unflashTr(editor.state, id));
        }, FLASH_MS);
        timers.current.push(t);
      }
    },
    [ai.text, editor, reset, stop],
  );

  // 编辑器里按空格 / Mod-J 唤起，Esc 丢弃
  useEffect(() => {
    bridge.onTrigger.set(() => open());
    bridge.onEscape.set(() => discard());
    return () => {
      bridge.onTrigger.set(null);
      bridge.onEscape.set(null);
    };
  }, [bridge, discard, open]);

  return {
    session,
    status: ai.status,
    text: ai.text,
    error: ai.error,
    route: ai.route,
    open,
    submit,
    retry,
    stop,
    discard,
    accept,
  };
}

export type RichAi = ReturnType<typeof useRichAi>;
