import { useMemo, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { BarChart3, LineChart, X } from 'lucide-react';
import { IconButton, Tabs } from '@/components/ui';
import { useMotionPreset } from '@/lib/motion';
import { paletteVar } from '@/lib/palette';
import { useElementSize } from '../shared/dom';
import type { CellValue } from './engine/values';
import { rangeLabel, type CellRange } from './lib/a1';
import { buildChartData, niceScale } from './lib/chart';
import { tr } from '@/lib/i18n';

export type ChartKind = 'bar' | 'line';

interface SheetChartProps {
  range: CellRange;
  /** 取值（公式已求值）；version 变化时重新读 */
  get: (row: number, col: number) => CellValue;
  version: number;
  kind: ChartKind;
  onKindChange: (kind: ChartKind) => void;
  onClose: () => void;
}

const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function shortNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${Number.parseFloat((n / 1e9).toFixed(1))}B`;
  if (abs >= 1e6) return `${Number.parseFloat((n / 1e6).toFixed(1))}M`;
  if (abs >= 1e4) return `${Number.parseFloat((n / 1e3).toFixed(1))}k`;
  return String(Number.parseFloat(n.toPrecision(4)));
}

/** 极简 SVG 图表（柱状 / 折线），随单元格实时变化；不持久化。 */
export function SheetChart({ range, get, version, kind, onKindChange, onClose }: SheetChartProps) {
  const { variants } = useMotionPreset();
  const [ref, size] = useElementSize<HTMLDivElement>();
  const data = useMemo(
    () => buildChartData(range, get),
    // version：表格内容变了就重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, get, version],
  );
  const width = Math.max(240, size.width);

  let body: ReactNode;
  if (!data) {
    body = (
      <p className="py-10 text-center text-small text-fg-muted">
        {tr('选区里没有数字。选中包含数字的区域（可带表头和类别列）再插入图表。')}
      </p>
    );
  } else {
    const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const { lo, hi, step } = niceScale(Math.min(...all), Math.max(...all));
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const n = data.categories.length;
    const band = plotW / n;
    const ticks: number[] = [];
    for (let t = lo; t <= hi + step / 2; t += step)
      ticks.push(Number.parseFloat(t.toPrecision(12)));
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 56))));
    const groupW = band * 0.72;
    const barW = groupW / data.series.length;

    body = (
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={tr('{value}：{value2}', {
          value: kind === 'bar' ? tr('柱状图') : tr('折线图'),
          value2: data.series.map((s) => s.name).join(tr('、')),
        })}
        className="block"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              style={{ stroke: 'var(--line)' }}
              strokeDasharray={t === 0 ? undefined : '3 3'}
            />
            <text
              x={PAD.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="text-caption tabular-nums"
              style={{ fill: 'var(--fg-subtle)' }}
            >
              {shortNum(t)}
            </text>
          </g>
        ))}
        {data.categories.map((c, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`${c}-${i}`}
              x={PAD.left + band * i + band / 2}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="text-caption"
              style={{ fill: 'var(--fg-muted)' }}
            >
              {c.length > 8 ? `${c.slice(0, 7)}…` : c}
            </text>
          ) : null,
        )}
        {kind === 'bar'
          ? data.series.map((s, si) =>
              s.values.map((v, i) => {
                if (v === null) return null;
                const x = PAD.left + band * i + (band - groupW) / 2 + barW * si;
                const top = Math.min(y(v), y(0));
                const h = Math.abs(y(v) - y(0));
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={x + 1}
                    y={top}
                    width={Math.max(1, barW - 2)}
                    height={Math.max(1, h)}
                    rx={2}
                    style={{ fill: paletteVar(si) }}
                  >
                    <title>
                      {tr('{name} · {value}：{v}', { name: s.name, value: data.categories[i], v })}
                    </title>
                  </rect>
                );
              }),
            )
          : data.series.map((s, si) => {
              const pts = s.values
                .map((v, i) => (v === null ? null : [PAD.left + band * i + band / 2, y(v)]))
                .filter((p): p is number[] => p !== null);
              return (
                <g key={si} style={{ stroke: paletteVar(si), fill: paletteVar(si) }}>
                  <polyline
                    points={pts.map((p) => p.join(',')).join(' ')}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {pts.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={2.5} />
                  ))}
                </g>
              );
            })}
      </svg>
    );
  }

  return (
    <motion.section
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      exit="exit"
      aria-label={tr('图表')}
      className="shrink-0 border-b border-line bg-surface px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-h3 text-fg">{tr('图表')}</h3>
        <span className="font-mono text-caption text-fg-subtle">{rangeLabel(range)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Tabs
            variant="segmented"
            size="sm"
            layoutId="sheet-chart-kind"
            aria-label={tr('图表类型')}
            value={kind}
            onValueChange={onKindChange}
            items={[
              {
                value: 'bar',
                label: tr('柱状'),
                icon: <BarChart3 strokeWidth={1.75} aria-hidden />,
              },
              {
                value: 'line',
                label: tr('折线'),
                icon: <LineChart strokeWidth={1.75} aria-hidden />,
              },
            ]}
          />
          <IconButton label={tr('关闭图表')} size="sm" onClick={onClose}>
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
      </div>
      <div ref={ref} className="w-full overflow-hidden">
        {body}
      </div>
      {data && data.series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {data.series.map((s, i) => (
            <li key={s.name + i} className="flex items-center gap-1.5 text-caption text-fg-muted">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: paletteVar(i) }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}
