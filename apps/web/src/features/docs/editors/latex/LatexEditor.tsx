import '@fontsource-variable/jetbrains-mono';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence } from 'motion/react';
import { Compartment } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import * as Y from 'yjs';
import { LATEX_MAIN_FILE, YDOC_FIELD, type DocumentAiInput } from '@srh/shared';
import { toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useDocAi } from '../../ai/useDocAi';
import { downloadBlob, safeFileName } from '../shared/dom';
import type { DocEditorProps } from '../types';
import { assetUrl, uploadAsset } from './compile/api';
import { fromDraftWarning, fromTexIssue, type LatexIssue } from './compile/issues';
import { PreviewPane, type PreviewKind } from './compile/PdfPane';
import { useLatexCompile } from './compile/useLatexCompile';
import { checkLatexReplacement, fixRangeFor, type ReplaceCheck } from './ai/fixGuard';
import { AiPromptDialog, type AiPromptMode } from './components/AiPromptDialog';
import { FileBar } from './components/FileBar';
import { LatexAiCard, type LatexAiPhase, type LatexAiTask } from './components/LatexAiCard';
import { LatexToolbar, type LatexAiAction } from './components/LatexToolbar';
import { keepColorLight } from './editor/awareness';
import { createLatexExtensions, flashLineEffect, readOnlyExtension } from './editor/setup';
import {
  buildBlockInsert,
  buildSnippetEdit,
  buildWrapEdit,
  getSnippet,
  stripCodeFence,
  type SnippetId,
  type TextEdit,
  type WrapCommand,
} from './editor/snippets';
import { downloadTex, printPreview } from './exportLatex';
import {
  clampSplit,
  ratioFromPointer,
  useNarrow,
  useSplitRatio,
  useViewMode,
  type LatexViewMode,
} from './layout';
import { LatexPreview } from './preview/LatexPreview';
import { lineToTop, topToLine, type Anchor } from './preview/scrollSync';
import { useLatexRender } from './preview/useLatexRender';
import { addAsset, fileMode, filesMap, textOf } from './project/files';
import { useProjectFiles } from './project/useProjectFiles';
import { sanitizeLatexHtml } from './render/sanitize';
import 'katex/dist/katex.min.css';
import './latex.css';
import { tr } from '@/lib/i18n';

const AI_TITLE: Record<LatexAiAction, string> = {
  academic: tr('润色'),
  translate_en: tr('译成英文'),
  latex_fix: tr('修复这段'),
  custom: tr('按指令改'),
};

const MAX_SELECTION = 50000;
const FIX_CONTEXT_LINES = 15;
const PREVIEW_KIND_KEY = 'srh:latex:preview-kind';

function readPreviewKind(): PreviewKind {
  try {
    return window.localStorage.getItem(PREVIEW_KIND_KEY) === 'draft' ? 'draft' : 'pdf';
  } catch {
    return 'pdf';
  }
}

interface AiSession {
  task: LatexAiTask;
  kind: 'selection' | 'section' | 'fix';
  input: DocumentAiInput;
}

interface TrackedRange {
  from: number;
  to: number;
  original: string;
}

/** 一次 AI 生成的结果状态（不依赖 useDocAi 的 status，避免旧请求中止时把新请求标成已完成） */
interface AiRun {
  id: number;
  phase: LatexAiPhase;
  /** 生成结束时对替换做的结构校验 */
  check: ReplaceCheck | null;
  /** 生成结束时要被替换的原文和起始行号（显示差异用） */
  original: { text: string; startLine: number } | null;
}

/** 应用 AI 修改后等待的那次重新编译 */
interface Recheck {
  before: number | null;
  prev: unknown;
  skip: number;
}

/**
 * 协同 LaTeX 论文编辑器（类 Overleaf / Prism）：
 * 左边文件栏 + CodeMirror 源码（yCollab 实时协同、远程光标；main.tex、references.bib 等工程文件），
 * 右边是服务端真编译的 PDF（tectonic / XeTeX + BibTeX），或纯前端转换的即时草稿预览；
 * 工具栏提供编译、插入片段、AI 改写 / 写小节 / 修复、编译问题列表和导出。
 */
export function LatexEditor({
  projectId,
  docId,
  meta,
  collab,
  editable,
  onOutline,
  jumpTo,
}: DocEditorProps) {
  const { doc, provider } = collab;
  const ytext = useMemo(() => doc.getText(YDOC_FIELD.latex), [doc]);
  const auxFiles = useMemo(() => filesMap(doc), [doc]);
  const awareness = provider.awareness;
  const ai = useDocAi(projectId, docId);
  const { result, pending } = useLatexRender(ytext, auxFiles);

  // 工程文件：当前在编辑哪个文件（main.tex / references.bib …）
  const files = useProjectFiles(doc);
  const [activeRaw, setActive] = useState<string>(LATEX_MAIN_FILE);
  // files 变化（协作者删除 / 改名）时重新判断：文件不在了就回到 main.tex
  const active = useMemo(
    () => (files.length > 0 && textOf(doc, activeRaw) ? activeRaw : LATEX_MAIN_FILE),
    [doc, files, activeRaw],
  );
  const activeText = useMemo(() => textOf(doc, active) ?? ytext, [doc, active, ytext]);
  const isMain = active === LATEX_MAIN_FILE;
  const projectFileNames = useMemo(() => files.map((f) => f.name), [files]);

  const [view, setView] = useViewMode();
  const narrow = useNarrow();
  const mode: LatexViewMode = narrow ? (view === 'preview' ? 'preview' : 'source') : view;
  const split = useSplitRatio();
  const [previewKind, setPreviewKindState] = useState<PreviewKind>(readPreviewKind);
  const setPreviewKind = useCallback((k: PreviewKind) => {
    setPreviewKindState(k);
    try {
      window.localStorage.setItem(PREVIEW_KIND_KEY, k);
    } catch {
      // 忽略
    }
  }, []);
  const compile = useLatexCompile({
    projectId,
    docId,
    doc,
    provider,
    projectFiles: projectFileNames,
    enabled: mode !== 'source' && previewKind === 'pdf',
  });
  const pdfShown = compile.available && previewKind === 'pdf';

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const umRef = useRef<Y.UndoManager | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const readOnlyRef = useRef(new Compartment());
  const editableRef = useRef(editable);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });
  const [hasSelection, setHasSelection] = useState(false);
  const [session, setSession] = useState<AiSession | null>(null);
  const [aiRun, setAiRun] = useState<AiRun>({ id: 0, phase: 'done', check: null, original: null });
  const runIdRef = useRef(0);
  const stoppedRef = useRef(false);
  const recheckRef = useRef<Recheck | null>(null);
  const [promptMode, setPromptMode] = useState<AiPromptMode | null>(null);
  const [promptLines, setPromptLines] = useState(0);
  const aiRangeRef = useRef<TrackedRange | null>(null);
  const pendingSelRef = useRef<TrackedRange | null>(null);
  const resultRef = useRef(result);
  const modeRef = useRef(mode);
  const activeRef = useRef(active);
  const syncableRef = useRef(true);
  /** 切换文件后、编辑器重建完要做的事（跳行、AI 修复） */
  const afterSwitchRef = useRef<(() => void) | null>(null);
  const anchorsRef = useRef<Anchor[] | null>(null);
  const lockRef = useRef<{ src: 'editor' | 'preview'; until: number } | null>(null);
  const flashTimer = useRef<number | null>(null);
  const handlersRef = useRef<{ wrap: (cmd: WrapCommand) => void; sync: (src: 'editor') => void }>({
    wrap: () => undefined,
    sync: () => undefined,
  });

  useEffect(() => {
    resultRef.current = result;
    modeRef.current = mode;
    editableRef.current = editable;
    activeRef.current = active;
    // 只有主文件 + 草稿预览时才能按行同步滚动
    syncableRef.current = isMain && !pdfShown;
  });

  // ------------------------------------------------------------ CodeMirror 实例（每个文件一个）

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const um = new Y.UndoManager(activeText, { trackedOrigins: new Set(), captureTimeout: 400 });
    umRef.current = um;
    const syncUndo = () =>
      setUndoState({ canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 });
    um.on('stack-item-added', syncUndo);
    um.on('stack-item-popped', syncUndo);
    um.on('stack-cleared', syncUndo);

    let lastHasSel = false;
    const onUpdate = (u: ViewUpdate) => {
      if (u.docChanged) {
        const r = aiRangeRef.current;
        if (r) {
          aiRangeRef.current = {
            from: u.changes.mapPos(r.from, 1),
            to: u.changes.mapPos(r.to, -1),
            original: r.original,
          };
        }
        const p = pendingSelRef.current;
        if (p) {
          pendingSelRef.current = {
            from: u.changes.mapPos(p.from, 1),
            to: u.changes.mapPos(p.to, -1),
            original: p.original,
          };
        }
        anchorsRef.current = null;
      }
      if (u.selectionSet || u.docChanged) {
        const has = !u.state.selection.main.empty;
        if (has !== lastHasSel) {
          lastHasSel = has;
          setHasSelection(has);
        }
      }
    };

    const wrapKey = (cmd: WrapCommand) => () => {
      if (!editableRef.current) return false;
      handlersRef.current.wrap(cmd);
      return true;
    };

    const cm = new EditorView({
      parent: host,
      doc: activeText.toString(),
      extensions: createLatexExtensions({
        ytext: activeText,
        awareness: awareness as NonNullable<typeof awareness>,
        undoManager: um,
        readOnly: readOnlyRef.current,
        editable: editableRef.current,
        extraKeys: [
          { key: 'Mod-b', run: wrapKey('textbf') },
          { key: 'Mod-i', run: wrapKey('textit') },
        ],
        onUpdate,
      }),
    });
    viewRef.current = cm;
    const onScroll = () => handlersRef.current.sync('editor');
    cm.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    syncUndo();
    setHasSelection(false);
    const after = afterSwitchRef.current;
    afterSwitchRef.current = null;
    if (after) window.requestAnimationFrame(after);

    return () => {
      cm.scrollDOM.removeEventListener('scroll', onScroll);
      cm.destroy();
      if (viewRef.current === cm) viewRef.current = null;
      um.off('stack-item-added', syncUndo);
      um.off('stack-item-popped', syncUndo);
      um.off('stack-cleared', syncUndo);
      um.destroy();
      if (umRef.current === um) umRef.current = null;
    };
  }, [activeText, awareness]);

  // 只读切换
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyRef.current.reconfigure(readOnlyExtension(editable)),
    });
  }, [editable]);

  // 远程选区底色：给本地 user 补 colorLight
  useEffect(() => {
    if (!awareness) return;
    return keepColorLight(awareness);
  }, [awareness]);

  // 视图切换后 CodeMirror 需要重新测量
  useEffect(() => {
    anchorsRef.current = null;
    viewRef.current?.requestMeasure();
  }, [mode, split.ratio, pdfShown]);

  /** 切到某个文件；编辑器重建好之后执行 after（同一个文件则立即执行） */
  const selectFile = useCallback(
    (name: string, after?: () => void) => {
      // 直接查 Y.Doc（刚新建的文件可能还没进 files 列表）；不是文本文件就回到 main.tex
      const target = name !== LATEX_MAIN_FILE && textOf(doc, name) ? name : LATEX_MAIN_FILE;
      if (target === activeRef.current) {
        if (after) window.requestAnimationFrame(after);
        return;
      }
      afterSwitchRef.current = after ?? null;
      setActive(target);
    },
    [doc],
  );

  // ------------------------------------------------------------ 大纲与跳转

  const outlineKey = useMemo(() => JSON.stringify(result.outline), [result.outline]);
  const lastOutline = useRef<string | null>(null);
  useEffect(() => {
    if (!onOutline || lastOutline.current === outlineKey) return;
    lastOutline.current = outlineKey;
    onOutline(result.outline);
  }, [onOutline, outlineKey, result.outline]);

  const revealLine = useCallback((line: number, focus: boolean) => {
    const cm = viewRef.current;
    if (!cm) return;
    const total = cm.state.doc.lines;
    const target = cm.state.doc.line(Math.max(1, Math.min(total, Math.round(line))));
    cm.dispatch({
      selection: { anchor: target.from },
      effects: [
        EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 48 }),
        flashLineEffect.of(target.from),
      ],
    });
    if (focus) cm.focus();
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      if (viewRef.current === cm) cm.dispatch({ effects: flashLineEffect.of(null) });
    }, 1600);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  /** 跳到某个文件的某行；当前只显示预览时先切到分栏（窄屏切到源码） */
  const goToLine = useCallback(
    (file: string, line: number) => {
      if (modeRef.current === 'preview') setView('split');
      selectFile(file, () => revealLine(line, true));
    },
    [revealLine, selectFile, setView],
  );

  const jumpToSourceLine = useCallback(
    (line: number) => goToLine(LATEX_MAIN_FILE, line),
    [goToLine],
  );

  useEffect(() => {
    if (!jumpTo) return;
    const section = resultRef.current.sections[jumpTo.index];
    if (!section) return;
    if (modeRef.current !== 'source') {
      const el = previewRef.current?.querySelector<HTMLElement>(
        `[data-anchor="${section.anchor}"]`,
      );
      if (el) {
        lockRef.current = { src: 'preview', until: performance.now() + 600 };
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    selectFile(LATEX_MAIN_FILE, () => revealLine(section.line, false));
    // 只响应新的跳转请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  // ------------------------------------------------------------ 同步滚动

  const getAnchors = useCallback((): Anchor[] => {
    if (anchorsRef.current) return anchorsRef.current;
    const scroller = previewRef.current;
    const list: Anchor[] = [];
    if (scroller) {
      const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
      for (const el of Array.from(scroller.querySelectorAll<HTMLElement>('.ltx-block'))) {
        const line = Number(el.dataset.line);
        if (!Number.isFinite(line)) continue;
        const top = el.getBoundingClientRect().top - scrollerTop - 24;
        const prev = list[list.length - 1];
        if (prev && (line <= prev.line || top < prev.top)) continue;
        list.push({ line, top: Math.max(0, top) });
      }
    }
    anchorsRef.current = list;
    return list;
  }, []);

  const syncScroll = useCallback(
    (src: 'editor' | 'preview') => {
      if (modeRef.current !== 'split' || !syncableRef.current) return;
      const lock = lockRef.current;
      const now = performance.now();
      if (lock && lock.src !== src && now < lock.until) return;
      const cm = viewRef.current;
      const scroller = previewRef.current;
      if (!cm || !scroller) return;
      const sd = cm.scrollDOM;
      const docOffset = cm.documentTop - sd.getBoundingClientRect().top + sd.scrollTop;
      const anchors = getAnchors();
      lockRef.current = { src, until: now + 120 };
      if (src === 'editor') {
        const maxEditor = sd.scrollHeight - sd.clientHeight;
        const maxPreview = scroller.scrollHeight - scroller.clientHeight;
        if (sd.scrollTop <= 1) {
          scroller.scrollTop = 0;
          return;
        }
        if (sd.scrollTop >= maxEditor - 1) {
          scroller.scrollTop = maxPreview;
          return;
        }
        const h = Math.max(0, sd.scrollTop - docOffset);
        const block = cm.lineBlockAtHeight(h);
        const lineNo = cm.state.doc.lineAt(block.from).number;
        const frac =
          block.height > 0 ? Math.min(1, Math.max(0, (h - block.top) / block.height)) : 0;
        scroller.scrollTop = lineToTop(anchors, lineNo + frac, maxPreview);
      } else {
        if (scroller.scrollTop <= 1) {
          sd.scrollTop = 0;
          return;
        }
        const line = topToLine(anchors, scroller.scrollTop);
        const total = cm.state.doc.lines;
        const whole = Math.max(1, Math.min(total, Math.floor(line)));
        const frac = Math.min(1, Math.max(0, line - whole));
        const block = cm.lineBlockAt(cm.state.doc.line(whole).from);
        sd.scrollTop = docOffset + block.top + frac * block.height;
      }
    },
    [getAnchors],
  );

  const rafRef = useRef<number | null>(null);
  const scheduleSync = useCallback(
    (src: 'editor' | 'preview') => {
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        syncScroll(src);
      });
    },
    [syncScroll],
  );

  // 预览尺寸变化（窗口、分栏拖动、字体加载）时位置缓存失效
  useEffect(() => {
    const scroller = previewRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      anchorsRef.current = null;
    });
    ro.observe(scroller);
    const paper = scroller.firstElementChild;
    if (paper) ro.observe(paper);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // ------------------------------------------------------------ 编辑操作

  const applyEdit = useCallback((edit: TextEdit, userEvent = 'input') => {
    const cm = viewRef.current;
    if (!cm || !editableRef.current) return;
    cm.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: edit.selection,
      scrollIntoView: true,
      userEvent,
    });
    cm.focus();
  }, []);

  const ensureSourceVisible = useCallback(() => {
    if (modeRef.current === 'preview') setView(narrow ? 'source' : 'split');
  }, [narrow, setView]);

  const insertSnippet = useCallback(
    (id: SnippetId) => {
      const cm = viewRef.current;
      if (!cm) return;
      ensureSourceVisible();
      const sel = cm.state.selection.main;
      applyEdit(buildSnippetEdit(cm.state.doc.toString(), sel.from, sel.to, getSnippet(id)));
    },
    [applyEdit, ensureSourceVisible],
  );

  const wrap = useCallback(
    (cmd: WrapCommand) => {
      const cm = viewRef.current;
      if (!cm) return;
      ensureSourceVisible();
      const sel = cm.state.selection.main;
      applyEdit(buildWrapEdit(cm.state.doc.toString(), sel.from, sel.to, cmd));
    },
    [applyEdit, ensureSourceVisible],
  );

  useEffect(() => {
    handlersRef.current = { wrap, sync: scheduleSync };
  }, [wrap, scheduleSync]);

  const undo = () => {
    umRef.current?.undo();
    viewRef.current?.focus();
  };
  const redo = () => {
    umRef.current?.redo();
    viewRef.current?.focus();
  };

  // ------------------------------------------------------------ 工程文件

  /** \includegraphics 需要 graphicx：导言区没有加载时，在 \documentclass 下一行补上 */
  const ensureGraphicx = () => {
    if (!editableRef.current) return;
    const src = ytext.toString();
    const begin = src.indexOf('\\begin{document}');
    if (begin < 0 || /\\usepackage(?:\[[^\]]*\])?\{[^}]*\bgraphicx?\b/u.test(src.slice(0, begin))) {
      return;
    }
    const cls = /\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[^\n]*\n?/u.exec(src);
    const at = cls && cls.index < begin ? cls.index + cls[0].length : 0;
    ytext.insert(at, `${cls && !cls[0].endsWith('\n') ? '\n' : ''}\\usepackage{graphicx}\n`);
  };

  const insertImage = (name: string) => {
    const run = () => {
      ensureGraphicx();
      const cm = viewRef.current;
      if (!cm) return;
      ensureSourceVisible();
      const sel = cm.state.selection.main;
      const insert = `\\includegraphics[width=0.8\\linewidth]{${name}}`;
      applyEdit({
        from: sel.from,
        to: sel.to,
        insert,
        selection: { anchor: sel.from + insert.length, head: sel.from + insert.length },
      });
    };
    if (fileMode(activeRef.current) === 'latex') run();
    else selectFile(LATEX_MAIN_FILE, run);
  };

  const onUpload = async (name: string, file: File) => {
    const f = await uploadAsset(projectId, docId, name, file);
    addAsset(doc, name, { fileId: f.id, mime: f.mime, size: f.size });
    toast({
      title: tr('已添加 {name}', { name }),
      description: tr('在图片菜单里点它，就能在光标处插入 \\includegraphics。'),
      tone: 'success',
    });
  };

  // ------------------------------------------------------------ AI

  /** 生成结束时：对「把范围换成结果」做结构校验，并记下原文用于显示差异 */
  const inspectRun = useCallback(
    (text: string, kind: AiSession['kind']): Pick<AiRun, 'check' | 'original'> => {
      const cm = viewRef.current;
      const range = aiRangeRef.current;
      if (!cm || !range || !text.trim()) return { check: null, original: null };
      return {
        check: checkLatexReplacement(cm.state.doc.toString(), range.from, range.to, text, {
          allowShrink: kind !== 'fix',
        }),
        original: {
          text: cm.state.sliceDoc(range.from, range.to),
          startLine: cm.state.doc.lineAt(range.from).number,
        },
      };
    },
    [],
  );

  const startAi = useCallback(
    (next: AiSession, range: TrackedRange | null) => {
      const id = runIdRef.current + 1;
      runIdRef.current = id;
      stoppedRef.current = false;
      aiRangeRef.current = range;
      setSession(next);
      setAiRun({ id, phase: 'streaming', check: null, original: null });
      void ai.run(next.input).then((full) => {
        if (runIdRef.current !== id) return;
        if (full === null) {
          setAiRun({ id, phase: 'error', check: null, original: null });
          return;
        }
        const phase: LatexAiPhase = stoppedRef.current ? 'stopped' : 'done';
        setAiRun({ id, phase, ...inspectRun(stripCodeFence(full), next.kind) });
      });
    },
    [ai, inspectRun],
  );

  const stopAi = () => {
    stoppedRef.current = true;
    ai.stop();
  };

  const currentSelection = (): TrackedRange | null => {
    const cm = viewRef.current;
    if (!cm) return null;
    const sel = cm.state.selection.main;
    if (sel.empty) return null;
    return { from: sel.from, to: sel.to, original: cm.state.sliceDoc(sel.from, sel.to) };
  };

  const lineRangeLabel = (range: TrackedRange): string => {
    const cm = viewRef.current;
    if (!cm) return '';
    const a = cm.state.doc.lineAt(range.from).number;
    const b = cm.state.doc.lineAt(range.to).number;
    const prefix = isMain ? '' : `${active} `;
    return a === b
      ? tr('{prefix}第 {a} 行', { prefix, a })
      : tr('{prefix}第 {a}–{b} 行', { prefix, a, b });
  };

  const onAiAction = (action: LatexAiAction) => {
    const range = currentSelection();
    if (!range) {
      toast({
        title: tr('先在源码里选中一段'),
        description: tr('AI 会改写选中的内容。'),
        tone: 'info',
      });
      return;
    }
    if (range.original.length > MAX_SELECTION) {
      toast.error(tr('选区太长了'), tr('一次最多处理 5 万个字符，可以分几段来改。'));
      return;
    }
    if (action === 'custom') {
      pendingSelRef.current = range;
      const cm = viewRef.current;
      setPromptLines(
        cm ? cm.state.doc.lineAt(range.to).number - cm.state.doc.lineAt(range.from).number + 1 : 0,
      );
      setPromptMode('custom');
      return;
    }
    startAi(
      {
        kind: 'selection',
        task: {
          title: AI_TITLE[action],
          detail: lineRangeLabel(range),
          canReplace: true,
          replaceLabel: tr('替换选区'),
        },
        input: { action, selection: range.original },
      },
      range,
    );
  };

  const onPromptSubmit = (m: AiPromptMode, prompt: string) => {
    setPromptMode(null);
    if (m === 'custom') {
      const range = pendingSelRef.current;
      pendingSelRef.current = null;
      if (!range) return;
      const cm = viewRef.current;
      const original = cm ? cm.state.sliceDoc(range.from, range.to) : range.original;
      const tracked = { ...range, original };
      startAi(
        {
          kind: 'selection',
          task: {
            title: AI_TITLE.custom,
            detail: `${lineRangeLabel(tracked)} · ${prompt}`,
            canReplace: true,
            replaceLabel: tr('替换选区'),
          },
          input: { action: 'custom', selection: original, prompt },
        },
        tracked,
      );
      return;
    }
    startAi(
      {
        kind: 'section',
        task: { title: tr('AI 写一个小节'), detail: prompt, canReplace: false, replaceLabel: '' },
        input: {
          action: 'latex_section',
          prompt: meta.title
            ? tr('{prompt}\n（论文：{title}）', { prompt, title: meta.title })
            : prompt,
        },
      },
      null,
    );
  };

  /**
   * 让 AI 修复某个问题：一般取问题前后 15 行；导言区里的问题和 Missing \begin{document} 这类结构错误
   * 从第 1 行取到 \begin{document} 之后，让 AI 看到完整的导言区（见 ai/fixGuard.ts）。
   */
  const fixAt = (issue: LatexIssue) => {
    const cm = viewRef.current;
    if (!cm || issue.line === null) return;
    const total = cm.state.doc.lines;
    const line = Math.max(1, Math.min(total, issue.line));
    const range = fixRangeFor(cm.state.doc.toString(), line, issue.message, FIX_CONTEXT_LINES);
    const a = range.from;
    const b = range.to;
    const from = cm.state.doc.line(a).from;
    const to = cm.state.doc.line(b).to;
    const original = cm.state.sliceDoc(from, to);
    if (original.length > MAX_SELECTION) {
      toast.error(tr('这段太长了'), tr('AI 一次最多处理 5 万个字符，可以先手动缩小问题范围。'));
      return;
    }
    const file = activeRef.current;
    const where = file === LATEX_MAIN_FILE ? '' : tr('{file} 的', { file });
    revealLine(line, false);
    startAi(
      {
        kind: 'fix',
        task: {
          title: tr('修复{where}第 {line} 行', { where, line }),
          detail: range.structural
            ? tr('{message} · 含导言区', { message: issue.message })
            : issue.message,
          canReplace: true,
          replaceLabel: tr('替换第 {a}–{b} 行', { a, b }),
          preferDiff: true,
        },
        input: {
          action: 'latex_fix',
          selection: original,
          prompt: tr(
            '{value}在{where}第 {line} 行（片段起始行：{a}）报告问题：{message}。请修复它，只返回第 {a2}–{b} 行修正后的内容，其余内容保持不变。',
            {
              value: issue.source === 'compile' ? tr('LaTeX 编译') : tr('预览检查'),
              where,
              line,
              a,
              message: issue.message,
              a2: a,
              b,
            },
          ),
        },
      },
      { from, to, original },
    );
  };

  const issueFile = (issue: LatexIssue): string =>
    issue.file && textOf(doc, issue.file) ? issue.file : LATEX_MAIN_FILE;

  const onJumpIssue = (issue: LatexIssue) => {
    if (issue.line === null) {
      if (issue.file && textOf(doc, issue.file)) goToLine(issue.file, 1);
      return;
    }
    goToLine(issueFile(issue), issue.line);
  };

  const onFixIssue = (issue: LatexIssue) => {
    if (modeRef.current === 'preview') setView('split');
    selectFile(issueFile(issue), () => fixAt(issue));
  };

  const aiText = useMemo(() => stripCodeFence(ai.text), [ai.text]);

  const closeAi = () => {
    runIdRef.current += 1;
    ai.stop();
    ai.reset();
    setSession(null);
    aiRangeRef.current = null;
  };

  /** 替换后重新编译一次，编译结果出来时告诉用户错误数的变化（见下面的 effect） */
  const recompileAfterAi = () => {
    if (!compile.available) return;
    recheckRef.current = {
      before: compile.result ? compile.issues.filter((i) => i.severity === 'error').length : null,
      prev: compile.result,
      skip: compile.compiling ? 1 : 0,
    };
    void compile.compile();
  };

  const onAiReplace = () => {
    const cm = viewRef.current;
    const range = aiRangeRef.current;
    if (!cm || !range || !aiText.trim() || aiRun.phase !== 'done') return;
    // 生成结束后文档可能又被改过：按当前内容再校验一次；用户看过差异后坚持替换的除外
    const fresh = checkLatexReplacement(cm.state.doc.toString(), range.from, range.to, aiText, {
      allowShrink: session?.kind !== 'fix',
    });
    if (!fresh.ok && aiRun.check?.ok !== false) {
      setAiRun((r) => ({ ...r, check: fresh }));
      toast.error(fresh.title, tr('可以点「仍然查看差异」看看具体改了什么。'));
      return;
    }
    const current = cm.state.sliceDoc(range.from, range.to);
    if (current !== range.original) {
      toast({
        title: tr('原文在生成期间被改动过'),
        description: tr('已按改动后的位置替换，可以用撤销恢复。'),
        tone: 'warning',
      });
    }
    ensureSourceVisible();
    applyEdit(
      {
        from: range.from,
        to: range.to,
        insert: aiText,
        selection: { anchor: range.from, head: range.from + aiText.length },
      },
      'input.ai',
    );
    closeAi();
    recompileAfterAi();
  };

  useEffect(() => {
    const pending = recheckRef.current;
    if (!pending || compile.compiling) return;
    if (compile.error) {
      recheckRef.current = null;
      return;
    }
    if (compile.result === pending.prev) return;
    if (pending.skip > 0) {
      // 替换前就在跑的那次编译，结果不算
      pending.skip -= 1;
      pending.prev = compile.result;
      return;
    }
    recheckRef.current = null;
    const after = compile.issues.filter((i) => i.severity === 'error').length;
    const { before } = pending;
    if (before === null) {
      toast({
        title:
          after === 0
            ? tr('已重新编译，没有错误')
            : tr('已重新编译，还有 {after} 个错误', { after }),
        tone: after === 0 ? 'success' : 'warning',
      });
    } else if (after < before) {
      toast({
        title:
          after === 0
            ? tr('已重新编译，{before} 个错误都没了', { before })
            : tr('错误从 {before} 个减到 {after} 个', { before, after }),
        tone: 'success',
      });
    } else if (after > before) {
      toast({
        title: tr('错误从 {before} 个变成 {after} 个', { before, after }),
        description: tr('这次修改让编译更糟了，可以撤销。'),
        tone: 'warning',
        action: { label: tr('撤销'), onClick: () => umRef.current?.undo() },
      });
    } else {
      toast({
        title: tr('已重新编译，错误数没变（{after} 个）', { after }),
        tone: after === 0 ? 'success' : 'info',
      });
    }
  }, [compile.compiling, compile.result, compile.error, compile.issues]);

  const onAiInsert = () => {
    const cm = viewRef.current;
    if (!cm || !aiText.trim() || aiRun.phase !== 'done') return;
    ensureSourceVisible();
    const head = cm.state.selection.main.head;
    const edit: TextEdit =
      session?.kind === 'section'
        ? buildBlockInsert(cm.state.doc.toString(), head, aiText)
        : {
            from: head,
            to: head,
            insert: aiText,
            selection: { anchor: head, head: head + aiText.length },
          };
    applyEdit(edit, 'input.ai');
    closeAi();
  };

  // ------------------------------------------------------------ 编译与导出

  const onCompile = (force: boolean) => {
    if (previewKind !== 'pdf') setPreviewKind('pdf');
    if (modeRef.current === 'source' && !narrow) setView('split');
    void compile.compile({ force });
  };

  const savedHintRef = useRef(false);
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      if (compile.available) {
        void compile.compile();
      } else if (!savedHintRef.current) {
        savedHintRef.current = true;
        toast({
          title: tr('内容会自动保存'),
          description: tr('服务器没有开启 LaTeX 编译。'),
          tone: 'info',
        });
      }
    }
  };

  const onDownload = () => {
    downloadTex(meta.title, ytext.toString());
  };

  /** 下载整个工程（.tex、.bib、图片…）为 .zip，可以原样再导入 */
  const onDownloadZip = async () => {
    try {
      const { buildLatexZip } = await import('../../import/texExport');
      const { zip, missing } = await buildLatexZip(doc, async (fileId) => {
        const res = await fetch(assetUrl(projectId, fileId), { credentials: 'include' });
        if (!res.ok) throw new Error(`http_${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      });
      downloadBlob(
        `${safeFileName(meta.title, tr('未命名论文'))}.zip`,
        new Blob([zip.slice()], { type: 'application/zip' }),
      );
      if (missing.length) {
        toast({
          title: tr('有图片没能打包'),
          description: tr('{missing} 在项目文件里找不到了。', { missing: missing.join(tr('、')) }),
          tone: 'warning',
        });
      }
    } catch {
      toast.error(tr('打包失败'), tr('请检查网络后再试一次。'));
    }
  };

  const onPrint = () => {
    const html = resultRef.current.blocks.map((b) => sanitizeLatexHtml(b.html)).join('');
    if (!printPreview(meta.title, html)) {
      toast.error(tr('浏览器拦截了打印窗口'), tr('允许本站打开新窗口后再试一次。'));
    }
  };

  const onDownloadPdf = () => {
    if (compile.pdf) {
      downloadBlob(
        `${safeFileName(meta.title, tr('未命名论文'))}.pdf`,
        new Blob([compile.pdf.slice()], { type: 'application/pdf' }),
      );
      return;
    }
    toast({
      title: tr('还没有可以下载的 PDF'),
      description: tr('正在编译，完成后再下载。'),
      tone: 'info',
    });
    void compile.compile();
  };

  const draftIssues = useMemo(() => result.warnings.map(fromDraftWarning), [result.warnings]);
  const compileIssues = useMemo(
    () => (compile.result ? compile.issues.map(fromTexIssue) : null),
    [compile.result, compile.issues],
  );

  // ------------------------------------------------------------ 分栏拖动

  const onDividerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let latest = split.ratio;
    const move = (ev: PointerEvent) => {
      latest = ratioFromPointer(ev.clientX, box.left, box.width);
      split.setRatio(latest);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      split.commit(latest);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onDividerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = split.ratio - step;
    else if (e.key === 'ArrowRight') next = split.ratio + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    if (next === null) return;
    e.preventDefault();
    split.commit(clampSplit(next));
  };

  const empty = result.blocks.length === 0 && !pending;
  const showFileBar = editable || files.length > 1;

  return (
    <div
      className="ltx-root flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
      onKeyDown={onRootKeyDown}
    >
      <LatexToolbar
        editable={editable}
        narrow={narrow}
        canUndo={undoState.canUndo}
        canRedo={undoState.canRedo}
        onUndo={undo}
        onRedo={redo}
        onSnippet={insertSnippet}
        onWrap={wrap}
        hasSelection={hasSelection}
        aiBusy={session !== null && aiRun.phase === 'streaming'}
        onAiAction={onAiAction}
        onAiSection={() => setPromptMode('section')}
        view={mode}
        onViewChange={setView}
        onDownload={onDownload}
        onDownloadZip={() => void onDownloadZip()}
        onPrint={onPrint}
        compileIssues={compileIssues}
        draftIssues={draftIssues}
        pending={pending || compile.compiling}
        onJumpIssue={onJumpIssue}
        onFixIssue={onFixIssue}
        compileAvailable={compile.available}
        compiling={compile.compiling}
        onCompile={onCompile}
        autoCompile={compile.auto}
        onAutoCompileChange={compile.setAuto}
        onDownloadPdf={compile.available ? onDownloadPdf : null}
      />

      <div ref={splitRef} className="relative flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col bg-surface',
            mode === 'preview' && 'hidden',
            mode === 'source' && 'flex-1',
            mode === 'split' && 'shrink-0',
          )}
          style={mode === 'split' ? { width: `${split.ratio * 100}%` } : undefined}
        >
          {showFileBar && (
            <FileBar
              doc={doc}
              files={files}
              active={active}
              editable={editable}
              onSelect={(name) => selectFile(name)}
              onUpload={onUpload}
              onInsertImage={insertImage}
              imageUrl={(fileId) => assetUrl(projectId, fileId)}
            />
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={hostRef}
              className="ltx-cm-host min-h-0 flex-1 overflow-hidden"
              role="tabpanel"
              aria-label={active}
            />
            {!editable && (
              <span className="pointer-events-none absolute top-2 right-4 rounded-sm bg-subtle px-1.5 py-0.5 text-caption text-fg-muted">
                {tr('只读')}
              </span>
            )}
          </div>
        </div>

        {mode === 'split' && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={tr('拖动调整源码和预览的宽度')}
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={Math.round(split.ratio * 100)}
            tabIndex={0}
            onPointerDown={onDividerPointerDown}
            onKeyDown={onDividerKey}
            onDoubleClick={() => split.commit(0.5)}
            className="ltx-divider group relative z-sticky w-px shrink-0 cursor-col-resize bg-line focus-visible:outline-none"
          >
            <span
              aria-hidden
              className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-150 group-hover:bg-accent-soft group-focus-visible:bg-accent-soft"
            />
            <span
              aria-hidden
              className="absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-line-strong transition-colors duration-150 group-hover:bg-accent group-focus-visible:bg-accent"
            />
          </div>
        )}

        <PreviewPane
          compile={compile}
          kind={previewKind}
          onKindChange={setPreviewKind}
          onDownloadPdf={onDownloadPdf}
          className={cn('min-w-0 flex-1 bg-canvas', mode === 'source' && 'hidden')}
          draft={
            <LatexPreview
              blocks={result.blocks}
              scrollRef={previewRef}
              onScroll={() => scheduleSync('preview')}
              onContentChange={() => {
                anchorsRef.current = null;
              }}
              onJumpToLine={jumpToSourceLine}
              empty={empty}
              className="min-h-0 min-w-0 flex-1 bg-canvas"
            />
          }
        />

        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-overlay flex justify-start">
          <AnimatePresence>
            {session && (
              <div className="pointer-events-auto w-[min(600px,100%)]" key="ltx-ai-card">
                <LatexAiCard
                  key={aiRun.id}
                  phase={aiRun.phase}
                  error={
                    aiRun.phase === 'error' ? (ai.error ?? tr('AI 没有写完，可以重试一次。')) : null
                  }
                  task={session.task}
                  text={aiText}
                  editable={editable}
                  original={aiRun.original}
                  check={aiRun.check}
                  onStop={stopAi}
                  onReplace={onAiReplace}
                  onInsert={onAiInsert}
                  onRetry={() => startAi(session, aiRangeRef.current)}
                  onDiscard={closeAi}
                />
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AiPromptDialog
        mode={promptMode}
        selectionLines={promptLines}
        onClose={() => {
          setPromptMode(null);
          pendingSelRef.current = null;
        }}
        onSubmit={onPromptSubmit}
      />
    </div>
  );
}
