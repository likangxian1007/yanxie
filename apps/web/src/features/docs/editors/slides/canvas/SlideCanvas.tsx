import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from 'react';
import type { Editor } from '@tiptap/react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { CollabPeer } from '../../../collab/useCollabDoc';
import { peerColor } from '../../rich/ext/caret';
import {
  boundsOf,
  expandGroups,
  patchElements,
  round,
  type Patch,
  type Rect,
} from '../model/elements';
import type { DeckInfo, SlideElement, SlideModel } from '../model/types';
import { ElementView, lineEnds, pt } from '../render/ElementView';
import { backgroundCss } from '../render/SlideRender';
import {
  HANDLES,
  lineFromPoints,
  rectContains,
  resizeBox,
  rotateAngle,
  scaleRects,
  snapMove,
  type Guide,
  type Handle,
} from './geometry';
import { TableEditor, type CellPos } from './TableEditor';
import { TextBoxEditor } from './TextBoxEditor';
import { tr } from '@/lib/i18n';

export interface EditingState {
  id: string;
  focusAt: { x: number; y: number } | 'end' | null;
}

export interface SlideCanvasProps {
  doc: Y.Doc;
  slide: SlideModel;
  deck: DeckInfo;
  origin: unknown;
  editable: boolean;
  /** 显示比例：每 pt 多少 CSS px */
  k: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  editing: EditingState | null;
  onEditing: (e: EditingState | null) => void;
  tableCell: CellPos | null;
  onTableCell: (pos: CellPos | null) => void;
  peers: CollabPeer[];
  awareness: Awareness | null;
  onUndo: () => void;
  onRedo: () => void;
  onEditor: (editor: Editor | null) => void;
}

type Box = Pick<SlideElement, 'x' | 'y' | 'w' | 'h' | 'rot' | 'flipH' | 'flipV'>;

type Gesture =
  | { kind: 'move'; start: { x: number; y: number }; boxes: Map<string, Box>; moved: boolean }
  | {
      kind: 'resize';
      handle: Handle;
      boxes: Map<string, Box>;
      bounds: Rect;
      single: SlideElement | null;
    }
  | { kind: 'rotate'; el: SlideElement }
  | { kind: 'line'; el: SlideElement; end: 'start' | 'end' }
  | { kind: 'marquee'; start: { x: number; y: number }; additive: string[] };

const isText = (e: SlideElement) => e.type === 'text' || e.type === 'shape';

/**
 * 编辑画布：页面按 pt 排版后整体缩放（k），选框、手柄、参考线画在未缩放的覆盖层里（屏幕 px），
 * 拖动 / 缩放 / 旋转时先在本地预览，松手后一次写进 Y.Doc（一步撤销）。
 */
export function SlideCanvas(props: SlideCanvasProps) {
  const { doc, slide, deck, origin, editable, k, selected, onSelect, editing, onEditing, peers } =
    props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Map<string, Partial<Box>> | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [moving, setMoving] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);

  const previewRef = useRef<Map<string, Partial<Box>> | null>(null);
  const showPreview = (m: Map<string, Partial<Box>> | null) => {
    previewRef.current = m;
    setPreview(m);
  };
  const elements = useMemo(() => {
    if (!preview) return slide.elements;
    return slide.elements.map((e) => {
      const p = preview.get(e.id);
      return p ? ({ ...e, ...p } as SlideElement) : e;
    });
  }, [slide.elements, preview]);
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);
  const sel = useMemo(
    () => selected.map((id) => byId.get(id)).filter(Boolean) as SlideElement[],
    [selected, byId],
  );

  const toPage = useCallback(
    (clientX: number, clientY: number) => {
      const r = rootRef.current?.getBoundingClientRect();
      return { x: (clientX - (r?.left ?? 0)) / k, y: (clientY - (r?.top ?? 0)) / k };
    },
    [k],
  );

  const commit = useCallback(
    (patches: Map<string, Partial<Box>>) => {
      const list: Array<{ map: Y.Map<unknown> | null; patch: Patch }> = [];
      patches.forEach((p, id) => {
        const el = slide.elements.find((e) => e.id === id);
        if (!el) return;
        const patch: Patch = {};
        for (const [key, v] of Object.entries(p)) {
          const val = typeof v === 'number' ? round(v) : v;
          if ((el as unknown as Record<string, unknown>)[key] !== val) patch[key] = val;
        }
        if (Object.keys(patch).length) list.push({ map: el.map, patch });
      });
      patchElements(doc, list, origin);
    },
    [doc, origin, slide.elements],
  );

  // ---------------------------------------------------------------- 手势
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const p = toPage(e.clientX, e.clientY);
      if (g.kind === 'move') {
        let dx = p.x - g.start.x;
        let dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * k < 3) return;
        if (!g.moved) setMoving(true);
        g.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const moving = boundsOf(
          [...g.boxes.values()].map((b) => ({ ...b, x: b.x + dx, y: b.y + dy })),
        );
        let snapGuides: Guide[] = [];
        if (!e.altKey) {
          const others = slide.elements.filter((x) => !g.boxes.has(x.id));
          const s = snapMove(moving, others, deck, 6 / k);
          dx += s.dx;
          dy += s.dy;
          snapGuides = s.guides;
        }
        setGuides(snapGuides);
        const next = new Map<string, Partial<Box>>();
        g.boxes.forEach((b, id) => next.set(id, { x: b.x + dx, y: b.y + dy }));
        showPreview(next);
      } else if (g.kind === 'resize') {
        const next = new Map<string, Partial<Box>>();
        if (g.single) {
          const b = g.boxes.get(g.single.id)!;
          const keep = e.shiftKey || (g.single.type === 'image' && g.handle.length === 2);
          next.set(g.single.id, resizeBox(b, g.handle, p, { keepRatio: keep, min: 4 }));
        } else {
          const to = resizeBox({ ...g.bounds, rot: 0 }, g.handle, p, {
            keepRatio: e.shiftKey,
            min: 4,
          });
          const ids = [...g.boxes.keys()];
          const rects = scaleRects(
            ids.map((id) => g.boxes.get(id)!),
            g.bounds,
            to,
          );
          ids.forEach((id, i) => next.set(id, rects[i]!));
        }
        showPreview(next);
      } else if (g.kind === 'rotate') {
        const rot = rotateAngle(g.el, p, e.shiftKey);
        showPreview(new Map([[g.el.id, { rot }]]));
      } else if (g.kind === 'line') {
        const ends = lineEnds(g.el);
        const fixed =
          g.end === 'start'
            ? { x: g.el.x + ends.x2, y: g.el.y + ends.y2 }
            : { x: g.el.x + ends.x1, y: g.el.y + ends.y1 };
        let q = p;
        if (e.shiftKey) {
          const ang = Math.atan2(p.y - fixed.y, p.x - fixed.x);
          const snapA = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(p.x - fixed.x, p.y - fixed.y);
          q = { x: fixed.x + Math.cos(snapA) * len, y: fixed.y + Math.sin(snapA) * len };
        }
        const r = g.end === 'start' ? lineFromPoints(q, fixed) : lineFromPoints(fixed, q);
        showPreview(new Map([[g.el.id, r]]));
      } else if (g.kind === 'marquee') {
        const r = {
          x: Math.min(g.start.x, p.x),
          y: Math.min(g.start.y, p.y),
          w: Math.abs(p.x - g.start.x),
          h: Math.abs(p.y - g.start.y),
        };
        setMarquee(r);
        const hit = slide.elements.filter((x) => rectContains(r, x)).map((x) => x.id);
        onSelect(expandGroups(slide.elements, [...new Set([...g.additive, ...hit])]));
      }
    };
    const onUp = () => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      setMoving(false);
      setGuides([]);
      setMarquee(null);
      // 先写文档再清预览（不能在 setState 的更新函数里写 Y：那会在渲染期间触发别的组件更新）
      const cur = previewRef.current;
      if (cur && g.kind !== 'marquee' && (g.kind !== 'move' || g.moved)) commit(cur);
      showPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [toPage, k, slide.elements, deck, commit, onSelect]);

  const boxesOf = (ids: string[]) => {
    const m = new Map<string, Box>();
    for (const id of ids) {
      const el = byId.get(id);
      if (el)
        m.set(id, {
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          rot: el.rot,
          flipH: el.flipH,
          flipV: el.flipV,
        });
    }
    return m;
  };

  const startEditing = (
    el: SlideElement,
    e: { clientX: number; clientY: number; target: EventTarget },
  ) => {
    if (!editable) return;
    if (isText(el)) {
      onSelect([el.id]);
      onEditing({ id: el.id, focusAt: { x: e.clientX, y: e.clientY } });
    } else if (el.type === 'table') {
      onSelect([el.id]);
      onEditing({ id: el.id, focusAt: null });
      const td = (e.target as HTMLElement).closest?.('td[data-r]') as HTMLElement | null;
      props.onTableCell(td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : { r: 0, c: 0 });
    }
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const elNode = target.closest('[data-el]') as HTMLElement | null;
    const id = elNode?.dataset.el;
    // 正在编辑的文本框 / 表格里：交给编辑器
    if (editing && id === editing.id) return;
    rootRef.current?.focus({ preventScroll: true });
    if (editing) onEditing(null);
    const p = toPage(e.clientX, e.clientY);
    const el = id ? byId.get(id) : undefined;
    if (!el) {
      if (!editable) {
        onSelect([]);
        return;
      }
      gesture.current = { kind: 'marquee', start: p, additive: e.shiftKey ? selected : [] };
      if (!e.shiftKey) onSelect([]);
      e.preventDefault();
      return;
    }
    // 双击 / 双指轻点进入编辑（触屏没有可靠的 dblclick）
    const now = Date.now();
    const tap = lastTap.current;
    lastTap.current = { id: el.id, t: now };
    if (tap && tap.id === el.id && now - tap.t < 350 && selected.includes(el.id)) {
      startEditing(el, e);
      lastTap.current = null;
      return;
    }
    let ids: string[];
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      ids = selected.includes(el.id)
        ? selected.filter((x) => !expandGroups(slide.elements, [el.id]).includes(x))
        : expandGroups(slide.elements, [...selected, el.id]);
    } else ids = selected.includes(el.id) ? selected : expandGroups(slide.elements, [el.id]);
    onSelect(ids);
    if (!editable || !ids.includes(el.id)) return;
    e.preventDefault();
    gesture.current = { kind: 'move', start: p, boxes: boxesOf(ids), moved: false };
  };

  const startHandle = (e: RPointerEvent, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    const single = sel.length === 1 ? sel[0]! : null;
    gesture.current = {
      kind: 'resize',
      handle,
      boxes: boxesOf(selected),
      bounds: boundsOf(sel),
      single: single && single.rot !== 0 ? single : single,
    };
  };

  const peerSel = peers.filter(
    (p) =>
      !p.isSelf &&
      p.state.slide === slide.id &&
      Array.isArray(p.state.sel) &&
      (p.state.sel as unknown[]).length > 0,
  );

  const single = sel.length === 1 ? sel[0]! : null;
  const showHandles =
    editable &&
    sel.length > 0 &&
    !moving &&
    !marquee &&
    !(editing && single && editing.id === single.id && single.type === 'table');
  const multiBounds = sel.length > 1 ? boundsOf(sel) : null;

  return (
    <div
      ref={rootRef}
      className="sl-canvas relative outline-none"
      tabIndex={-1}
      style={{ width: deck.width * k, height: deck.height * k, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        const id = ((e.target as HTMLElement).closest('[data-el]') as HTMLElement | null)?.dataset
          .el;
        const el = id ? byId.get(id) : undefined;
        if (el && editing?.id !== el.id) startEditing(el, e);
      }}
    >
      <div
        className="sl-page shadow-md"
        style={{
          width: pt(deck.width),
          height: pt(deck.height),
          transform: `scale(${(k * 3) / 4})`,
          ...backgroundCss(slide.bg, deck),
          ['--sl-inv' as string]: String(4 / 3 / k),
        }}
      >
        {elements.map((el) => {
          const isEditing = editing?.id === el.id;
          const textSlot =
            isText(el) && 'frag' in el && el.frag ? (
              <TextBoxEditor
                fragment={el.frag}
                awareness={props.awareness}
                editing={isEditing && editable}
                label={placeholderName(el.name) || tr('文本框')}
                onUndo={props.onUndo}
                onRedo={props.onRedo}
                focusAt={isEditing ? editing.focusAt : null}
                onEditor={props.onEditor}
                onContentHeight={(px) => {
                  if (el.type !== 'text' || el.autofit !== 'grow') return;
                  const need = round(px * 0.75 + el.pad[1] + el.pad[3]);
                  if (Math.abs(need - el.h) > 0.5 && need > 8)
                    patchElements(doc, [{ map: el.map, patch: { h: need } }], origin);
                }}
              />
            ) : undefined;
          const tableSlot =
            el.type === 'table' && isEditing && editable ? (
              <TableEditor
                el={el}
                theme={deck.theme}
                active={props.tableCell}
                onActive={(pos) => {
                  props.onTableCell(pos);
                  if (!pos) {
                    onEditing(null);
                    rootRef.current?.focus({ preventScroll: true });
                  }
                }}
                origin={origin}
                onUndo={props.onUndo}
                onRedo={props.onRedo}
              />
            ) : undefined;
          return (
            <ElementView
              key={el.id}
              el={el}
              theme={deck.theme}
              textSlot={textSlot}
              tableSlot={tableSlot}
              showPrompt={editable && !isEditing}
              className={isEditing ? 'sl-el--editing' : undefined}
            />
          );
        })}
      </div>

      {/* 覆盖层：协作者的选区、自己的选框与手柄、参考线、框选 */}
      <div className="pointer-events-none absolute inset-0">
        {peerSel.map((p) =>
          (p.state.sel as string[]).map((id) => {
            const el = byId.get(id);
            if (!el) return null;
            const color = peerColor(p.user as unknown as Record<string, unknown>);
            return (
              <div
                key={`${p.clientId}:${id}`}
                className="absolute rounded-xs"
                data-peer-sel={p.user.name}
                style={{
                  left: el.x * k - 3,
                  top: el.y * k - 3,
                  width: el.w * k + 6,
                  height: Math.max(el.h * k, 2) + 6,
                  transform: el.rot ? `rotate(${el.rot}deg)` : undefined,
                  boxShadow: `0 0 0 2px ${color}`,
                }}
              >
                <span
                  className="absolute -top-5 left-0 rounded-xs px-1.5 text-caption whitespace-nowrap text-accent-fg"
                  style={{ backgroundColor: color }}
                >
                  {p.user.name}
                </span>
              </div>
            );
          }),
        )}

        {sel.map((el) => (
          <div
            key={el.id}
            className="absolute"
            style={{
              left: el.x * k,
              top: el.y * k,
              width: el.w * k,
              height: Math.max(el.h * k, 1),
              transform: el.rot ? `rotate(${el.rot}deg)` : undefined,
              boxShadow: el.type === 'line' ? undefined : '0 0 0 1.5px var(--accent)',
              outline: editing?.id === el.id ? '1px dashed var(--accent)' : undefined,
              outlineOffset: 3,
            }}
          >
            {showHandles && single === el && el.type === 'line' && (
              <>
                {(['start', 'end'] as const).map((end) => {
                  const ends = lineEnds(el);
                  const x = end === 'start' ? ends.x1 : ends.x2;
                  const y = end === 'start' ? ends.y1 : ends.y2;
                  return (
                    <span
                      key={end}
                      className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-accent bg-surface"
                      style={{ left: x * k, top: y * k }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        gesture.current = { kind: 'line', el, end };
                      }}
                    />
                  );
                })}
              </>
            )}
            {showHandles && single === el && el.type !== 'line' && (
              <>
                {HANDLES.map((h) => (
                  <span
                    key={h}
                    data-handle={h}
                    className="sl-handle pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-xs border border-accent bg-surface"
                    style={{
                      left: h.includes('w') ? 0 : h.includes('e') ? '100%' : '50%',
                      top: h.includes('n') ? 0 : h.includes('s') ? '100%' : '50%',
                      cursor: cursorFor(h, el.rot),
                    }}
                    onPointerDown={(e) => startHandle(e, h)}
                  />
                ))}
                <span
                  aria-hidden
                  className="pointer-events-auto absolute left-1/2 -top-6 size-3 -translate-x-1/2 cursor-grab rounded-full border border-accent bg-surface"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    gesture.current = { kind: 'rotate', el };
                  }}
                />
              </>
            )}
          </div>
        ))}

        {showHandles && multiBounds && (
          <div
            className="absolute border border-dashed border-accent"
            style={{
              left: multiBounds.x * k,
              top: multiBounds.y * k,
              width: multiBounds.w * k,
              height: multiBounds.h * k,
            }}
          >
            {HANDLES.filter((h) => h.length === 2).map((h) => (
              <span
                key={h}
                className="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-xs border border-accent bg-surface"
                style={{
                  left: h.includes('w') ? 0 : '100%',
                  top: h.includes('n') ? 0 : '100%',
                  cursor: cursorFor(h, 0),
                }}
                onPointerDown={(e) => startHandle(e, h)}
              />
            ))}
          </div>
        )}

        {/* 长度不足 1px 的参考线会缩成孤立的红点，不画 */}
        {guides
          .filter((g) => (g.to - g.from) * k >= 1)
          .map((g, i) => (
            <div
              key={i}
              className="absolute bg-danger"
              style={
                g.axis === 'x'
                  ? { left: g.pos * k, top: g.from * k, width: 1, height: (g.to - g.from) * k }
                  : { top: g.pos * k, left: g.from * k, height: 1, width: (g.to - g.from) * k }
              }
            />
          ))}
        {marquee && (
          <div
            className="absolute border border-accent bg-accent-soft/40"
            style={{
              left: marquee.x * k,
              top: marquee.y * k,
              width: marquee.w * k,
              height: marquee.h * k,
            }}
          />
        )}
      </div>
    </div>
  );
}

const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
function cursorFor(h: Handle, rot: number): string {
  const base: Record<Handle, number> = {
    n: 0,
    ne: 45,
    e: 90,
    se: 135,
    s: 180,
    sw: 225,
    w: 270,
    nw: 315,
  };
  const a = (((base[h] + rot) % 180) + 180) % 180;
  return CURSORS[Math.round(a / 45) % 4]!;
}

/** 旧文档里存的默认占位名按当前界面语言显示 */
function placeholderName(name: string | undefined): string | undefined {
  if (name === '标题') return tr('标题');
  if (name === '副标题') return tr('副标题');
  if (name === '正文') return tr('正文');
  return name;
}
