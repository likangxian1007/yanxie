import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { Editor } from '@tiptap/react';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  ArrowRight,
  Copy,
  Download,
  FileDown,
  FileText,
  FileUp,
  Image as ImageIcon,
  Minus,
  Play,
  Plus,
  Presentation,
  Redo2,
  Shapes,
  Sparkles,
  Table2,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Select,
  Skeleton,
  toast,
} from '@/components/ui';
import { fileUrl, isImageFile, uploadFile, uploadProblem } from '../rich/media/upload';
import { useYTextBinding } from '../shared/bindYText';
import {
  downloadText,
  isMac,
  safeFileName,
  setAwareness,
  shortId,
  useElementSize,
} from '../shared/dom';
import { useLocalOrigin } from '../shared/yStore';
import type { DocEditorProps } from '../types';
import { SlideCanvas, type EditingState } from './canvas/SlideCanvas';
import type { CellPos } from './canvas/TableEditor';
import { exportPptx } from './exportPptx';
import { slidesToMarkdown, type SlideDraft } from './lib/markdown';
import {
  createSlideMap,
  deleteSlide,
  draftsToSlides,
  duplicateSlide,
  insertSlides,
  moveSlide,
  normalizeDeck,
  readAllSlides,
  readSlide,
  replaceAllWithDrafts,
  setDeckMeta,
  setSlideBackground,
  slideToDraft,
  type ElementInit,
  type NewSlide,
} from './model';
import {
  addElements,
  cloneInits,
  deleteElements,
  parseClipboard,
  patchElements,
  serializeElements,
  elementToInit,
} from './model/elements';
import { useDeck, useSlide } from './model/hooks';
import { applyLayout, defaultInit } from './model/insert';
import { keysAt } from './model/order';
import { markdownToPm, pmToMarkdown, writePm } from './model/richtext';
import { LAYOUTS, THEMES } from './model/themes';
import type { DeckInfo, LayoutId, SlideElement, SlideModel } from './model/types';
import { useSlidesUndo } from './model/undo';
import { Presenter } from './Presenter';
import { PrintDeck } from './PrintDeck';
import { SHAPE_PRESETS } from './render/shapes';
import { SlidePolishButton, SlidesAiDialog } from './SlidesAi';
import { SlideThumbnails } from './SlideThumbnails';
import { ColorBar, ColorPicker } from './ui/ColorPicker';
import { FormatBar } from './ui/FormatBar';
import { tr } from '@/lib/i18n';

const S = 1.75;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/** 读图片宽高比 */
function imageRatio(src: string): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(4 / 3);
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight) || 4 / 3);
    img.onerror = () => resolve(4 / 3);
    img.src = src;
  });
}

/**
 * 协同幻灯片（自由版式，类 PowerPoint）。数据结构见 model/deck.ts；
 * 当前页的文本框是 Tiptap（绑定 Y.XmlFragment），画布操作写 Y.Map，撤销栈每人一个（model/undo.ts）。
 */
export function SlidesEditor({
  projectId,
  docId,
  meta,
  collab,
  editable,
  onOutline,
  jumpTo,
}: DocEditorProps) {
  const { doc, provider, peers, synced } = collab;
  const { arr, meta: deckMeta, refs, deck } = useDeck(doc);
  const origin = useLocalOrigin('slides');
  const undo = useSlidesUndo(arr, deckMeta, origin);
  const awareness = ((provider as unknown as { awareness?: Awareness | null } | null)?.awareness ??
    null) as Awareness | null;

  // 打开时迁移旧版固定版式的页 / 补排序键（不进撤销栈）
  useEffect(() => {
    if (editable && (synced || collab.status !== 'connecting')) normalizeDeck(doc);
  }, [doc, editable, synced, collab.status, refs]);

  const [cur, setCur] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const [sel, setSel] = useState<{ slide: string | null; ids: string[] }>({ slide: null, ids: [] });
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [tableCell, setTableCell] = useState<CellPos | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [printing, setPrinting] = useState<SlideModel[] | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();
  const imageInput = useRef<HTMLInputElement>(null);
  const replaceImage = useRef<string | null>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const pptxInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const found = cur.id ? refs.findIndex((s) => s.id === cur.id) : -1;
  const currentIndex =
    refs.length === 0 ? -1 : found >= 0 ? found : Math.min(cur.index, refs.length - 1);
  const currentRef = currentIndex >= 0 ? refs[currentIndex] : undefined;
  const current = useSlide(currentRef, deck);
  const currentId = current?.id ?? null;

  const selected = useMemo(() => {
    if (!current || sel.slide !== current.id) return [];
    const ids = new Set(current.elements.map((e) => e.id));
    return sel.ids.filter((id) => ids.has(id));
  }, [current, sel]);
  const selectedEls = useMemo(
    () => (current ? current.elements.filter((e) => selected.includes(e.id)) : []),
    [current, selected],
  );
  const setSelected = useCallback(
    (ids: string[]) => setSel({ slide: currentId, ids }),
    [currentId],
  );

  const goTo = (id: string) => {
    const i = refs.findIndex((s) => s.id === id);
    setCur({ id, index: Math.max(0, i) });
    setEditing(null);
    setTableCell(null);
  };

  // 大纲跳转
  const [jumpNonce, setJumpNonce] = useState<number | null>(null);
  if (jumpTo && jumpTo.nonce !== jumpNonce) {
    setJumpNonce(jumpTo.nonce);
    const target = refs[jumpTo.index];
    if (target) setCur({ id: target.id, index: jumpTo.index });
  }

  // 大纲：每页标题（防抖读取，别人打字时不必每个字都重算）
  useEffect(() => {
    if (!onOutline) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const run = () => {
      const titles = readAllSlides(doc, deck).map(
        (s, i) => s.title.trim() || tr('第 {value} 页', { value: i + 1 }),
      );
      const key = JSON.stringify(titles);
      if (key === last) return;
      last = key;
      onOutline(titles.map((heading) => ({ heading, level: 1 })));
    };
    run();
    const onChange = () => {
      if (t) clearTimeout(t);
      t = setTimeout(run, 300);
    };
    arr.observeDeep(onChange);
    return () => {
      arr.unobserveDeep(onChange);
      if (t) clearTimeout(t);
    };
  }, [arr, doc, deck, onOutline]);

  // awareness：我在看哪一页、选中了哪些元素
  useEffect(() => {
    setAwareness(provider, 'slide', currentId);
  }, [provider, currentId]);
  const selKey = selected.join(',');
  useEffect(() => {
    setAwareness(provider, 'sel', selKey ? selKey.split(',') : null);
  }, [provider, selKey]);
  useEffect(
    () => () => {
      setAwareness(provider, 'slide', null);
      setAwareness(provider, 'sel', null);
    },
    [provider],
  );

  // ------------------------------------------------------------ 页操作

  const addSlide = (afterIndex = currentIndex, layout?: LayoutId) => {
    const l: LayoutId = layout ?? (refs.length === 0 ? 'title' : 'content');
    const [id] = insertSlides(doc, afterIndex + 1, [{ layout: l }], origin);
    if (id) setCur({ id, index: afterIndex + 1 });
  };
  const removeSlide = (id: string) => {
    const i = refs.findIndex((s) => s.id === id);
    const ref = refs[i];
    if (!ref) return;
    deleteSlide(doc, ref.map, origin);
    toast({
      title: tr('已删除第 {value} 页', { value: i + 1 }),
      action: { label: tr('撤销'), onClick: () => undo.undo() },
    });
  };
  const duplicate = (id: string) => {
    const ref = refs.find((s) => s.id === id);
    if (!ref) return;
    const i = refs.indexOf(ref);
    const nid = duplicateSlide(doc, ref, origin);
    if (nid) setCur({ id: nid, index: i + 1 });
  };
  const changeLayout = (id: string, layout: LayoutId) => {
    const ref = refs.find((s) => s.id === id);
    if (!ref) return;
    if (ref.map.get('v') !== 2) normalizeDeck(doc);
    applyLayout(doc, readSlide(ref, deck), layout, deck, origin);
  };
  const applyAi = (drafts: SlideDraft[], mode: 'replace' | 'append') => {
    undo.stopCapturing();
    let ids: string[];
    if (mode === 'replace') {
      ids = replaceAllWithDrafts(doc, drafts, origin);
      if (ids[0]) setCur({ id: ids[0], index: 0 });
    } else {
      // 一份草稿可能排成几页（长表格 / 长正文拆出「（续）」页）
      ids = insertSlides(doc, refs.length, draftsToSlides(drafts, deck), origin);
      if (ids[0]) setCur({ id: ids[0], index: refs.length });
    }
    toast({
      title:
        mode === 'replace'
          ? tr('已替换为 {count} 页', { count: ids.length })
          : tr('已追加 {count} 页', { count: ids.length }),
      tone: 'success',
      action: { label: tr('撤销'), onClick: () => undo.undo() },
    });
  };

  // ------------------------------------------------------------ 元素操作

  const insert = (inits: ElementInit[]) => {
    if (!current) return;
    if (current.version !== 2) normalizeDeck(doc);
    undo.stopCapturing();
    const ids = addElements(doc, current.map, current.elements, inits, origin);
    setSelected(ids);
    return ids;
  };
  const insertKind = (
    kind: Parameters<typeof defaultInit>[0],
    opts?: Parameters<typeof defaultInit>[2],
  ) => {
    const ids = insert([defaultInit(kind, deck, opts)]);
    if (kind === 'text' && ids?.[0]) setEditing({ id: ids[0], focusAt: 'end' });
  };
  const uploadImage = async (file: File): Promise<{ src: string; fileId: string } | null> => {
    const problem = uploadProblem(file);
    if (problem) {
      toast.error(tr('图片没有上传'), problem);
      return null;
    }
    if (!isImageFile(file)) {
      toast.error(tr('图片没有上传'), tr('只支持 PNG、JPG、GIF、WebP 图片'));
      return null;
    }
    setBusy(tr('正在上传图片'));
    try {
      const f = await uploadFile(projectId, file).promise;
      return { src: fileUrl(projectId, f.id), fileId: f.id };
    } catch (e) {
      toast.error(tr('图片没有上传'), e instanceof Error ? e.message : tr('上传失败，请稍后再试'));
      return null;
    } finally {
      setBusy(null);
    }
  };
  const insertImageFile = async (file: File) => {
    const up = await uploadImage(file);
    if (!up) return;
    const ratio = await imageRatio(up.src);
    const target = replaceImage.current;
    replaceImage.current = null;
    if (target) {
      const el = current?.elements.find((e) => e.id === target);
      if (el?.map)
        patchElements(
          doc,
          [{ map: el.map, patch: { src: up.src, fileId: up.fileId, crop: null } }],
          origin,
        );
      return;
    }
    insert([defaultInit('image', deck, { ...up, ratio })]);
  };
  const removeSelected = () => {
    if (!current || selected.length === 0) return;
    deleteElements(doc, current.map, selected, origin);
    setSelected([]);
    setEditing(null);
  };
  const duplicateSelected = () => {
    if (!current || selectedEls.length === 0) return;
    const ids = addElements(
      doc,
      current.map,
      current.elements,
      cloneInits(selectedEls.map(elementToInit), 12),
      origin,
    );
    setSelected(ids);
  };
  const group = () => {
    if (selectedEls.length < 2) return;
    const g = shortId('g');
    patchElements(
      doc,
      selectedEls.map((e) => ({ map: e.map, patch: { group: g } })),
      origin,
    );
  };
  const ungroup = () =>
    patchElements(
      doc,
      selectedEls.map((e) => ({ map: e.map, patch: { group: null } })),
      origin,
    );
  const nudge = (dx: number, dy: number) =>
    patchElements(
      doc,
      selectedEls.map((e) => ({ map: e.map, patch: { x: e.x + dx, y: e.y + dy } })),
      origin,
    );

  // ------------------------------------------------------------ 导入 / 导出

  const importPptxFile = async (file: File) => {
    setBusy(tr('正在导入 PPT'));
    try {
      const { parsePptx, convertParsed } = await import('../../import/pptx');
      const json = await parsePptx(await file.arrayBuffer());
      const res = await convertParsed(json, {
        projectId,
        uploadFile: async (blob, name) => {
          const f = await uploadFile(projectId, new File([blob], name, { type: blob.type }))
            .promise;
          return { id: f.id, url: fileUrl(projectId, f.id) };
        },
      });
      const empty =
        refs.length === 0 ||
        (refs.length === 1 && readAllSlides(doc, deck).every((s) => isBlankSlide(s, meta.title)));
      undo.stopCapturing();
      let first: string | undefined;
      doc.transact(() => {
        let target: DeckInfo = deck;
        if (empty) {
          if (arr.length) arr.delete(0, arr.length);
          setDeckMeta(
            doc,
            { w: res.deck.width, h: res.deck.height, theme: res.deck.theme },
            origin,
          );
          target = res.deck;
        }
        const slides = empty ? res.slides : res.slides.map((s) => scaleSlide(s, res.deck, deck));
        const keys = keysAt(
          empty ? [] : refs.map((r) => r.order),
          empty ? 0 : refs.length,
          slides.length,
        );
        const maps = slides.map((s, i) => createSlideMap(s, target, keys[i]!));
        arr.push(maps);
        first = maps[0]?.get('id') as string | undefined;
      }, origin);
      if (first) setCur({ id: first, index: empty ? 0 : refs.length });
      toast({
        title: tr('已导入 {count} 页', { count: res.slides.length }),
        description: res.warnings.length ? res.warnings.join(tr('；')) : undefined,
        tone: 'success',
        action: { label: tr('撤销'), onClick: () => undo.undo() },
      });
    } catch (e) {
      toast.error(
        tr('没能导入这个 PPT'),
        e instanceof Error && /[\u4e00-\u9fa5]/u.test(e.message)
          ? e.message
          : tr('确认它是 .pptx 文件后再试'),
      );
    } finally {
      setBusy(null);
    }
  };

  const doExportPptx = async () => {
    setBusy(tr('正在生成 PPTX'));
    try {
      await exportPptx(
        readAllSlides(doc, deck),
        deck,
        meta.title || tr('幻灯片'),
        safeFileName(meta.title || tr('幻灯片')),
      );
    } catch {
      toast.error(tr('导出失败'), tr('生成 PPTX 时出错了，可以先导出 PDF 或 Markdown，稍后再试。'));
    } finally {
      setBusy(null);
    }
  };
  const doExportPdf = () => {
    setEditing(null);
    setPrinting(readAllSlides(doc, deck));
  };
  const donePrinting = useCallback(() => setPrinting(null), []);
  const doExportMd = () => {
    downloadText(
      `${safeFileName(meta.title)}.md`,
      slidesToMarkdown(readAllSlides(doc, deck).map(slideToDraft)),
      'text/markdown',
    );
  };

  // ------------------------------------------------------------ 键盘 / 剪贴板

  const inField = (t: HTMLElement) =>
    Boolean(
      t.closest(
        'textarea, input, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
      ),
    );

  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (inField(t)) {
      if (e.key === 'Escape' && editing && t.closest('.sl-canvas')) {
        e.preventDefault();
        setEditing(null);
        setTableCell(null);
        (rootRef.current?.querySelector('.sl-canvas') as HTMLElement | null)?.focus();
      }
      return;
    }
    if (e.key === 'F5' || (e.key === 'Enter' && e.altKey)) {
      e.preventDefault();
      if (refs.length) setPresenting(true);
      return;
    }
    if (mod && (key === '=' || key === '+')) {
      e.preventDefault();
      setZoom((z) => ZOOMS.find((v) => v > (z ?? fitK) + 0.01) ?? 2);
      return;
    }
    if (mod && key === '-') {
      e.preventDefault();
      setZoom((z) => [...ZOOMS].reverse().find((v) => v < (z ?? fitK) - 0.01) ?? 0.25);
      return;
    }
    if (mod && key === '0') {
      e.preventDefault();
      setZoom(null);
      return;
    }
    if (!editable) {
      if (e.key === 'PageDown' || e.key === 'PageUp') switchSlide(e.key === 'PageDown' ? 1 : -1, e);
      return;
    }
    if (mod && !e.altKey) {
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo.undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        undo.redo();
      } else if (key === 'a' && current) {
        e.preventDefault();
        setSelected(current.elements.map((x) => x.id));
      } else if (key === 'd') {
        e.preventDefault();
        duplicateSelected();
      } else if (key === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
      }
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      switchSlide(e.key === 'PageDown' ? 1 : -1, e);
      return;
    }
    if (!t.closest('.sl-canvas')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
    } else if (e.key.startsWith('Arrow') && selected.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge(
        e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
      );
    } else if (e.key === 'Escape') {
      setSelected([]);
    } else if ((e.key === 'Enter' || e.key === 'F2') && selectedEls.length === 1) {
      const el = selectedEls[0]!;
      if (el.type === 'text' || el.type === 'shape') {
        e.preventDefault();
        setEditing({ id: el.id, focusAt: 'end' });
      } else if (el.type === 'table') {
        e.preventDefault();
        setEditing({ id: el.id, focusAt: null });
        setTableCell({ r: 0, c: 0 });
      }
    }
  };
  const switchSlide = (step: number, e: { preventDefault: () => void }) => {
    const next = refs[Math.max(0, Math.min(refs.length - 1, currentIndex + step))];
    if (next) {
      e.preventDefault();
      goTo(next.id);
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>, cut = false) => {
    if (inField(e.target as HTMLElement) || selectedEls.length === 0) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', serializeElements(selectedEls));
    if (cut && editable) removeSelected();
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!editable || !current || inField(e.target as HTMLElement)) return;
    const text = e.clipboardData.getData('text/plain');
    const els = parseClipboard(text);
    if (els) {
      e.preventDefault();
      setSelected(addElements(doc, current.map, current.elements, cloneInits(els, 12), origin));
      return;
    }
    const file = Array.from(e.clipboardData.files).find((f) => isImageFile(f));
    if (file) {
      e.preventDefault();
      void insertImageFile(file);
      return;
    }
    if (text.trim()) {
      e.preventDefault();
      const init = defaultInit('text', deck);
      insert([{ ...init, doc: markdownToPm(text.trim()) }]);
    }
  };

  // ------------------------------------------------------------ 布局

  const fitK = Math.max(
    0.05,
    Math.min((stage.width - 32) / deck.width, (stage.height - 32) / deck.height),
  );
  const k = zoom ?? fitK;
  const mk = isMac() ? '⌘' : 'Ctrl+';
  const menuRef = menu ? refs.find((s) => s.id === menu.id) : undefined;
  const menuIndex = menuRef ? refs.indexOf(menuRef) : -1;
  const singleText =
    selectedEls.length === 1 &&
    (selectedEls[0]!.type === 'text' || selectedEls[0]!.type === 'shape')
      ? (selectedEls[0] as Extract<SlideElement, { type: 'text' | 'shape' }>)
      : null;

  const loading = !synced && collab.status === 'connecting';
  if (loading && refs.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 gap-4 p-4"
        aria-busy="true"
        aria-label={tr('正在加载幻灯片')}
      >
        <div className="hidden w-48 flex-col gap-3 md:flex">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-video w-full" />
          ))}
        </div>
        <Skeleton className="aspect-video max-h-full flex-1" />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col bg-canvas"
      onKeyDown={onRootKeyDown}
      onCopy={(e) => onCopy(e)}
      onCut={(e) => onCopy(e, true)}
      onPaste={onPaste}
    >
      {/* 主工具栏 */}
      <div
        role="toolbar"
        aria-label={tr('幻灯片工具栏')}
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5"
      >
        {editable && (
          <>
            <Menu
              label={tr('新建页面')}
              trigger={
                <Button variant="ghost" size="sm" leftIcon={<Plus strokeWidth={S} aria-hidden />}>
                  {tr('新建页面')}
                </Button>
              }
            >
              <MenuLabel>{tr('选择版式')}</MenuLabel>
              {LAYOUTS.map((l) => (
                <MenuItem key={l.id} onSelect={() => addSlide(currentIndex, l.id)}>
                  {l.label}
                </MenuItem>
              ))}
            </Menu>
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            <IconButton
              size="sm"
              label={tr('文本框')}
              disabled={!current}
              onClick={() => insertKind('text')}
            >
              <Type strokeWidth={S} aria-hidden />
            </IconButton>
            <Menu
              label={tr('形状')}
              trigger={
                <IconButton size="sm" label={tr('形状')} disabled={!current}>
                  <Shapes strokeWidth={S} aria-hidden />
                </IconButton>
              }
            >
              <MenuItem icon={<Minus strokeWidth={S} />} onSelect={() => insertKind('line')}>
                {tr('直线')}
              </MenuItem>
              <MenuItem icon={<ArrowRight strokeWidth={S} />} onSelect={() => insertKind('arrow')}>
                {tr('箭头')}
              </MenuItem>
              <MenuSeparator />
              {SHAPE_PRESETS.map((s) => (
                <MenuItem key={s.id} onSelect={() => insertKind('shape', { shape: s.id })}>
                  {s.label}
                </MenuItem>
              ))}
            </Menu>
            <IconButton
              size="sm"
              label={tr('图片')}
              disabled={!current}
              onClick={() => {
                replaceImage.current = null;
                imageInput.current?.click();
              }}
            >
              <ImageIcon strokeWidth={S} aria-hidden />
            </IconButton>
            <Menu
              label={tr('表格')}
              trigger={
                <IconButton size="sm" label={tr('表格')} disabled={!current}>
                  <Table2 strokeWidth={S} aria-hidden />
                </IconButton>
              }
            >
              <MenuLabel>{tr('插入表格')}</MenuLabel>
              {[
                [2, 2],
                [3, 3],
                [4, 3],
                [5, 4],
                [6, 5],
              ].map(([r, c]) => (
                <MenuItem
                  key={`${r}x${c}`}
                  onSelect={() => insertKind('table', { rows: r, cols: c })}
                >
                  {tr('{r} 行 × {c} 列', { r, c })}
                </MenuItem>
              ))}
            </Menu>
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            <IconButton
              size="sm"
              label={tr('撤销')}
              shortcut={`${mk}Z`}
              disabled={!undo.canUndo}
              onClick={undo.undo}
            >
              <Undo2 strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('重做')}
              shortcut={`${mk}Y`}
              disabled={!undo.canRedo}
              onClick={undo.redo}
            >
              <Redo2 strokeWidth={S} aria-hidden />
            </IconButton>
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Sparkles strokeWidth={S} aria-hidden className="text-agent" />}
              onClick={() => setAiOpen(true)}
            >
              <span className="hidden sm:inline">{tr('AI 生成')}</span>
              <span className="sm:hidden">AI</span>
            </Button>
            {singleText?.frag && (
              <SlidePolishButton
                projectId={projectId}
                docId={docId}
                body={pmToMarkdown(singleText.doc)}
                onReplace={(text) => {
                  const frag = singleText.frag;
                  if (frag) doc.transact(() => writePm(frag, markdownToPm(text)), origin);
                }}
              />
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div className="hidden items-center sm:flex">
            <IconButton
              size="sm"
              label={tr('缩小')}
              shortcut={`${mk}-`}
              onClick={() => setZoom(Math.max(0.25, k - 0.25))}
            >
              <ZoomOut strokeWidth={S} aria-hidden />
            </IconButton>
            <button
              type="button"
              className="h-7 min-w-12 rounded-sm px-1 text-caption text-fg-muted tabular-nums hover:bg-subtle hover:text-fg"
              title={tr('适应窗口')}
              onClick={() => setZoom(null)}
            >
              {zoom === null ? tr('适应') : `${Math.round(((k * 4) / 3) * 100 * 0.75)}%`}
            </button>
            <IconButton
              size="sm"
              label={tr('放大')}
              shortcut={`${mk}+`}
              onClick={() => setZoom(Math.min(3, k + 0.25))}
            >
              <ZoomIn strokeWidth={S} aria-hidden />
            </IconButton>
          </div>
          {editable && (
            <IconButton size="sm" label={tr('导入 PPT')} onClick={() => pptxInput.current?.click()}>
              <FileUp strokeWidth={S} aria-hidden />
            </IconButton>
          )}
          <Menu
            label={tr('导出')}
            align="end"
            trigger={
              <Button
                variant="ghost"
                size="sm"
                loading={busy !== null}
                disabled={refs.length === 0}
                leftIcon={<Download strokeWidth={S} aria-hidden />}
              >
                <span className="hidden sm:inline">{tr('导出')}</span>
              </Button>
            }
          >
            <MenuItem icon={<Presentation strokeWidth={S} />} onSelect={() => void doExportPptx()}>
              {tr('导出 PPTX')}
            </MenuItem>
            <MenuItem icon={<FileDown strokeWidth={S} />} onSelect={doExportPdf}>
              {tr('导出 PDF（打印）')}
            </MenuItem>
            <MenuItem icon={<FileText strokeWidth={S} />} onSelect={doExportMd}>
              {tr('导出 Markdown')}
            </MenuItem>
          </Menu>
          <Button
            variant="primary"
            size="sm"
            disabled={refs.length === 0}
            leftIcon={<Play strokeWidth={S} aria-hidden />}
            onClick={() => setPresenting(true)}
          >
            {tr('放映')}
          </Button>
        </div>
      </div>

      {/* 格式栏：选中元素时显示元素格式，否则显示页面设置 */}
      {editable && current && (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-3 py-1">
          {selectedEls.length > 0 ? (
            <FormatBar
              doc={doc}
              origin={origin}
              deck={deck}
              selected={selectedEls}
              all={current.elements}
              editor={editing && selected.includes(editing.id) ? editor : null}
              tableCell={tableCell}
              onDelete={removeSelected}
              onGroup={group}
              onUngroup={ungroup}
              onReplaceImage={() => {
                replaceImage.current = selectedEls[0]?.id ?? null;
                imageInput.current?.click();
              }}
            />
          ) : (
            <div
              className="flex flex-wrap items-center gap-1"
              role="toolbar"
              aria-label={tr('页面设置')}
            >
              <Select
                size="sm"
                aria-label={tr('版式')}
                wrapperClassName="w-auto shrink-0"
                value={current.layout}
                options={LAYOUTS.map((l) => ({ value: l.id, label: l.label }))}
                onChange={(e) => changeLayout(current.id, e.target.value as LayoutId)}
              />
              <ColorPicker
                label={tr('背景颜色')}
                theme={deck.theme}
                value={current.bg?.type === 'color' ? current.bg.color : null}
                allowNone={tr('跟随主题')}
                onChange={(c) =>
                  setSlideBackground(
                    doc,
                    current.map,
                    c ? { type: 'color', color: c } : null,
                    origin,
                  )
                }
                trigger={
                  <ColorBar color={current.bg?.type === 'color' ? current.bg.color : deck.theme.bg}>
                    <span className="text-small">{tr('背景')}</span>
                  </ColorBar>
                }
              />
              <button
                type="button"
                className="h-7 shrink-0 rounded-sm px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg"
                onClick={() => bgInput.current?.click()}
              >
                {tr('背景图片')}
              </button>
              {current.bg && (
                <button
                  type="button"
                  className="h-7 shrink-0 rounded-sm px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg"
                  onClick={() =>
                    doc.transact(
                      () => refs.forEach((r) => current.bg && r.map.set('bg', current.bg)),
                      origin,
                    )
                  }
                >
                  {tr('背景应用到全部')}
                </button>
              )}
              <span aria-hidden className="mx-1 h-5 w-px bg-line" />
              <Select
                size="sm"
                aria-label={tr('主题')}
                wrapperClassName="w-auto shrink-0"
                value={THEMES.some((t) => t.id === deck.theme.id) ? deck.theme.id : '__cur'}
                options={[
                  ...(THEMES.some((t) => t.id === deck.theme.id)
                    ? []
                    : [{ value: '__cur', label: deck.theme.name }]),
                  ...THEMES.map((t) => ({
                    value: t.id,
                    label: tr('主题：{name}', { name: t.name }),
                  })),
                ]}
                onChange={(e) => {
                  const t = THEMES.find((x) => x.id === e.target.value);
                  if (t) setDeckMeta(doc, { theme: t }, origin);
                }}
              />
              <Select
                size="sm"
                aria-label={tr('页面比例')}
                wrapperClassName="w-auto shrink-0"
                value={
                  Math.abs(deck.width / deck.height - 16 / 9) < 0.01
                    ? '16:9'
                    : Math.abs(deck.width / deck.height - 4 / 3) < 0.01
                      ? '4:3'
                      : 'other'
                }
                options={[
                  { value: '16:9', label: '16:9' },
                  { value: '4:3', label: '4:3' },
                  ...(Math.abs(deck.width / deck.height - 16 / 9) < 0.01 ||
                  Math.abs(deck.width / deck.height - 4 / 3) < 0.01
                    ? []
                    : [
                        {
                          value: 'other',
                          label: `${Math.round(deck.width)}×${Math.round(deck.height)}`,
                        },
                      ]),
                ]}
                onChange={(e) =>
                  setDeckMeta(
                    doc,
                    e.target.value === '4:3' ? { w: 720, h: 540 } : { w: 960, h: 540 },
                    origin,
                  )
                }
              />
              <span className="ml-2 hidden text-caption text-fg-subtle md:inline">
                {tr('双击文本框编辑文字，拖动移动，Shift 多选')}
              </span>
            </div>
          )}
        </div>
      )}

      {refs.length === 0 ? (
        <EmptyState
          className="flex-1 justify-center"
          icon={Presentation}
          title={tr('还没有幻灯片')}
          description={
            editable
              ? tr('新建第一页开始写，导入一份 PPT，或者让 AI 根据主题、项目上下文生成一整套。')
              : tr('这份幻灯片还是空的，有人添加页面后会实时出现在这里。')
          }
          action={
            editable ? (
              <>
                <Button
                  variant="secondary"
                  leftIcon={<Plus strokeWidth={S} aria-hidden />}
                  onClick={() => addSlide(-1)}
                >
                  {tr('新建页面')}
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<FileUp strokeWidth={S} aria-hidden />}
                  onClick={() => pptxInput.current?.click()}
                >
                  {tr('导入 PPT')}
                </Button>
                <Button
                  variant="primary"
                  leftIcon={<Sparkles strokeWidth={S} aria-hidden />}
                  onClick={() => setAiOpen(true)}
                >
                  {tr('AI 生成')}
                </Button>
              </>
            ) : undefined
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <SlideThumbnails
            slides={refs}
            deck={deck}
            currentId={currentId}
            peers={peers}
            editable={editable}
            onSelect={goTo}
            onMove={(from, to) => moveSlide(doc, from, to, origin)}
            onMenu={(id, x, y) => setMenu({ id, x, y })}
            onAdd={() => addSlide(refs.length - 1)}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={stageRef}
              className="relative min-h-60 flex-1 overflow-auto"
              data-slides-stage
            >
              <div
                className="flex min-h-full min-w-full items-center justify-center p-4"
                style={{ width: deck.width * k + 32, height: deck.height * k + 32 }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) {
                    setSelected([]);
                    setEditing(null);
                  }
                }}
              >
                {current && stage.width > 0 && (
                  <SlideCanvas
                    key={current.id}
                    doc={doc}
                    slide={current}
                    deck={deck}
                    origin={origin}
                    editable={editable}
                    k={k}
                    selected={selected}
                    onSelect={setSelected}
                    editing={editing}
                    onEditing={(ed) => {
                      setEditing(ed);
                      if (!ed) setTableCell(null);
                    }}
                    tableCell={tableCell}
                    onTableCell={setTableCell}
                    peers={peers}
                    awareness={awareness}
                    onUndo={undo.undo}
                    onRedo={undo.redo}
                    onEditor={setEditor}
                  />
                )}
              </div>
            </div>
            <NotesPanel
              key={currentId ?? ''}
              notes={current?.map.get('notes')}
              text={current?.notes ?? ''}
              editable={editable}
              origin={origin}
              onUndo={undo.undo}
              onRedo={undo.redo}
              index={currentIndex}
              count={refs.length}
            />
          </div>
        </div>
      )}

      {busy && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-4 left-1/2 z-toast -translate-x-1/2 rounded-full bg-elevated px-3 py-1.5 text-small text-fg-muted shadow-md"
        >
          {busy}…
        </div>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void insertImageFile(f);
        }}
      />
      <input
        ref={bgInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f || !current) return;
          void uploadImage(f).then((up) => {
            if (up)
              setSlideBackground(
                doc,
                current.map,
                { type: 'image', src: up.src, fileId: up.fileId },
                origin,
              );
          });
        }}
      />
      <input
        ref={pptxInput}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        data-testid="slides-import-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importPptxFile(f);
        }}
      />

      {/* 缩略图右键菜单 */}
      <Menu
        label={tr('页面操作')}
        open={menu !== null && menuRef !== undefined}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
        trigger={
          <span
            aria-hidden
            className="pointer-events-none fixed size-px"
            style={{ left: menu?.x ?? -10, top: menu?.y ?? -10 }}
          />
        }
      >
        {menuRef && (
          <>
            <MenuLabel>{tr('第 {value} 页', { value: menuIndex + 1 })}</MenuLabel>
            <MenuItem icon={<Plus strokeWidth={S} />} onSelect={() => addSlide(menuIndex)}>
              {tr('在下方新建')}
            </MenuItem>
            <MenuItem icon={<Copy strokeWidth={S} />} onSelect={() => duplicate(menuRef.id)}>
              {tr('复制页面')}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{tr('版式')}</MenuLabel>
            {LAYOUTS.map((l) => (
              <MenuItem key={l.id} onSelect={() => changeLayout(menuRef.id, l.id)}>
                {l.label}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 strokeWidth={S} />}
              danger
              onSelect={() => removeSlide(menuRef.id)}
            >
              {tr('删除页面')}
            </MenuItem>
          </>
        )}
      </Menu>

      {editable && (
        <SlidesAiDialog
          projectId={projectId}
          docId={docId}
          open={aiOpen}
          onOpenChange={setAiOpen}
          hasSlides={refs.length > 0}
          onApply={applyAi}
        />
      )}

      {presenting && refs.length > 0 && (
        <Presenter
          slides={refs}
          deck={deck}
          startIndex={Math.max(0, currentIndex)}
          onClose={(last) => {
            setPresenting(false);
            const s = refs[last];
            if (s) setCur({ id: s.id, index: last });
          }}
        />
      )}

      {printing && <PrintDeck slides={printing} deck={deck} onDone={donePrinting} />}
    </div>
  );
}

/** 新建文档自带的那一页（只有占位符，标题是空的或等于文档标题）：导入 PPT 时直接替换掉 */
function isBlankSlide(s: SlideModel, docTitle: string): boolean {
  return (
    s.elements.every((e) => {
      if (e.type !== 'text' && e.type !== 'shape') return false;
      if (!e.ph) return false;
      const text = pmToMarkdown(e.doc).trim();
      return !text || (e.ph === 'title' && text === docTitle.trim());
    }) && !s.notes.trim()
  );
}

/** 追加导入的页面尺寸与当前不同：按比例缩放位置和大小 */
function scaleSlide(s: NewSlide, from: DeckInfo, to: DeckInfo): NewSlide {
  if (from.width === to.width && from.height === to.height) return s;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return {
    ...s,
    elements: s.elements?.map((e) => ({
      ...e,
      x: (e.x ?? 0) * sx,
      y: (e.y ?? 0) * sy,
      w: (e.w ?? 0) * sx,
      h: (e.h ?? 0) * sy,
      ...(e.colW ? { colW: e.colW.map((c) => c * sx) } : {}),
      ...(e.rowH ? { rowH: e.rowH.map((r) => r * sy) } : {}),
    })),
  };
}

function NotesPanel({
  notes,
  text,
  editable,
  origin,
  onUndo,
  onRedo,
  index,
  count,
}: {
  notes: unknown;
  text: string;
  editable: boolean;
  origin: unknown;
  onUndo: () => void;
  onRedo: () => void;
  index: number;
  count: number;
}) {
  const ytext = notes instanceof Y.Text ? notes : null;
  const bind = useNotesBinding(editable ? ytext : null, origin, onUndo, onRedo);
  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 py-2">
      <label className="mb-1 flex items-center justify-between text-caption text-fg-subtle">
        <span>{tr('演讲者备注')}</span>
        <span className="tabular-nums">
          {tr('第 {value} / {count} 页', { value: index + 1, count })}
        </span>
      </label>
      {editable && ytext ? (
        <textarea
          ref={bind}
          rows={2}
          aria-label={tr('演讲者备注')}
          placeholder={tr('写给自己的讲稿提示，放映时按 N 显示')}
          className="block max-h-40 w-full resize-none bg-transparent text-small text-fg outline-none placeholder:text-fg-subtle [field-sizing:content]"
        />
      ) : (
        <p className="min-h-10 text-small whitespace-pre-wrap text-fg-muted">
          {text.trim() || tr('这一页没有备注。')}
        </p>
      )}
    </div>
  );
}

function useNotesBinding(
  ytext: Y.Text | null,
  origin: unknown,
  onUndo: () => void,
  onRedo: () => void,
) {
  return useYTextBinding<HTMLTextAreaElement>(ytext, { origin, onUndo, onRedo });
}
