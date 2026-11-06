import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronDown, Filter } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useElementSize } from '../shared/dom';
import { isError } from './engine/values';
import { colName, type CellPos, type CellRange } from './lib/a1';
import { fillTarget } from './model/fill';
import { MAX_COL_WIDTH, MAX_ROW_HEIGHT, MIN_COL_WIDTH, MIN_ROW_HEIGHT } from './model/schema';
import { displayOf, type SheetModel } from './model/workbook';
import {
  COL_HEADER_HEIGHT as CH,
  ROW_HEADER_WIDTH as RH,
  indexAt,
  rangeBox,
  visibleSpan,
  type Box,
} from './render/geometry';
import { errorHint } from './render/errors';
import { cssOfStyle, DEFAULT_FONT_PT, defaultAlign, ptToCssPx } from './render/style';
import { tr } from '@/lib/i18n';

export interface EditingState {
  /** enter = 直接打字进入（方向键提交并移动）；edit = F2/双击/公式栏（方向键移动光标） */
  mode: 'enter' | 'edit';
  draft: string;
  source: 'cell' | 'bar';
}

export interface PeerSelection {
  clientId: number;
  name: string;
  color: string;
  active: CellPos;
  range: CellRange;
}

export type GridTarget =
  | { kind: 'cell'; pos: CellPos }
  | { kind: 'row'; row: number }
  | { kind: 'col'; col: number }
  | { kind: 'all' };

export interface SheetGridProps {
  sheet: SheetModel;
  version: number;
  active: CellPos;
  focus: CellPos;
  range: CellRange;
  editing: EditingState | null;
  editable: boolean;
  peers: PeerSelection[];
  /** 复制后的虚线框 */
  clipRange: CellRange | null;
  /** 查找结果高亮 */
  found: CellPos | null;
  sinkRef: RefObject<HTMLTextAreaElement | null>;
  onSinkKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSinkChange: (value: string) => void;
  onSinkCompositionStart: () => void;
  onSinkBlur: () => void;
  onCopy: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCut: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onPick: (target: GridTarget, extend: boolean) => void;
  onDrag: (target: GridTarget) => void;
  onEditCell: (pos: CellPos) => void;
  onContextMenu: (x: number, y: number, target: GridTarget) => void;
  onColWidth: (col: number, width: number) => void;
  onRowHeight: (row: number, height: number) => void;
  onAutoFit: (col: number) => void;
  /** 拖动填充柄松开：target 为填充后的完整区域 */
  onFill: (target: CellRange) => void;
  onFilterButton: (col: number, rect: DOMRect) => void;
}

type Drag =
  | { kind: 'select'; target: 'cell' | 'row' | 'col' }
  | { kind: 'fill'; target: CellRange }
  | { kind: 'resize'; axis: 'col' | 'row'; index: number; start: number; size: number; now: number }
  | { kind: 'touch'; x: number; y: number; target: GridTarget; moved: boolean };

const BASE_FONT_PX = ptToCssPx(DEFAULT_FONT_PT);

export function SheetGrid(props: SheetGridProps) {
  const { sheet, version, active, focus, range, editing, editable, peers, sinkRef } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  void version;
  const rowOff = sheet.rowOffsets();
  const colOff = sheet.colOffsets();
  const rows = sheet.rowCount;
  const cols = sheet.colCount;
  const totalW = colOff[cols] ?? 0;
  const totalH = rowOff[rows] ?? 0;
  const frozen = sheet.frozen();
  const fw = colOff[frozen.cols] ?? 0;
  const fh = rowOff[frozen.rows] ?? 0;
  const W = size.width || 800;
  const H = size.height || 480;
  const paneW = Math.max(0, W - RH - fw);
  const paneH = Math.max(0, H - CH - fh);

  const [r0, r1] = visibleSpan(rowOff, fh + scroll.top, paneH, frozen.rows);
  const [c0, c1] = visibleSpan(colOff, fw + scroll.left, paneW, frozen.cols);

  // 表格坐标 → 视口坐标（冻结区不随滚动）
  const viewX = (x: number, col: number) => RH + x - (col >= frozen.cols ? scroll.left : 0);
  const viewY = (y: number, row: number) => CH + y - (row >= frozen.rows ? scroll.top : 0);

  // 选中格滚进可视区
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const m = sheet.mergeAt(focus.row, focus.col);
    const box = rangeBox(
      rowOff,
      colOff,
      m ?? { r0: focus.row, c0: focus.col, r1: focus.row, c1: focus.col },
    );
    if (focus.col >= frozen.cols) {
      const x0 = box.left - fw;
      const x1 = x0 + Math.min(box.width, paneW);
      if (x0 < el.scrollLeft) el.scrollLeft = x0;
      else if (x1 > el.scrollLeft + paneW) el.scrollLeft = x1 - paneW;
    }
    if (focus.row >= frozen.rows) {
      const y0 = box.top - fh;
      const y1 = y0 + Math.min(box.height, paneH);
      if (y0 < el.scrollTop) el.scrollTop = y0;
      else if (y1 > el.scrollTop + paneH) el.scrollTop = y1 - paneH;
    }
    // 只在焦点变化时滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.row, focus.col, sheet.id]);

  // 切换工作表时回到左上角（状态在渲染时重置，DOM 滚动位置在 layout effect 里）
  const [scrollSheet, setScrollSheet] = useState(sheet.id);
  if (scrollSheet !== sheet.id) {
    setScrollSheet(sheet.id);
    setScroll({ top: 0, left: 0 });
  }
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [sheet.id]);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) setScroll({ top: el.scrollTop, left: el.scrollLeft });
    });
  };

  // ---------------------------------------------------------------- 命中测试

  const local = (clientX: number, clientY: number) => {
    const rect = viewRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };
  const colAtView = (x: number) => {
    const px = x - RH;
    return indexAt(colOff, px < fw ? Math.max(0, px) : px + scroll.left);
  };
  const rowAtView = (y: number) => {
    const py = y - CH;
    return indexAt(rowOff, py < fh ? Math.max(0, py) : py + scroll.top);
  };
  const hit = (clientX: number, clientY: number, prefer?: 'cell' | 'row' | 'col'): GridTarget => {
    const { x, y } = local(clientX, clientY);
    const kind = prefer ?? (x < RH && y < CH ? 'all' : y < CH ? 'col' : x < RH ? 'row' : 'cell');
    if (kind === 'all') return { kind };
    if (kind === 'col') return { kind, col: colAtView(x) };
    if (kind === 'row') return { kind, row: rowAtView(y) };
    return { kind: 'cell', pos: { row: rowAtView(y), col: colAtView(x) } };
  };

  // 拖到边缘时自动滚动
  const edgeScroll = (clientX: number, clientY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const { x, y } = local(clientX, clientY);
    if (x > W - 16) el.scrollLeft += 24;
    else if (x < RH + fw + 8 && el.scrollLeft > 0 && dragRef.current?.kind !== 'resize')
      el.scrollLeft -= 24;
    if (y > H - 16) el.scrollTop += 24;
    else if (y < CH + fh + 8 && el.scrollTop > 0 && dragRef.current?.kind !== 'resize')
      el.scrollTop -= 24;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    const handle = el.closest<HTMLElement>('[data-handle]');
    if (handle?.dataset.handle === 'filter') return;
    e.preventDefault();
    if (handle) {
      const [axis, idx] = (handle.dataset.handle ?? '').split(':');
      if ((axis === 'col' || axis === 'row') && editable) {
        e.stopPropagation();
        viewRef.current?.setPointerCapture(e.pointerId);
        const index = Number(idx);
        const sz = axis === 'col' ? sheet.colWidth(index) : sheet.rowHeight(index);
        const start = axis === 'col' ? e.clientX : e.clientY;
        setDragBoth({ kind: 'resize', axis, index, start, size: sz, now: sz });
        return;
      }
      if (axis === 'fill' && editable) {
        viewRef.current?.setPointerCapture(e.pointerId);
        setDragBoth({ kind: 'fill', target: range });
        return;
      }
    }
    const target = hit(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      setDragBoth({ kind: 'touch', x: e.clientX, y: e.clientY, target, moved: false });
      return;
    }
    viewRef.current?.setPointerCapture(e.pointerId);
    if (target.kind === 'all') {
      props.onPick(target, false);
      return;
    }
    setDragBoth({ kind: 'select', target: target.kind });
    props.onPick(target, e.shiftKey);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'touch') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) dragRef.current = { ...d, moved: true };
      return;
    }
    if (d.kind === 'resize') {
      const delta = (d.axis === 'col' ? e.clientX : e.clientY) - d.start;
      const [lo, hi] =
        d.axis === 'col' ? [MIN_COL_WIDTH, MAX_COL_WIDTH] : [MIN_ROW_HEIGHT, MAX_ROW_HEIGHT];
      setDragBoth({ ...d, now: Math.max(lo, Math.min(hi, d.size + delta)) });
      return;
    }
    edgeScroll(e.clientX, e.clientY);
    if (d.kind === 'fill') {
      const t = hit(e.clientX, e.clientY, 'cell');
      if (t.kind !== 'cell') return;
      const next = fillTarget(range, t.pos.row, t.pos.col);
      if (!sameRange(next, d.target)) setDragBoth({ kind: 'fill', target: next });
      return;
    }
    props.onDrag(hit(e.clientX, e.clientY, d.target));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    if (d.kind === 'touch') {
      if (!d.moved)
        props.onPick(d.target.kind === 'all' ? d.target : hit(e.clientX, e.clientY), false);
      return;
    }
    if (d.kind === 'resize') {
      if (Math.round(d.now) !== Math.round(d.size)) {
        if (d.axis === 'col') props.onColWidth(d.index, d.now);
        else props.onRowHeight(d.index, d.now);
      }
      return;
    }
    if (d.kind === 'fill' && !sameRange(d.target, range)) props.onFill(d.target);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]');
    if (handle) {
      const [axis, idx] = (handle.dataset.handle ?? '').split(':');
      if (axis === 'col' && editable) props.onAutoFit(Number(idx));
      return;
    }
    const t = hit(e.clientX, e.clientY);
    if (t.kind === 'cell') props.onEditCell(t.pos);
  };

  const onContext = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    props.onContextMenu(e.clientX, e.clientY, hit(e.clientX, e.clientY));
  };

  // ---------------------------------------------------------------- 面板

  const panes: Array<{
    key: string;
    left: number;
    top: number;
    width: number;
    height: number;
    ox: number;
    oy: number;
    rows: [number, number];
    cols: [number, number];
  }> = [];
  const rowsF: [number, number] = [0, frozen.rows - 1];
  const colsF: [number, number] = [0, frozen.cols - 1];
  if (frozen.rows && frozen.cols)
    panes.push({
      key: 'tl',
      left: RH,
      top: CH,
      width: fw,
      height: fh,
      ox: 0,
      oy: 0,
      rows: rowsF,
      cols: colsF,
    });
  if (frozen.rows)
    panes.push({
      key: 'tr',
      left: RH + fw,
      top: CH,
      width: paneW,
      height: fh,
      ox: fw + scroll.left,
      oy: 0,
      rows: rowsF,
      cols: [c0, c1],
    });
  if (frozen.cols)
    panes.push({
      key: 'bl',
      left: RH,
      top: CH + fh,
      width: fw,
      height: paneH,
      ox: 0,
      oy: fh + scroll.top,
      rows: [r0, r1],
      cols: colsF,
    });
  panes.push({
    key: 'br',
    left: RH + fw,
    top: CH + fh,
    width: paneW,
    height: paneH,
    ox: fw + scroll.left,
    oy: fh + scroll.top,
    rows: [r0, r1],
    cols: [c0, c1],
  });

  const selBox = rangeBox(rowOff, colOff, range);
  const activeMerge = sheet.mergeAt(active.row, active.col);
  const activeBox = rangeBox(
    rowOff,
    colOff,
    activeMerge ?? { r0: active.row, c0: active.col, r1: active.row, c1: active.col },
  );
  const multi = range.r0 !== range.r1 || range.c0 !== range.c1;
  const allRows = range.r0 === 0 && range.r1 === rows - 1;
  const allCols = range.c0 === 0 && range.c1 === cols - 1;
  const filterArea = sheet.filterArea();
  const filter = sheet.filter();

  const overlays = (
    <>
      {multi && (
        <div
          aria-hidden
          className="pointer-events-none absolute bg-accent/10"
          style={boxStyle(selBox)}
        />
      )}
      {props.found && (
        <div
          aria-hidden
          className="pointer-events-none absolute bg-warning/25"
          style={boxStyle(
            rangeBox(rowOff, colOff, {
              r0: props.found.row,
              c0: props.found.col,
              r1: props.found.row,
              c1: props.found.col,
            }),
          )}
        />
      )}
      {peers.map((p) => {
        const pr = sheet.expandToMerges(p.range);
        const box = rangeBox(rowOff, colOff, pr);
        const am = sheet.mergeAt(p.active.row, p.active.col);
        const ab = rangeBox(
          rowOff,
          colOff,
          am ?? { r0: p.active.row, c0: p.active.col, r1: p.active.row, c1: p.active.col },
        );
        const peerMulti = pr.r0 !== pr.r1 || pr.c0 !== pr.c1;
        return (
          <div key={p.clientId} aria-hidden className="pointer-events-none">
            {peerMulti && (
              <div
                className="absolute z-[1] border border-dashed"
                style={{
                  ...boxStyle(box, 1),
                  borderColor: p.color,
                  backgroundColor: `color-mix(in srgb, ${p.color} 10%, transparent)`,
                }}
              />
            )}
            <div
              className="absolute z-[1] border-2"
              style={{ ...boxStyle(ab, 1), borderColor: p.color }}
            >
              <span
                data-peer-label={p.name}
                className={cn(
                  'absolute -right-0.5 max-w-32 truncate px-1 text-caption leading-4 text-white',
                  ab.top > 16 ? '-top-4 rounded-t-xs' : '-bottom-4 rounded-b-xs',
                )}
                style={{ backgroundColor: p.color }}
              >
                {p.name}
              </span>
            </div>
          </div>
        );
      })}
      {props.clipRange && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-[2] border-2 border-dashed border-accent"
          style={boxStyle(rangeBox(rowOff, colOff, props.clipRange), 1)}
        />
      )}
      {multi && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-[2] border border-accent"
          style={boxStyle(selBox, 1)}
        />
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute z-[2] border-2 border-accent"
        style={boxStyle(activeBox, 1)}
      />
      {drag?.kind === 'fill' && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-[2] border border-dashed border-fg-muted"
          style={boxStyle(rangeBox(rowOff, colOff, drag.target), 1)}
        />
      )}
      {editable && !editing && (
        <div
          data-handle="fill"
          role="presentation"
          className="absolute z-[3] size-2 cursor-crosshair border border-surface bg-accent"
          style={{ left: selBox.left + selBox.width - 4, top: selBox.top + selBox.height - 4 }}
        />
      )}
    </>
  );

  // ---------------------------------------------------------------- 表头

  const colHeader = (from: number, to: number) => {
    const out: ReactNode[] = [];
    for (let c = from; c <= to; c += 1) {
      const w = sheet.colWidth(c);
      const x = colOff[c] ?? 0;
      const selected = c >= range.c0 && c <= range.c1;
      const hiddenNext = c + 1 < cols && sheet.colHidden(c + 1);
      if (w > 0)
        out.push(
          <div
            key={c}
            className={cn(
              'absolute top-0 flex items-center justify-center border-r border-b border-line text-caption select-none',
              selected ? 'bg-accent-soft text-accent-text' : 'text-fg-muted',
              selected && allRows && 'bg-accent text-accent-fg',
              hiddenNext && 'border-r-2 border-r-fg-subtle',
            )}
            style={{ left: x, width: w, height: CH }}
          >
            {colName(c)}
          </div>,
        );
      if (editable && w > 0)
        out.push(
          <div
            key={`h${c}`}
            data-handle={`col:${c}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={tr('调整 {value} 列宽', { value: colName(c) })}
            className="absolute top-0 z-[1] w-2 cursor-col-resize"
            style={{ left: x + w - 4, height: CH }}
          />,
        );
    }
    return out;
  };

  const rowHeader = (from: number, to: number) => {
    const out: ReactNode[] = [];
    for (let r = from; r <= to; r += 1) {
      const h = sheet.rowHeight(r);
      if (h <= 0) continue;
      const y = rowOff[r] ?? 0;
      const selected = r >= range.r0 && r <= range.r1;
      out.push(
        <div
          key={r}
          className={cn(
            'absolute left-0 flex items-center justify-end border-r border-b border-line pr-1.5 text-caption tabular-nums select-none',
            selected ? 'bg-accent-soft text-accent-text' : 'text-fg-subtle',
            selected && allCols && 'bg-accent text-accent-fg',
            sheet.filterHidden().has(r + 1) && 'text-accent-text',
          )}
          style={{ top: y, height: h, width: RH }}
        >
          {r + 1}
        </div>,
      );
      if (editable)
        out.push(
          <div
            key={`h${r}`}
            data-handle={`row:${r}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label={tr('调整第 {value} 行行高', { value: r + 1 })}
            className="absolute left-0 z-[1] h-2 cursor-row-resize"
            style={{ top: y + h - 4, width: RH }}
          />,
        );
    }
    return out;
  };

  // 编辑框（视口坐标）
  const activeStyle = sheet.style(active.row, active.col);
  const sinkLeft = viewX(activeBox.left, active.col);
  const sinkTop = viewY(activeBox.top, active.row);
  const sinkVisible =
    sinkLeft >= RH - activeBox.width &&
    sinkLeft < W &&
    sinkTop >= CH - activeBox.height &&
    sinkTop < H;
  const draftLines = editing ? editing.draft.split('\n') : [''];
  const longest = draftLines.reduce((m, l) => Math.max(m, l.length), 0);

  return (
    <div
      ref={(el) => {
        sizeRef(el);
        scrollRef.current = el;
      }}
      onScroll={onScroll}
      data-testid="sheet-scroller"
      className="relative isolate min-h-0 flex-1 overflow-auto overscroll-contain bg-surface"
    >
      {/* 视口：sticky 贴在滚动容器左上角，内容按滚动位置自己摆放（只渲染看得见的格子） */}
      <div
        ref={viewRef}
        onScroll={(e) => {
          // 聚焦的输入框可能让浏览器滚动 overflow:hidden 的视口：还原
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        className={cn(
          'sticky top-0 left-0 overflow-hidden text-fg',
          drag?.kind === 'resize' &&
            (drag.axis === 'col' ? 'cursor-col-resize' : 'cursor-row-resize'),
          drag?.kind === 'fill' && 'cursor-crosshair',
        )}
        style={{ width: W, height: H, fontSize: BASE_FONT_PX }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragBoth(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContext}
        onMouseDown={(e) => {
          // 不让焦点离开输入接收器（否则会触发提交和输入法失焦）
          if (!(e.target as HTMLElement).closest('[data-handle="filter"]')) e.preventDefault();
        }}
      >
        {panes.map((p) => (
          <Pane
            key={p.key}
            left={p.left}
            top={p.top}
            width={p.width}
            height={p.height}
            ox={p.ox}
            oy={p.oy}
          >
            <CellBlock
              sheet={sheet}
              version={version}
              r0={p.rows[0]}
              r1={p.rows[1]}
              c0={p.cols[0]}
              c1={p.cols[1]}
            />
            {filter && filterArea && (
              <FilterButtons
                sheet={sheet}
                area={filterArea}
                cols={p.cols}
                headerVisible={filterArea.r0 >= p.rows[0] && filterArea.r0 <= p.rows[1]}
                active={filter.criteria}
                onOpen={props.onFilterButton}
              />
            )}
            {overlays}
          </Pane>
        ))}

        {/* 列头 */}
        <div className="absolute top-0 left-0 bg-subtle" style={{ width: W, height: CH }} />
        {frozen.cols > 0 && (
          <Pane left={RH} top={0} width={fw} height={CH} ox={0} oy={0}>
            {colHeader(0, frozen.cols - 1)}
          </Pane>
        )}
        <Pane left={RH + fw} top={0} width={paneW} height={CH} ox={fw + scroll.left} oy={0}>
          {colHeader(c0, c1)}
        </Pane>
        {/* 行号 */}
        <div className="absolute top-0 left-0 bg-subtle" style={{ width: RH, height: H }} />
        {frozen.rows > 0 && (
          <Pane left={0} top={CH} width={RH} height={fh} ox={0} oy={0}>
            {rowHeader(0, frozen.rows - 1)}
          </Pane>
        )}
        <Pane left={0} top={CH + fh} width={RH} height={paneH} ox={0} oy={fh + scroll.top}>
          {rowHeader(r0, r1)}
        </Pane>
        <button
          type="button"
          tabIndex={-1}
          aria-label={tr('全选')}
          className="absolute top-0 left-0 cursor-cell border-r border-b border-line bg-subtle"
          style={{ width: RH, height: CH }}
        />
        {/* 冻结线 */}
        {frozen.rows > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 left-0 h-0.5 bg-line-strong"
            style={{ top: CH + fh - 1 }}
          />
        )}
        {frozen.cols > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-line-strong"
            style={{ left: RH + fw - 1 }}
          />
        )}
        {/* 调整列宽 / 行高的参考线 */}
        {drag?.kind === 'resize' && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute z-[4] bg-accent',
              drag.axis === 'col' ? 'top-0 bottom-0 w-0.5' : 'right-0 left-0 h-0.5',
            )}
            style={
              drag.axis === 'col'
                ? { left: viewX((colOff[drag.index] ?? 0) + drag.now, drag.index) - 1 }
                : { top: viewY((rowOff[drag.index] ?? 0) + drag.now, drag.index) - 1 }
            }
          />
        )}

        {/* 输入接收器：始终聚焦；打字 / 输入法直接进入编辑 */}
        <textarea
          ref={sinkRef}
          aria-label={tr('单元格内容')}
          autoComplete="off"
          spellCheck={false}
          readOnly={!editable}
          rows={1}
          value={editing?.source === 'cell' || editing?.mode === 'enter' ? editing.draft : ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => props.onSinkChange(e.target.value)}
          onKeyDown={props.onSinkKeyDown}
          onCompositionStart={props.onSinkCompositionStart}
          onBlur={props.onSinkBlur}
          onCopy={props.onCopy}
          onCut={props.onCut}
          onPaste={props.onPaste}
          className={cn(
            'absolute z-[5] resize-none overflow-hidden border-2 border-accent bg-surface px-1 leading-tight text-fg outline-none',
            editing && editing.source === 'cell'
              ? 'opacity-100 shadow-md'
              : 'pointer-events-none opacity-0',
          )}
          style={{
            left: sinkVisible ? sinkLeft - 1 : RH,
            top: sinkVisible ? sinkTop - 1 : CH,
            minWidth: activeBox.width + 1,
            minHeight: activeBox.height + 1,
            width: editing
              ? `max(${activeBox.width + 1}px, ${longest + 2}ch)`
              : activeBox.width + 1,
            maxWidth: Math.max(activeBox.width + 1, W - Math.max(RH, sinkLeft) - 4),
            height: editing ? `calc(${draftLines.length} * 1.25em + 8px)` : activeBox.height + 1,
            fontWeight: activeStyle?.b ? 700 : undefined,
            fontStyle: activeStyle?.i ? 'italic' : undefined,
            fontSize: activeStyle?.fs ? `${ptToCssPx(activeStyle.fs)}px` : undefined,
            color: activeStyle?.fc,
            textAlign: editing?.draft.startsWith('=') ? 'left' : (activeStyle?.ha ?? 'left'),
          }}
        />
      </div>
      {/* 撑开滚动范围 */}
      <div aria-hidden style={{ width: RH + totalW, height: CH + totalH, marginTop: -H }} />
    </div>
  );
}

function boxStyle(b: Box, grow = 0): CSSProperties {
  return { left: b.left - grow, top: b.top - grow, width: b.width + grow, height: b.height + grow };
}

function sameRange(a: CellRange, b: CellRange) {
  return a.r0 === b.r0 && a.c0 === b.c0 && a.r1 === b.r1 && a.c1 === b.c1;
}

function Pane({
  left,
  top,
  width,
  height,
  ox,
  oy,
  children,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  ox: number;
  oy: number;
  children: ReactNode;
}) {
  if (width <= 0 || height <= 0) return null;
  return (
    <div className="absolute overflow-hidden" style={{ left, top, width, height }}>
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate3d(${-ox}px, ${-oy}px, 0)` }}
      >
        {children}
      </div>
    </div>
  );
}

interface CellBlockProps {
  sheet: SheetModel;
  version: number;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** 一块可视区域的单元格（滚动跨过行列边界、数据变化时重绘；选区变化不重绘） */
const CellBlock = memo(function CellBlock({ sheet, r0, r1, c0, c1 }: CellBlockProps) {
  if (r1 < r0 || c1 < c0) return null;
  const rowOff = sheet.rowOffsets();
  const colOff = sheet.colOffsets();
  const out: ReactNode[] = [];
  const mergesDone = new Set<string>();
  for (const m of sheet.merges()) {
    if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue;
    mergesDone.add(m.id);
    out.push(
      <Cell
        key={`m${m.id}`}
        sheet={sheet}
        row={m.r0}
        col={m.c0}
        box={rangeBox(rowOff, colOff, m)}
        overflowW={0}
      />,
    );
  }
  for (let r = r0; r <= r1; r += 1) {
    const h = sheet.rowHeight(r);
    if (h <= 0) continue;
    for (let c = c0; c <= c1; c += 1) {
      const w = sheet.colWidth(c);
      if (w <= 0) continue;
      if (sheet.mergeAt(r, c)) continue;
      const box = { left: colOff[c]!, top: rowOff[r]!, width: w, height: h };
      // 左对齐、不换行的文本可以“溢出”到右边的空格子里（与 Excel 一样）
      let overflowW = 0;
      const raw = sheet.raw(r, c);
      if (raw && !sheet.style(r, c)?.wrap) {
        const st = sheet.style(r, c);
        const v = sheet.value(r, c);
        const align = st?.ha ?? defaultAlign(v);
        if (align === 'left' && typeof v === 'string') {
          let x = box.left + w;
          for (let k = c + 1; k <= Math.min(c1 + 8, sheet.colCount - 1); k += 1) {
            if (sheet.raw(r, k) || sheet.mergeAt(r, k)) break;
            x = colOff[k + 1]!;
            if (x - box.left > 1200) break;
          }
          overflowW = x - box.left;
        }
      }
      out.push(
        <Cell key={`${r}:${c}`} sheet={sheet} row={r} col={c} box={box} overflowW={overflowW} />,
      );
    }
  }
  return <>{out}</>;
});

function Cell({
  sheet,
  row,
  col,
  box,
  overflowW,
}: {
  sheet: SheetModel;
  row: number;
  col: number;
  box: Box;
  overflowW: number;
}) {
  const raw = sheet.raw(row, col);
  const st = sheet.style(row, col);
  const value = raw === undefined || raw === '' ? null : sheet.value(row, col);
  const d = raw === undefined || raw === '' ? { text: '' } : displayOf(sheet, row, col);
  const css = cssOfStyle(st, value, d.color);
  const border =
    css.borderTop || css.borderRight || css.borderBottom || css.borderLeft ? (
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          left: -1,
          top: -1,
          right: 0,
          bottom: 0,
          borderTop: css.borderTop,
          borderRight: css.borderRight,
          borderBottom: css.borderBottom,
          borderLeft: css.borderLeft,
        }}
      />
    ) : null;
  const err = isError(value);
  return (
    <div
      className="absolute border-r border-b border-line"
      style={{ ...boxStyle(box), backgroundColor: css.backgroundColor }}
      title={err ? errorHint(d.text) : undefined}
      data-cell={`${row}:${col}`}
    >
      {border}
      {d.text !== '' && (
        <div
          className={cn(
            'absolute top-0 left-0 flex flex-col px-1 leading-tight',
            overflowW ? '' : 'overflow-hidden',
          )}
          style={{
            width: overflowW || box.width - 1,
            height: box.height - 1,
            justifyContent:
              css.verticalAlign === 'top'
                ? 'flex-start'
                : css.verticalAlign === 'middle'
                  ? 'center'
                  : 'flex-end',
            textAlign: css.textAlign,
            whiteSpace: css.whiteSpace,
            overflowWrap: st?.wrap ? 'anywhere' : undefined,
            fontWeight: css.fontWeight,
            fontStyle: css.fontStyle,
            textDecoration: css.textDecoration,
            fontSize: css.fontSize,
            fontFamily: css.fontFamily,
            color: css.color,
            paddingBottom: 2,
            fontVariantNumeric: typeof value === 'number' ? 'tabular-nums' : undefined,
          }}
        >
          <span className={overflowW ? '' : 'truncate'}>{d.text}</span>
        </div>
      )}
    </div>
  );
}

function FilterButtons({
  sheet,
  area,
  cols,
  headerVisible,
  active,
  onOpen,
}: {
  sheet: SheetModel;
  area: CellRange;
  cols: [number, number];
  headerVisible: boolean;
  active: Record<string, string[]>;
  onOpen: (col: number, rect: DOMRect) => void;
}) {
  if (!headerVisible) return null;
  const rowOff = sheet.rowOffsets();
  const colOff = sheet.colOffsets();
  const h = sheet.rowHeight(area.r0);
  const from = Math.max(area.c0, cols[0]);
  const to = Math.min(area.c1, cols[1]);
  const list = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i).filter(
    (c) => sheet.colWidth(c) > 0,
  );
  const out = list.map((c) => {
    const on = !!active[sheet.colIds()[c] ?? ''];
    const size = Math.min(20, h - 4);
    return (
      <button
        key={c}
        type="button"
        data-handle="filter"
        aria-label={tr('筛选 {value} 列', { value: colName(c) })}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onOpen(c, e.currentTarget.getBoundingClientRect())}
        className={cn(
          'absolute z-[3] flex items-center justify-center rounded-xs border border-line bg-surface text-fg-muted hover:text-fg',
          on && 'border-accent text-accent-text',
        )}
        style={{
          left: (colOff[c + 1] ?? 0) - size - 3,
          top: (rowOff[area.r0] ?? 0) + (h - size) / 2,
          width: size,
          height: size,
        }}
      >
        {on ? (
          <Filter className="size-3" strokeWidth={2} aria-hidden />
        ) : (
          <ChevronDown className="size-3" strokeWidth={2} aria-hidden />
        )}
      </button>
    );
  });
  return <>{out}</>;
}
