import {
  ApiError,
  type ResearchCellValue,
  type ResearchChartSpec,
  type ResearchStructuredTable,
  type ResearchTableColumn,
  type ResearchTableSeed,
  type ResearchTableTransform,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { findChromium } from '../notebooks/export';
import { stableResearchColumnId } from './tables';

type Row = ResearchStructuredTable['rows'][number];
const fail = (message: string): never => {
  throw new ApiError('validation_failed', message);
};
const missing = (value: ResearchCellValue | undefined) =>
  value === null || value === undefined || value === '';
const compare = (a: ResearchCellValue, b: ResearchCellValue) => {
  if (missing(a)) return missing(b) ? 0 : 1;
  if (missing(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

/** 按明确配置计算；缺失值不会变成零，也不换算单位。 */
export function transformResearchTable(
  table: ResearchStructuredTable,
  spec: ResearchTableTransform,
) {
  const byId = new Map(table.columns.map((column) => [column.id, column]));
  const requireColumn = (id: string) => byId.get(id) ?? fail(`找不到数据列 ${id}`);
  const named = [
    ...(spec.select ?? []),
    ...(spec.groupBy ?? []),
    ...(spec.deduplicateBy ?? []),
    ...(spec.filters ?? []).map((filter) => filter.columnId),
    ...(spec.sort ?? []).map((sort) => sort.columnId),
    ...(spec.aggregates ?? []).flatMap((aggregate) =>
      aggregate.columnId ? [aggregate.columnId] : [],
    ),
  ];
  named.forEach(requireColumn);
  if (spec.aggregates?.some((aggregate) => aggregate.op !== 'count' && !aggregate.columnId))
    fail('求和或均值必须指定列');
  if (spec.groupBy?.length && !spec.aggregates?.length) fail('分组必须指定至少一项统计');
  if (
    spec.aggregates?.length &&
    spec.select?.length &&
    (spec.select.some((id) => !(spec.groupBy ?? []).includes(id)) ||
      (spec.groupBy ?? []).some((id) => !spec.select!.includes(id)))
  )
    fail('分组计算时输出列须包含全部分组列；统计结果列会自动添加');
  for (const sort of spec.sort ?? []) {
    const column = requireColumn(sort.columnId);
    if (
      column.type === 'number' &&
      table.rows.some(
        (row) => !missing(row.cells[sort.columnId]) && typeof row.cells[sort.columnId] !== 'number',
      )
    )
      fail(`列「${column.name}」包含非数值，无法按数值排序`);
  }
  for (const filter of spec.filters ?? []) {
    const column = requireColumn(filter.columnId);
    if (column.type === 'number' && !['missing', 'present'].includes(filter.operator)) {
      if (typeof filter.value !== 'number') fail(`列「${column.name}」需要数值筛选条件`);
      if (
        table.rows.some(
          (row) =>
            !missing(row.cells[filter.columnId]) && typeof row.cells[filter.columnId] !== 'number',
        )
      )
        fail(`列「${column.name}」包含非数值，无法按数值筛选`);
    }
  }
  let rows = table.rows.filter((row) =>
    (spec.filters ?? []).every((filter) => {
      const value = row.cells[filter.columnId] ?? null;
      const target = filter.value ?? null;
      switch (filter.operator) {
        case 'missing':
          return missing(value);
        case 'present':
          return !missing(value);
        case 'eq':
          return value === target;
        case 'ne':
          return value !== target;
        case 'contains':
          return !missing(value) && String(value).includes(String(target ?? ''));
        default: {
          if (missing(value) || missing(target)) return false;
          if (typeof value !== typeof target) fail('筛选比较值的类型与数据不一致');
          const order = compare(value, target);
          return filter.operator === 'gt'
            ? order > 0
            : filter.operator === 'gte'
              ? order >= 0
              : filter.operator === 'lt'
                ? order < 0
                : order <= 0;
        }
      }
    }),
  );
  if (spec.sort?.length)
    rows = [...rows].sort((a, b) => {
      for (const sort of spec.sort ?? []) {
        const result = compare(a.cells[sort.columnId] ?? null, b.cells[sort.columnId] ?? null);
        if (result) return sort.direction === 'desc' ? -result : result;
      }
      return 0;
    });
  if (spec.deduplicateBy?.length) {
    const seen = new Set<string>();
    rows = rows.filter((row) => {
      const key = JSON.stringify(spec.deduplicateBy!.map((id) => row.cells[id] ?? null));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  let columns: ResearchTableColumn[];
  let results: Array<{ values: ResearchCellValue[]; sourceRows: string[] }>;
  if (spec.aggregates?.length) {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify((spec.groupBy ?? []).map((id) => row.cells[id] ?? null));
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    if (!spec.groupBy?.length && !groups.size) groups.set('[]', []);
    const aggregateColumns: ResearchTableColumn[] = spec.aggregates.map((aggregate) => {
      const source = aggregate.columnId ? requireColumn(aggregate.columnId) : undefined;
      return {
        id: stableResearchColumnId({
          op: aggregate.op,
          columnId: aggregate.columnId ?? null,
          as: aggregate.as,
        }),
        name: aggregate.as,
        type: 'number',
        ...(aggregate.op !== 'count' && source?.unit ? { unit: source.unit } : {}),
      };
    });
    if (new Set(aggregateColumns.map((column) => column.id)).size !== aggregateColumns.length)
      fail('统计输出不能重复，请为每项统计指定不同的名称');
    columns = [...(spec.groupBy ?? []).map(requireColumn), ...aggregateColumns];
    results = [...groups.values()].map((group) => {
      const keys = (spec.groupBy ?? []).map((id) => group[0]?.cells[id] ?? null);
      const values = spec.aggregates!.map((aggregate) => {
        const present = aggregate.columnId
          ? group
              .map((row) => row.cells[aggregate.columnId!] ?? null)
              .filter((value) => !missing(value))
          : group.map(() => 1);
        if (aggregate.op === 'count') return present.length;
        if (present.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
          fail(
            `列「${requireColumn(aggregate.columnId!).name}」包含非数值，无法计算${aggregate.op === 'sum' ? '求和' : '均值'}`,
          );
        if (!present.length) return null;
        const sum = (present as number[]).reduce((a, b) => a + b, 0);
        if (!Number.isFinite(sum)) fail('统计结果超出可表示的数值范围');
        return aggregate.op === 'sum' ? sum : sum / present.length;
      });
      return { values: [...keys, ...values], sourceRows: group.map((row) => row.id) };
    });
  } else {
    columns = (spec.select?.length ? spec.select : table.columns.map((column) => column.id)).map(
      requireColumn,
    );
    results = rows.map((row) => ({
      values: columns.map((column) => row.cells[column.id] ?? null),
      sourceRows: [row.id],
    }));
  }
  const seed: ResearchTableSeed = { columns, rows: results.map((result) => result.values) };
  return {
    seed,
    audit: {
      transform: spec,
      inputRows: table.totalRows,
      outputRows: results.length,
      sourceRows: results.map((result) => result.sourceRows),
    },
  };
}

const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
const number = (value: ResearchCellValue | undefined, label: string): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(`「${label}」包含非数值，无法绘图`);
const palette = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9'];

/** SVG 直接从实际数据计算；缺失值策略和轴单位随配置保存。 */
export function chartResearchTable(table: ResearchStructuredTable, spec: ResearchChartSpec) {
  const byId = new Map(table.columns.map((column) => [column.id, column]));
  const x = byId.get(spec.xColumn) ?? fail('找不到横轴列');
  const ys = spec.yColumns.map((id) => byId.get(id) ?? fail(`找不到纵轴列 ${id}`));
  if (new Set(ys.map((column) => column.unit ?? '')).size > 1)
    fail('纵轴列单位不同，不能直接绘制在同一坐标轴');
  if (new Set(spec.yColumns).size !== spec.yColumns.length) fail('纵轴列不能重复');
  const data = table.rows.flatMap((row) => {
    const values = [row.cells[x.id] ?? null, ...ys.map((column) => row.cells[column.id] ?? null)];
    if (values.some(missing)) {
      if (spec.missing === 'error') fail(`数据行 ${row.id} 含缺失值`);
      return [];
    }
    const xv = values[0]!;
    if (spec.kind === 'scatter') number(xv, x.name);
    return [{ id: row.id, x: xv, ys: values.slice(1).map((v, i) => number(v, ys[i]!.name)) }];
  });
  if (!data.length) fail('没有可绘制的数据行');
  if (data.length > 10000) fail('基础图表最多绘制 10000 行，请先筛选数据或使用 Notebook');
  const xNumeric =
    spec.kind === 'scatter' ||
    (spec.kind === 'line' && data.every((point) => typeof point.x === 'number'));
  const xValues = xNumeric ? data.map((point) => point.x as number) : data.map((_point, i) => i);
  let xmin = Math.min(...xValues),
    xmax = Math.max(...xValues);
  if (!xNumeric) {
    xmin -= 0.5;
    xmax += 0.5;
  } else if (xmin === xmax) {
    xmin -= 0.5;
    xmax += 0.5;
  }
  const allY = data.flatMap((point) => point.ys);
  let ymin = allY.reduce((min, value) => Math.min(min, value), Infinity);
  let ymax = allY.reduce((max, value) => Math.max(max, value), -Infinity);
  if (spec.kind === 'bar') {
    ymin = Math.min(ymin, 0);
    ymax = Math.max(ymax, 0);
  }
  if (ymin === ymax) {
    const pad = Math.abs(ymin) * 0.1 || 1;
    ymin -= pad;
    ymax += pad;
  }
  const extraLegendHeight = Math.max(0, Math.ceil(ys.length / 5) - 1) * 20;
  const left = 105,
    top = 75 + extraLegendHeight,
    width = 800,
    height = 445 - extraLegendHeight;
  const px = (n: number) => left + ((n - xmin) / (xmax - xmin)) * width;
  const py = (n: number) => top + height - ((n - ymin) / (ymax - ymin)) * height;
  const label = (column: ResearchTableColumn) =>
    `${column.name}${column.unit ? ` (${column.unit})` : ''}`;
  const withUnit = (name: string, unit?: string) =>
    unit && !name.includes(unit) ? `${name} (${unit})` : name;
  const xLabel = spec.xLabel ? withUnit(spec.xLabel, x.unit) : label(x);
  const yLabel = spec.yLabel
    ? withUnit(spec.yLabel, ys[0]!.unit)
    : ys.length === 1
      ? label(ys[0]!)
      : `数值${ys[0]!.unit ? ` (${ys[0]!.unit})` : ''}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">`,
    '<rect width="960" height="640" fill="white"/>',
    '<g font-family="Noto Sans CJK SC, sans-serif" fill="#222" font-size="15">',
    `<text x="480" y="32" text-anchor="middle" font-size="20">${escapeXml(spec.title || '数据图表')}</text>`,
    `<text x="505" y="610" text-anchor="middle">${escapeXml(xLabel)}</text>`,
    `<text x="25" y="300" text-anchor="middle" transform="rotate(-90 25 300)">${escapeXml(yLabel)}</text>`,
    `<path d="M${left} ${top}V${top + height}H${left + width}" fill="none" stroke="#333"/>`,
  ];
  for (let i = 0; i <= 5; i++) {
    const value = ymin + ((ymax - ymin) * i) / 5,
      yy = py(value);
    svg.push(
      `<path d="M${left} ${yy}H${left + width}" stroke="#e2e2e2"/><text x="${left - 10}" y="${yy + 5}" text-anchor="end">${escapeXml(Number(value.toPrecision(5)).toString())}</text>`,
    );
  }
  if (xNumeric) {
    for (let i = 0; i <= 5; i++) {
      const value = xmin + ((xmax - xmin) * i) / 5;
      svg.push(
        `<text x="${px(value)}" y="${top + height + 23}" text-anchor="middle">${escapeXml(Number(value.toPrecision(5)).toString())}</text>`,
      );
    }
  } else {
    const step = Math.max(1, Math.ceil(data.length / 12));
    data.forEach((point, i) => {
      if (i % step === 0)
        svg.push(
          `<text x="${px(i)}" y="${top + height + 23}" text-anchor="middle">${escapeXml(String(point.x).slice(0, 18))}</text>`,
        );
    });
  }
  ys.forEach((column, j) => {
    const color = palette[j % palette.length]!;
    svg.push(
      `<text x="${left + (j % 5) * 160}" y="${60 + Math.floor(j / 5) * 20}" fill="${color}">${escapeXml(column.name.slice(0, 14))}</text>`,
    );
    if (spec.kind === 'line')
      svg.push(
        `<polyline fill="none" stroke="${color}" stroke-width="2" points="${data.map((p, i) => `${px(xNumeric ? (p.x as number) : i)},${py(p.ys[j]!)}`).join(' ')}"/>`,
      );
    data.forEach((point, i) => {
      const xx = px(xNumeric ? (point.x as number) : i),
        yy = py(point.ys[j]!);
      if (spec.kind === 'bar') {
        const barWidth = Math.min(40, (width / Math.max(1, data.length) / ys.length) * 0.8);
        const base = py(0);
        svg.push(
          `<rect x="${xx + (j - (ys.length - 1) / 2) * barWidth - barWidth / 2}" y="${Math.min(yy, base)}" width="${barWidth}" height="${Math.abs(base - yy)}" fill="${color}"/>`,
        );
      } else svg.push(`<circle cx="${xx}" cy="${yy}" r="3" fill="${color}"/>`);
    });
  });
  svg.push('</g></svg>');
  return {
    svg: svg.join(''),
    plottedRows: data.map((point) => point.id),
    omittedRows: table.rows.length - data.length,
    xLabel,
    yLabel,
  };
}

/** 使用现有离线 Chromium 把同一 SVG 渲染成 PNG；禁用脚本与网络。 */
export async function chartPng(ctx: AppContext, svg: string): Promise<Buffer> {
  const executablePath = findChromium(ctx.config.PDF_CHROMIUM_PATH);
  if (!executablePath) throw new ApiError('not_implemented', '服务器未配置 Chromium，无法导出 PNG');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      viewport: { width: 960, height: 640 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="margin:0">${svg}</body></html>`,
      { waitUntil: 'load', timeout: 60000 },
    );
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}
