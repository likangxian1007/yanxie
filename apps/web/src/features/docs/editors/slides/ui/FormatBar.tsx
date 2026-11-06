import type { ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import type * as Y from 'yjs';
import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Baseline,
  Bold,
  BringToFront,
  Columns3,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Italic,
  Layers,
  List,
  ListOrdered,
  PaintBucket,
  RotateCw,
  Rows3,
  SendToBack,
  Square,
  Strikethrough,
  Trash2,
  Underline,
  Ungroup,
} from 'lucide-react';
import {
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  Select,
} from '@/components/ui';
import {
  alignRects,
  distributeRects,
  formatFragment,
  fragmentHasMark,
  patchElements,
  setParagraphAttr,
  toggleListFragment,
  zOrderPatches,
  type AlignMode,
  type Patch,
  type ZMove,
} from '../model/elements';
import { deleteCol, deleteRow, insertCol, insertRow, setCellProp } from '../model/table';
import { FONT_LABEL, FONT_OPTIONS, FONT_SIZES } from '../model/themes';
import type {
  ArrowKind,
  DashKind,
  DeckInfo,
  ImageElement,
  LineElement,
  ShapeElement,
  SlideElement,
  TableElement,
  TextAlign,
  TextElement,
} from '../model/types';
import { SHAPE_PRESETS } from '../render/shapes';
import type { CellPos } from '../canvas/TableEditor';
import { ColorBar, ColorPicker } from './ColorPicker';
import { tr } from '@/lib/i18n';

const S = 1.75;

export interface FormatBarProps {
  doc: Y.Doc;
  origin: unknown;
  deck: DeckInfo;
  selected: SlideElement[];
  all: SlideElement[];
  editor: Editor | null;
  tableCell: CellPos | null;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onReplaceImage: () => void;
}

type TextLike = TextElement | ShapeElement;
const isTextLike = (e: SlideElement): e is TextLike => e.type === 'text' || e.type === 'shape';

function ptNum(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([\d.]+)pt$/u.exec(v);
  if (m) return Number(m[1]);
  const px = /^([\d.]+)px$/u.exec(v);
  return px ? Math.round(Number(px[1]) * 0.75) : null;
}

function Group_({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-0.5">{children}</div>;
}

function Sep() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 self-center bg-line" />;
}

/**
 * 上下文格式栏：随选中的元素变化（文字 / 形状 / 线条 / 图片 / 表格 / 排列）。
 * 正在编辑文字时作用于选中的文字（Tiptap 命令）；只选中文本框时作用于整个文本框。
 */
export function FormatBar(props: FormatBarProps) {
  const { doc, origin, deck, selected, editor } = props;
  const texts = selected.filter(isTextLike);
  const first = selected[0];
  const tx = (fn: () => void) => doc.transact(fn, origin);
  const patchAll = (els: SlideElement[], patch: Patch | ((e: SlideElement) => Patch)) =>
    patchElements(
      doc,
      els.map((e) => ({ map: e.map, patch: typeof patch === 'function' ? patch(e) : patch })),
      origin,
    );

  const edState = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return null;
      const ts = ed.getAttributes('textStyle');
      const para = ed.getAttributes('paragraph');
      return {
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        underline: ed.isActive('underline'),
        strike: ed.isActive('strike'),
        bullet: ed.isActive('bulletList'),
        ordered: ed.isActive('orderedList'),
        color: (ts.color as string | null) ?? null,
        fontSize: ptNum(ts.fontSize),
        fontFamily: (ts.fontFamily as string | null) ?? null,
        align: (para.textAlign as TextAlign | null) ?? null,
        lineHeight: (para.lineHeight as number | null) ?? null,
      };
    },
  });

  // ---- 文字
  const t0 = texts[0];
  const boxMark = (m: string) => texts.length > 0 && texts.every((t) => fragmentHasMark(t.doc, m));
  const state = edState ?? {
    bold: boxMark('bold'),
    italic: boxMark('italic'),
    underline: boxMark('underline'),
    strike: boxMark('strike'),
    bullet: t0?.doc.content?.[0]?.type === 'bulletList',
    ordered: t0?.doc.content?.[0]?.type === 'orderedList',
    color: t0?.style.color ?? null,
    fontSize: t0?.style.fontSize ?? null,
    fontFamily: t0?.style.fontFamily ?? null,
    align:
      (t0?.doc.content?.[0]?.attrs?.textAlign as TextAlign | undefined) ?? t0?.style.align ?? null,
    lineHeight: t0?.style.lineHeight ?? null,
  };
  const fontSize = state.fontSize ?? t0?.style.fontSize ?? 18;
  const fontFamily = state.fontFamily ?? t0?.style.fontFamily ?? deck.theme.bodyFont;

  const toggleMark = (m: 'bold' | 'italic' | 'underline' | 'strike') => {
    if (editor) {
      editor.chain().focus().toggleMark(m).run();
      return;
    }
    const on = !boxMark(m);
    tx(() => texts.forEach((t) => t.frag && formatFragment(t.frag, m, on ? {} : null)));
  };
  const setTextStyle = (
    key: 'color' | 'fontSize' | 'fontFamily',
    value: string | number | null,
  ) => {
    if (editor) {
      const v = key === 'fontSize' && typeof value === 'number' ? `${value}pt` : value;
      editor
        .chain()
        .focus()
        .setMark('textStyle', { [key]: v })
        .run();
      return;
    }
    // 整个文本框：改默认样式，并去掉行内的同类设置
    tx(() =>
      texts.forEach((t) => {
        if (!t.map) return;
        const style = { ...((t.map.get('style') as object) ?? {}), [key]: value };
        t.map.set('style', style);
        if (t.frag) formatFragment(t.frag, 'textStyle', { [key]: null });
        if (key === 'fontSize') t.map.set('fontScale', 1);
      }),
    );
  };
  const setAlign = (a: TextAlign) => {
    if (editor) {
      editor.chain().focus().setTextAlign(a).run();
      return;
    }
    tx(() => texts.forEach((t) => t.frag && setParagraphAttr(t.frag, 'textAlign', a)));
  };
  const toggleList = (kind: 'bulletList' | 'orderedList') => {
    if (editor) {
      const chain = editor.chain().focus();
      if (kind === 'bulletList') chain.toggleBulletList().run();
      else chain.toggleOrderedList().run();
      return;
    }
    tx(() => texts.forEach((t) => t.frag && toggleListFragment(t.frag, kind)));
  };
  const setLineHeight = (lh: number) => {
    if (editor) {
      editor.chain().focus().updateAttributes('paragraph', { lineHeight: lh }).run();
      return;
    }
    tx(() =>
      texts.forEach((t) => {
        if (!t.map) return;
        t.map.set('style', { ...((t.map.get('style') as object) ?? {}), lineHeight: lh });
        if (t.frag) setParagraphAttr(t.frag, 'lineHeight', null);
      }),
    );
  };

  const shapes = selected.filter(
    (e): e is ShapeElement | TextElement => e.type === 'shape' || e.type === 'text',
  );
  const lines = selected.filter((e): e is LineElement => e.type === 'line');
  const images = selected.filter((e): e is ImageElement => e.type === 'image');
  const table = selected.length === 1 && first?.type === 'table' ? (first as TableElement) : null;

  const fillColor = shapes[0]?.fill?.type === 'color' ? shapes[0].fill.color : null;
  const strokeOf = (e: SlideElement) =>
    e.type === 'line' || e.type === 'shape' || e.type === 'text' || e.type === 'image'
      ? e.stroke
      : null;
  const strokeHolders = selected.filter((e) => e.type !== 'table');
  const stroke0 = strokeHolders[0] ? strokeOf(strokeHolders[0]) : null;

  const zMove = (m: ZMove) => {
    const z = zOrderPatches(
      props.all,
      selected.map((e) => e.id),
      m,
    );
    patchAll(
      selected.filter((e) => z.has(e.id)),
      (e) => ({ z: z.get(e.id) }),
    );
  };
  const align = (m: AlignMode) => {
    const pos = alignRects(selected, m, deck);
    patchAll(selected, (e) => pos.get(e.id) ?? {});
  };
  const distribute = (axis: 'h' | 'v') => {
    const pos = distributeRects(selected, axis);
    patchAll(
      selected.filter((e) => pos.has(e.id)),
      (e) => pos.get(e.id) ?? {},
    );
  };

  if (selected.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-y-1" role="toolbar" aria-label={tr('格式')}>
      {texts.length > 0 && (
        <>
          <Group_>
            <Select
              size="sm"
              aria-label={tr('字体')}
              wrapperClassName="w-28 shrink-0"
              value={
                FONT_OPTIONS.includes(fontFamily as (typeof FONT_OPTIONS)[number])
                  ? fontFamily
                  : '__custom'
              }
              options={[
                ...(FONT_OPTIONS.includes(fontFamily as (typeof FONT_OPTIONS)[number])
                  ? []
                  : [{ value: '__custom', label: fontFamily }]),
                ...FONT_OPTIONS.map((f) => ({ value: f, label: FONT_LABEL[f] ?? f })),
              ]}
              onChange={(e) =>
                e.target.value !== '__custom' && setTextStyle('fontFamily', e.target.value)
              }
            />
            <Select
              size="sm"
              aria-label={tr('字号')}
              wrapperClassName="w-18 shrink-0"
              value={String(fontSize)}
              options={[
                ...(FONT_SIZES.includes(fontSize)
                  ? []
                  : [{ value: String(fontSize), label: String(fontSize) }]),
                ...FONT_SIZES.map((s) => ({ value: String(s), label: String(s) })),
              ]}
              onChange={(e) => setTextStyle('fontSize', Number(e.target.value))}
            />
          </Group_>
          <Group_>
            <IconButton
              size="sm"
              label={tr('加粗')}
              shortcut="Ctrl+B"
              aria-pressed={state.bold}
              onClick={() => toggleMark('bold')}
            >
              <Bold strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('斜体')}
              shortcut="Ctrl+I"
              aria-pressed={state.italic}
              onClick={() => toggleMark('italic')}
            >
              <Italic strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('下划线')}
              shortcut="Ctrl+U"
              aria-pressed={state.underline}
              onClick={() => toggleMark('underline')}
            >
              <Underline strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('删除线')}
              aria-pressed={state.strike}
              onClick={() => toggleMark('strike')}
            >
              <Strikethrough strokeWidth={S} aria-hidden />
            </IconButton>
            <ColorPicker
              label={tr('文字颜色')}
              theme={deck.theme}
              value={state.color}
              onChange={(c) => setTextStyle('color', c)}
              trigger={
                <ColorBar color={state.color ?? t0?.style.color ?? null}>
                  <Baseline size={16} strokeWidth={S} aria-hidden />
                </ColorBar>
              }
            />
          </Group_>
          <Sep />
          <Group_>
            {(
              [
                ['left', tr('左对齐'), AlignLeft],
                ['center', tr('居中'), AlignCenter],
                ['right', tr('右对齐'), AlignRight],
                ['justify', tr('两端对齐'), AlignJustify],
              ] as const
            ).map(([a, label, Icon]) => (
              <IconButton
                key={a}
                size="sm"
                label={label}
                aria-pressed={(state.align ?? 'left') === a}
                onClick={() => setAlign(a)}
              >
                <Icon strokeWidth={S} aria-hidden />
              </IconButton>
            ))}
            <IconButton
              size="sm"
              label={tr('项目符号')}
              aria-pressed={state.bullet}
              onClick={() => toggleList('bulletList')}
            >
              <List strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('编号')}
              aria-pressed={state.ordered}
              onClick={() => toggleList('orderedList')}
            >
              <ListOrdered strokeWidth={S} aria-hidden />
            </IconButton>
            <Select
              size="sm"
              aria-label={tr('行距')}
              wrapperClassName="w-20 shrink-0"
              value={String(state.lineHeight ?? 1.2)}
              options={[1, 1.2, 1.5, 2, 2.5, 3].map((v) => ({
                value: String(v),
                label: tr('行距 {v}', { v }),
              }))}
              onChange={(e) => setLineHeight(Number(e.target.value))}
            />
          </Group_>
          <Sep />
        </>
      )}

      {shapes.length > 0 && !editor && (
        <>
          <Group_>
            {first?.type === 'shape' && selected.length === 1 && (
              <Select
                size="sm"
                aria-label={tr('形状')}
                wrapperClassName="w-28 shrink-0"
                value={(first as ShapeElement).shape}
                options={[
                  ...(SHAPE_PRESETS.some((s) => s.id === (first as ShapeElement).shape)
                    ? []
                    : [{ value: (first as ShapeElement).shape, label: tr('自定义形状') }]),
                  ...SHAPE_PRESETS.map((s) => ({ value: s.id, label: s.label })),
                ]}
                onChange={(e) => patchAll([first], { shape: e.target.value, path: null, vb: null })}
              />
            )}
            <ColorPicker
              label={tr('填充颜色')}
              theme={deck.theme}
              value={fillColor}
              allowNone={tr('无填充')}
              onChange={(c) => patchAll(shapes, { fill: c ? { type: 'color', color: c } : null })}
              trigger={
                <ColorBar color={fillColor}>
                  <PaintBucket size={16} strokeWidth={S} aria-hidden />
                </ColorBar>
              }
            />
          </Group_>
        </>
      )}

      {strokeHolders.length > 0 && !editor && (
        <Group_>
          <ColorPicker
            label={lines.length ? tr('线条颜色') : tr('边框颜色')}
            theme={deck.theme}
            value={stroke0?.color ?? null}
            allowNone={lines.length === strokeHolders.length ? undefined : tr('无边框')}
            onChange={(c) =>
              patchAll(strokeHolders, (e) => ({
                stroke: c
                  ? {
                      width: strokeOf(e)?.width ?? 1.5,
                      dash: strokeOf(e)?.dash ?? 'solid',
                      color: c,
                    }
                  : null,
              }))
            }
            trigger={
              <ColorBar color={stroke0?.color ?? null}>
                <Square size={16} strokeWidth={S} aria-hidden />
              </ColorBar>
            }
          />
          <Select
            size="sm"
            aria-label={tr('线宽')}
            wrapperClassName="w-20 shrink-0"
            value={String(stroke0?.width ?? 0)}
            options={[0, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => ({
              value: String(w),
              label: w ? tr('{w} 磅', { w }) : tr('无线条'),
            }))}
            onChange={(e) => {
              const w = Number(e.target.value);
              patchAll(strokeHolders, (el) => ({
                stroke:
                  w === 0 && el.type !== 'line'
                    ? null
                    : {
                        color: strokeOf(el)?.color ?? deck.theme.fg,
                        dash: strokeOf(el)?.dash ?? 'solid',
                        width: Math.max(w, 0.75),
                      },
              }));
            }}
          />
          <Select
            size="sm"
            aria-label={tr('线型')}
            wrapperClassName="w-20 shrink-0"
            value={stroke0?.dash ?? 'solid'}
            options={[
              { value: 'solid', label: tr('实线') },
              { value: 'dash', label: tr('虚线') },
              { value: 'dot', label: tr('点线') },
            ]}
            onChange={(e) =>
              patchAll(strokeHolders, (el) => {
                const s = strokeOf(el);
                return s ? { stroke: { ...s, dash: e.target.value as DashKind } } : {};
              })
            }
          />
        </Group_>
      )}

      {lines.length > 0 && (
        <Group_>
          {(['start', 'end'] as const).map((end) => (
            <Select
              key={end}
              size="sm"
              aria-label={end === 'start' ? tr('起点') : tr('终点')}
              wrapperClassName="w-24 shrink-0"
              value={lines[0]![end]}
              options={(
                [
                  ['none', tr('无')],
                  ['triangle', tr('三角箭头')],
                  ['arrow', tr('开放箭头')],
                  ['stealth', tr('燕尾箭头')],
                  ['oval', tr('圆点')],
                  ['diamond', tr('菱形')],
                ] as const
              ).map(([v, l]) => ({
                value: v,
                label: tr('{value}：{l}', { value: end === 'start' ? tr('起点') : tr('终点'), l }),
              }))}
              onChange={(e) => patchAll(lines, { [end]: e.target.value as ArrowKind })}
            />
          ))}
        </Group_>
      )}

      {images.length === 1 && (
        <Group_>
          <button
            type="button"
            className="h-7 shrink-0 rounded-sm px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg"
            onClick={props.onReplaceImage}
          >
            {tr('替换图片')}
          </button>
          <Select
            size="sm"
            aria-label={tr('图片适应方式')}
            wrapperClassName="w-24 shrink-0"
            value={images[0]!.fit}
            options={[
              { value: 'fill', label: tr('拉伸') },
              { value: 'contain', label: tr('完整显示') },
              { value: 'cover', label: tr('填满裁切') },
            ]}
            onChange={(e) => patchAll(images, { fit: e.target.value })}
          />
          <CropPopover el={images[0]!} onChange={(crop) => patchAll(images, { crop })} />
          <Select
            size="sm"
            aria-label={tr('图片形状')}
            wrapperClassName="w-20 shrink-0"
            value={images[0]!.geom}
            options={[
              { value: 'rect', label: tr('矩形') },
              { value: 'roundRect', label: tr('圆角') },
              { value: 'ellipse', label: tr('圆形') },
            ]}
            onChange={(e) => patchAll(images, { geom: e.target.value })}
          />
        </Group_>
      )}

      {table && (
        <Group_>
          <Menu
            label={tr('行和列')}
            trigger={
              <IconButton size="sm" label={tr('行和列')}>
                <Rows3 strokeWidth={S} aria-hidden />
              </IconButton>
            }
          >
            {(() => {
              const r = props.tableCell?.r ?? table.cells.length - 1;
              const c = props.tableCell?.c ?? table.colW.length - 1;
              return (
                <>
                  <MenuLabel>
                    {props.tableCell
                      ? tr('第 {value} 行、第 {value2} 列', { value: r + 1, value2: c + 1 })
                      : tr('最后一行 / 列')}
                  </MenuLabel>
                  <MenuItem onSelect={() => tx(() => insertRow(table, r))}>
                    {tr('在上方插入行')}
                  </MenuItem>
                  <MenuItem onSelect={() => tx(() => insertRow(table, r + 1))}>
                    {tr('在下方插入行')}
                  </MenuItem>
                  <MenuItem onSelect={() => tx(() => insertCol(table, c))}>
                    {tr('在左侧插入列')}
                  </MenuItem>
                  <MenuItem onSelect={() => tx(() => insertCol(table, c + 1))}>
                    {tr('在右侧插入列')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem danger onSelect={() => tx(() => deleteRow(table, r))}>
                    {tr('删除这一行')}
                  </MenuItem>
                  <MenuItem danger onSelect={() => tx(() => deleteCol(table, c))}>
                    {tr('删除这一列')}
                  </MenuItem>
                </>
              );
            })()}
          </Menu>
          <IconButton
            size="sm"
            label={tr('标题行')}
            aria-pressed={table.header}
            onClick={() => patchAll([table], { header: !table.header })}
          >
            <Columns3 strokeWidth={S} aria-hidden />
          </IconButton>
          {props.tableCell && (
            <ColorPicker
              label={tr('单元格底色')}
              theme={deck.theme}
              value={table.cells[props.tableCell.r]?.[props.tableCell.c]?.fill ?? null}
              allowNone={tr('无填充')}
              onChange={(col) =>
                tx(() => setCellProp(table, props.tableCell!.r, props.tableCell!.c, 'fill', col))
              }
              trigger={
                <ColorBar color={table.cells[props.tableCell.r]?.[props.tableCell.c]?.fill ?? null}>
                  <PaintBucket size={16} strokeWidth={S} aria-hidden />
                </ColorBar>
              }
            />
          )}
        </Group_>
      )}

      {!editor && (
        <>
          <Sep />
          <Group_>
            <Menu
              label={tr('层级')}
              trigger={
                <IconButton size="sm" label={tr('层级')}>
                  <Layers strokeWidth={S} aria-hidden />
                </IconButton>
              }
            >
              <MenuItem icon={<BringToFront strokeWidth={S} />} onSelect={() => zMove('front')}>
                {tr('置于顶层')}
              </MenuItem>
              <MenuItem icon={<ArrowUpToLine strokeWidth={S} />} onSelect={() => zMove('forward')}>
                {tr('上移一层')}
              </MenuItem>
              <MenuItem
                icon={<ArrowDownToLine strokeWidth={S} />}
                onSelect={() => zMove('backward')}
              >
                {tr('下移一层')}
              </MenuItem>
              <MenuItem icon={<SendToBack strokeWidth={S} />} onSelect={() => zMove('back')}>
                {tr('置于底层')}
              </MenuItem>
            </Menu>
            <Menu
              label={tr('对齐')}
              trigger={
                <IconButton size="sm" label={tr('对齐与分布')}>
                  <AlignHorizontalJustifyCenter strokeWidth={S} aria-hidden />
                </IconButton>
              }
            >
              <MenuLabel>{selected.length === 1 ? tr('对齐到页面') : tr('对齐所选')}</MenuLabel>
              {(
                [
                  ['left', tr('左对齐')],
                  ['hcenter', tr('水平居中')],
                  ['right', tr('右对齐')],
                  ['top', tr('顶端对齐')],
                  ['vcenter', tr('垂直居中')],
                  ['bottom', tr('底端对齐')],
                ] as const
              ).map(([m, l]) => (
                <MenuItem key={m} onSelect={() => align(m)}>
                  {l}
                </MenuItem>
              ))}
              {selected.length >= 3 && (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => distribute('h')}>{tr('横向等距分布')}</MenuItem>
                  <MenuItem onSelect={() => distribute('v')}>{tr('纵向等距分布')}</MenuItem>
                </>
              )}
            </Menu>
            {selected.length > 1 && !selected.every((e) => e.group && e.group === first?.group) && (
              <IconButton size="sm" label={tr('组合')} shortcut="Ctrl+G" onClick={props.onGroup}>
                <Group strokeWidth={S} aria-hidden />
              </IconButton>
            )}
            {selected.some((e) => e.group) && (
              <IconButton
                size="sm"
                label={tr('取消组合')}
                shortcut="Ctrl+Shift+G"
                onClick={props.onUngroup}
              >
                <Ungroup strokeWidth={S} aria-hidden />
              </IconButton>
            )}
            <IconButton
              size="sm"
              label={tr('旋转 90°')}
              onClick={() => patchAll(selected, (e) => ({ rot: (e.rot + 90) % 360 }))}
            >
              <RotateCw strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('水平翻转')}
              onClick={() => patchAll(selected, (e) => ({ flipH: !e.flipH }))}
            >
              <FlipHorizontal2 strokeWidth={S} aria-hidden />
            </IconButton>
            <IconButton
              size="sm"
              label={tr('垂直翻转')}
              onClick={() => patchAll(selected, (e) => ({ flipV: !e.flipV }))}
            >
              <FlipVertical2 strokeWidth={S} aria-hidden />
            </IconButton>
            {selected.length === 1 && first && (
              <GeometryPopover el={first} onChange={(p) => patchAll([first], p)} />
            )}
            <IconButton size="sm" label={tr('删除')} shortcut="Delete" onClick={props.onDelete}>
              <Trash2 strokeWidth={S} aria-hidden />
            </IconButton>
          </Group_>
        </>
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  onCommit,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="flex items-center gap-2 text-small text-fg-muted">
      <span className="w-10 shrink-0">{label}</span>
      <input
        key={value}
        type="number"
        step={step}
        defaultValue={Math.round(value * 10) / 10}
        aria-label={label}
        className="h-7 w-20 rounded-sm border border-line-strong bg-surface px-2 text-small text-fg tabular-nums outline-none focus:border-accent"
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
      />
    </label>
  );
}

function GeometryPopover({ el, onChange }: { el: SlideElement; onChange: (p: Patch) => void }) {
  return (
    <Popover
      label={tr('位置和大小')}
      trigger={
        <button
          type="button"
          className="h-7 shrink-0 rounded-sm px-2 text-small text-fg-muted tabular-nums hover:bg-subtle hover:text-fg aria-expanded:bg-subtle"
        >
          {tr('位置')}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2 p-2">
        <NumField label="X" value={el.x} onCommit={(x) => onChange({ x })} />
        <NumField label="Y" value={el.y} onCommit={(y) => onChange({ y })} />
        <NumField
          label={tr('宽度')}
          value={el.w}
          onCommit={(w) => onChange({ w: Math.max(1, w) })}
        />
        <NumField
          label={tr('高度')}
          value={el.h}
          onCommit={(h) => onChange({ h: Math.max(0, h) })}
        />
        <NumField
          label={tr('旋转')}
          value={el.rot}
          onCommit={(r) => onChange({ rot: ((r % 360) + 360) % 360 })}
        />
        <span className="self-center text-caption text-fg-subtle">{tr('单位：磅')}</span>
      </div>
    </Popover>
  );
}

function CropPopover({
  el,
  onChange,
}: {
  el: ImageElement;
  onChange: (crop: ImageElement['crop']) => void;
}) {
  const c = el.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const set = (k: 'l' | 't' | 'r' | 'b', v: number) => {
    const next = { ...c, [k]: Math.max(0, Math.min(0.9, v / 100)) };
    onChange(next.l || next.t || next.r || next.b ? next : null);
  };
  return (
    <Popover
      label={tr('裁剪')}
      trigger={
        <IconButton size="sm" label={tr('裁剪')}>
          <Crop strokeWidth={S} aria-hidden />
        </IconButton>
      }
    >
      <div className="flex flex-col gap-2 p-2">
        <span className="text-caption text-fg-subtle">{tr('从各边裁掉的比例（%）')}</span>
        <div className="grid grid-cols-2 gap-2">
          <NumField label={tr('左')} value={c.l * 100} onCommit={(v) => set('l', v)} />
          <NumField label={tr('右')} value={c.r * 100} onCommit={(v) => set('r', v)} />
          <NumField label={tr('上')} value={c.t * 100} onCommit={(v) => set('t', v)} />
          <NumField label={tr('下')} value={c.b * 100} onCommit={(v) => set('b', v)} />
        </div>
        {el.crop && (
          <button
            type="button"
            className="self-start rounded-sm px-2 py-1 text-small text-fg-muted hover:bg-subtle hover:text-fg"
            onClick={() => onChange(null)}
          >
            {tr('还原')}
          </button>
        )}
      </div>
    </Popover>
  );
}
