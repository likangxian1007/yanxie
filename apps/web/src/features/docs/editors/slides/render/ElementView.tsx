import { memo, useId, type CSSProperties, type ReactNode } from 'react';
import { withBase } from '@/lib/base-path';
import { pmIsEmpty } from '../model/richtext';
import { PLACEHOLDER_PROMPT, WHITE, cssFont } from '../model/themes';
import type {
  ArrowKind,
  Fill,
  ImageElement,
  LineElement,
  ShapeElement,
  SlideElement,
  Stroke,
  TableElement,
  TextElement,
  Theme,
} from '../model/types';
import { RichTextStatic } from './RichText';
import { shapePath } from './shapes';
import { tr } from '@/lib/i18n';

/**
 * 单个元素的渲染。页面坐标系用 CSS 的 pt 单位（1 个模型单位 = 1pt），整页再用 transform 缩放，
 * 所以字号、线宽、位置在任何缩放下都与 PowerPoint 一致。
 * 编辑画布通过 textSlot / tableSlot 把 Tiptap 编辑器、表格编辑器放进同一个外壳，保证所见即所得。
 */

export const pt = (n: number) => `${Math.round(n * 100) / 100}pt`;

export function fillCss(fill: Fill | null | undefined): CSSProperties {
  if (!fill) return {};
  if (fill.type === 'color') return { backgroundColor: fill.color };
  if (fill.type === 'gradient') {
    const stops = fill.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ');
    return { backgroundImage: `linear-gradient(${fill.angle + 90}deg, ${stops})` };
  }
  return {
    backgroundImage: `url("${fill.src.replace(/"/gu, '%22')}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  };
}

export function dashArray(stroke: Stroke | null | undefined): string | undefined {
  if (!stroke || !stroke.dash || stroke.dash === 'solid') return undefined;
  const w = Math.max(1, stroke.width);
  return stroke.dash === 'dot' ? `${w} ${w * 1.5}` : `${w * 4} ${w * 2.5}`;
}

interface SlotProps {
  /** 替换文字内容（编辑态放 Tiptap） */
  textSlot?: ReactNode;
  /** 替换表格（编辑态） */
  tableSlot?: ReactNode;
  /** 空占位符显示提示文字（编辑画布） */
  showPrompt?: boolean;
}

export interface ElementViewProps extends SlotProps {
  el: SlideElement;
  theme: Theme;
  className?: string;
}

export const ElementView = memo(function ElementView({
  el,
  theme,
  className,
  ...slots
}: ElementViewProps) {
  const style: CSSProperties = {
    position: 'absolute',
    left: pt(el.x),
    top: pt(el.y),
    width: pt(el.w),
    height: pt(el.h),
    transform: el.rot ? `rotate(${el.rot}deg)` : undefined,
  };
  let inner: ReactNode = null;
  if (el.type === 'text' || el.type === 'shape') inner = <TextShape el={el} {...slots} />;
  else if (el.type === 'image') inner = <ImageView el={el} />;
  else if (el.type === 'line') inner = <LineView el={el} />;
  else if (el.type === 'table') inner = slots.tableSlot ?? <TableStatic el={el} theme={theme} />;
  return (
    <div className={className ? `sl-el ${className}` : 'sl-el'} data-el={el.id} style={style}>
      {inner}
    </div>
  );
});

export function textBoxStyle(el: TextElement | ShapeElement): CSSProperties {
  const s = el.style;
  return {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent:
      el.valign === 'middle' ? 'center' : el.valign === 'bottom' ? 'flex-end' : 'flex-start',
    padding: `${pt(el.pad[1])} ${pt(el.pad[2])} ${pt(el.pad[3])} ${pt(el.pad[0])}`,
    fontSize: pt(s.fontSize * (el.fontScale || 1)),
    color: s.color,
    fontFamily: cssFont(s.fontFamily),
    fontWeight: s.bold ? 700 : 400,
    textAlign: s.align ?? 'left',
    lineHeight: s.lineHeight ?? 1.2,
    writingMode: el.vertical ? 'vertical-rl' : undefined,
  };
}

function TextShape({ el, textSlot, showPrompt }: { el: TextElement | ShapeElement } & SlotProps) {
  const empty = !textSlot && pmIsEmpty(el.doc);
  const prompt = showPrompt && empty && el.ph ? PLACEHOLDER_PROMPT[el.ph] : null;
  return (
    <>
      {el.type === 'shape' ? (
        <ShapeSvg el={el} />
      ) : (
        (el.fill || el.stroke) && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              ...fillCss(el.fill),
              border: el.stroke
                ? `${pt(el.stroke.width)} ${el.stroke.dash === 'dot' ? 'dotted' : el.stroke.dash === 'dash' ? 'dashed' : 'solid'} ${el.stroke.color}`
                : undefined,
            }}
          />
        )
      )}
      <div className="sl-text" style={textBoxStyle(el)}>
        {prompt ? (
          <div className="sl-prompt">{prompt}</div>
        ) : (
          (textSlot ?? (
            <div className="sl-text-body">
              <RichTextStatic doc={el.doc} />
            </div>
          ))
        )}
      </div>
    </>
  );
}

function ShapeSvg({ el }: { el: ShapeElement }) {
  const uid = useId().replace(/:/gu, '');
  const custom = el.path && el.vb;
  const w = Math.max(el.w, 0.01);
  const h = Math.max(el.h, 0.01);
  const d = custom ? (el.path as string) : shapePath(el.shape, w, h);
  const vb = custom ? `0 0 ${el.vb![0]} ${el.vb![1]}` : `0 0 ${w} ${h}`;
  // 自定义路径的 viewBox 是导入时的原尺寸：线宽按缩放比例折算回 pt
  const strokeScale = custom ? Math.sqrt((el.vb![0] / w) * (el.vb![1] / h)) || 1 : 1;
  let fill = 'none';
  let defs: ReactNode = null;
  if (el.fill?.type === 'color') fill = el.fill.color;
  else if (el.fill?.type === 'gradient') {
    const a = ((el.fill.angle % 360) * Math.PI) / 180;
    const x = Math.cos(a) / 2;
    const y = Math.sin(a) / 2;
    defs = (
      <defs>
        <linearGradient id={`g${uid}`} x1={0.5 - x} y1={0.5 - y} x2={0.5 + x} y2={0.5 + y}>
          {el.fill.stops.map((s, i) => (
            <stop key={i} offset={s.pos} stopColor={s.color} />
          ))}
        </linearGradient>
      </defs>
    );
    fill = `url(#g${uid})`;
  } else if (el.fill?.type === 'image') {
    defs = (
      <defs>
        <pattern id={`p${uid}`} width="1" height="1" patternContentUnits="objectBoundingBox">
          <image
            href={withBase(el.fill.src)}
            width="1"
            height="1"
            preserveAspectRatio="xMidYMid slice"
          />
        </pattern>
      </defs>
    );
    fill = `url(#p${uid})`;
  }
  const flip =
    el.flipH || el.flipV ? `scale(${el.flipH ? -1 : 1} ${el.flipV ? -1 : 1})` : undefined;
  return (
    <svg
      aria-hidden
      viewBox={vb}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        transform: flip,
      }}
    >
      {defs}
      <path
        d={d}
        fill={fill}
        stroke={el.stroke?.color ?? 'none'}
        strokeWidth={el.stroke ? el.stroke.width * strokeScale : undefined}
        strokeDasharray={dashArray(el.stroke)}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ImageView({ el }: { el: ImageElement }) {
  const radius = el.geom === 'ellipse' ? '50%' : el.geom === 'roundRect' ? '8%' : undefined;
  const c = el.crop;
  const visW = c ? Math.max(0.05, 1 - c.l - c.r) : 1;
  const visH = c ? Math.max(0.05, 1 - c.t - c.b) : 1;
  const imgStyle: CSSProperties = c
    ? {
        position: 'absolute',
        width: `${100 / visW}%`,
        height: `${100 / visH}%`,
        left: `${(-c.l / visW) * 100}%`,
        top: `${(-c.t / visH) * 100}%`,
        maxWidth: 'none',
      }
    : {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: el.fit === 'fill' ? 'fill' : el.fit,
      };
  const transform =
    el.flipH || el.flipV ? `scale(${el.flipH ? -1 : 1}, ${el.flipV ? -1 : 1})` : undefined;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        borderRadius: radius,
        transform,
        outline: el.stroke ? `${pt(el.stroke.width)} solid ${el.stroke.color}` : undefined,
        outlineOffset: el.stroke ? `-${pt(el.stroke.width)}` : undefined,
      }}
    >
      {el.src ? (
        <img
          src={withBase(el.src)}
          alt={el.name || tr('图片')}
          draggable={false}
          style={imgStyle}
        />
      ) : null}
    </div>
  );
}

function arrowPath(kind: ArrowKind): ReactNode {
  switch (kind) {
    case 'triangle':
      return <path d="M0 0 L10 5 L0 10 Z" fill="context-stroke" />;
    case 'stealth':
      return <path d="M0 0 L10 5 L0 10 L3 5 Z" fill="context-stroke" />;
    case 'arrow':
      return (
        <path
          d="M1 1 L9 5 L1 9"
          fill="none"
          stroke="context-stroke"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'oval':
      return <circle cx="5" cy="5" r="4" fill="context-stroke" />;
    case 'diamond':
      return <path d="M5 0 L10 5 L5 10 L0 5 Z" fill="context-stroke" />;
    default:
      return null;
  }
}

export function lineEnds(el: { w: number; h: number; flipH: boolean; flipV: boolean }) {
  const x1 = el.flipH ? el.w : 0;
  const x2 = el.flipH ? 0 : el.w;
  const y1 = el.flipV ? el.h : 0;
  const y2 = el.flipV ? 0 : el.h;
  return { x1, y1, x2, y2 };
}

const padOf = (sw: number) => Math.max(4, sw * 4);

function LineView({ el }: { el: LineElement }) {
  const uid = useId().replace(/:/gu, '');
  const { x1, y1, x2, y2 } = lineEnds(el);
  const sw = el.stroke.width;
  const marker = (kind: ArrowKind, id: string, start: boolean) =>
    kind === 'none' ? null : (
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX={kind === 'oval' || kind === 'diamond' ? 5 : start ? 1 : 9}
        refY="5"
        markerWidth="4"
        markerHeight="4"
        orient={start ? 'auto-start-reverse' : 'auto'}
        markerUnits="strokeWidth"
      >
        {arrowPath(kind)}
      </marker>
    );
  return (
    // 水平 / 竖直线的盒子高或宽为 0，浏览器不画面积为 0 的 SVG：四周留出线宽与箭头的余量
    <svg
      aria-hidden
      style={{
        position: 'absolute',
        left: pt(-padOf(sw)),
        top: pt(-padOf(sw)),
        width: pt(el.w + 2 * padOf(sw)),
        height: pt(el.h + 2 * padOf(sw)),
        overflow: 'visible',
      }}
      viewBox={`${-padOf(sw)} ${-padOf(sw)} ${el.w + 2 * padOf(sw)} ${el.h + 2 * padOf(sw)}`}
    >
      <defs>
        {marker(el.start, `s${uid}`, true)}
        {marker(el.end, `e${uid}`, false)}
      </defs>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={el.stroke.color}
        strokeWidth={sw}
        strokeDasharray={dashArray(el.stroke)}
        strokeLinecap={el.start === 'none' && el.end === 'none' ? 'round' : 'butt'}
        markerStart={el.start !== 'none' ? `url(#s${uid})` : undefined}
        markerEnd={el.end !== 'none' ? `url(#e${uid})` : undefined}
      />
    </svg>
  );
}

export function cellStyle(el: TableElement, theme: Theme, r: number, c: number): CSSProperties {
  const cell = el.cells[r]?.[c];
  const head = el.header && r === 0;
  const b = el.border;
  return {
    border: b ? `${pt(b.width)} solid ${b.color}` : undefined,
    backgroundColor: cell?.fill ?? (head ? theme.accent : undefined),
    color: cell?.color ?? (head ? WHITE : el.style.color),
    fontWeight: cell?.bold || head ? 700 : 400,
    fontStyle: cell?.italic ? 'italic' : undefined,
    textAlign: cell?.align ?? 'left',
    fontSize: cell?.fontSize ? pt(cell.fontSize) : undefined,
    padding: `${pt(3.6)} ${pt(5.4)}`,
    verticalAlign: 'middle',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'hidden',
  };
}

export function TableStatic({ el, theme }: { el: TableElement; theme: Theme }) {
  return (
    <table
      className="sl-table"
      style={{
        fontSize: pt(el.style.fontSize),
        fontFamily: cssFont(el.style.fontFamily),
        color: el.style.color,
      }}
    >
      <colgroup>
        {el.colW.map((w, i) => (
          <col key={i} style={{ width: pt(w) }} />
        ))}
      </colgroup>
      <tbody>
        {el.cells.map((row, r) => (
          <tr key={r} style={{ height: el.rowH[r] ? pt(el.rowH[r]!) : undefined }}>
            {row.map((cell, c) =>
              cell.hidden ? null : (
                <td
                  key={c}
                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  style={cellStyle(el, theme, r, c)}
                >
                  {cell.text}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
