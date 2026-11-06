import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  ApiError,
  sheetTypeName,
  type ActorRef,
  type ResearchCellValue,
  type ResearchItem,
  type ResearchStructuredTable,
  type ResearchTableColumn,
  type ResearchTableSeed,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  createDocument,
  getRow,
  persistDocument,
  withDocumentSnapshot,
} from '../documents/service';
import { ensureWorkbook, listSheets, SHEET_MAX, writeCells } from '../documents/sheet-model';
import { checkResource } from './service';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 生成不会与 Y.Doc 单元格键分隔符冲突的确定性列标识。 */
export const stableResearchColumnId = (value: unknown) => `c_${hash(value).slice(0, 24)}`;

/** 导入的文本始终是字面量，不能将模型返回的内容当作公式执行。 */
function literal(value: ResearchCellValue): string {
  if (value === null) return '';
  const text = String(value);
  return typeof value === 'string' && (text.startsWith('=') || text.startsWith("'"))
    ? `'${text}`
    : text;
}

/** 新表和现有编辑器共用同一个 Y.Doc，第一行为列名。 */
export async function createResearchTable(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  title: string,
  seed?: ResearchTableSeed,
): Promise<{
  documentId: string;
  sheetId: string;
  columns: ResearchTableColumn[];
  rowIds: string[];
}> {
  if (seed && (seed.rows.length + 1 > SHEET_MAX.rows || seed.columns.length > SHEET_MAX.cols))
    throw new ApiError('validation_failed', '表格超过工作簿的行列上限');
  if (seed && seed.rows.some((row) => row.length > seed.columns.length))
    throw new ApiError('validation_failed', '数据行包含未声明的列');
  if (seed && new Set(seed.columns.map((column) => column.id)).size !== seed.columns.length)
    throw new ApiError('validation_failed', '表格列标识不能重复');
  const doc = await createDocument(ctx, actor, projectId, {
    kind: 'sheet',
    title: title.slice(0, 120),
    space: 'team',
  });
  const row = await getRow(ctx, projectId, doc.id);
  return withDocumentSnapshot(ctx, row, async (ydoc) => {
    ensureWorkbook(ydoc);
    const sheet = listSheets(ydoc)[0]!;
    if (seed) {
      // 用声明的列身份生成稳定 ID，同一输出重跑或列重排时，下游绑定仍指向同一列。
      const stableColumns = seed.columns.map((column) =>
        /^c_[0-9a-f]{24}$/u.test(column.id)
          ? column.id
          : stableResearchColumnId({
              id: column.id,
              name: column.name,
              type: column.type ?? null,
              unit: column.unit ?? null,
            }),
      );
      if (new Set(stableColumns).size !== stableColumns.length)
        throw new ApiError('validation_failed', '列标识发生冲突');
      const allColumns = [
        ...stableColumns,
        ...sheet.cols.filter((id) => !stableColumns.includes(id)),
      ].slice(0, Math.max(26, stableColumns.length));
      const columnArray = ydoc.getArray<string>(sheetTypeName(sheet.id, 'cols'));
      columnArray.delete(0, columnArray.length);
      columnArray.push(allColumns);
      sheet.cols.splice(0, sheet.cols.length, ...allColumns);
      const batch: Array<{ r: number; c: number; value: string }> = [];
      const flush = () => {
        if (batch.length) writeCells(ydoc, sheet, batch.splice(0));
      };
      seed.columns.forEach((column, c) => batch.push({ r: 0, c, value: literal(column.name) }));
      seed.rows.forEach((values, r) => {
        values.forEach((value, c) => {
          if (value !== null && value !== '') batch.push({ r: r + 1, c, value: literal(value) });
          if (batch.length >= 4000) flush();
        });
      });
      // 末尾全为空的行也是实际输入，不能因稀疏存储而丢失。
      if (seed.rows.length)
        batch.push({ r: seed.rows.length, c: 0, value: literal(seed.rows.at(-1)?.[0] ?? '') });
      flush();
      const presentRows = ydoc.getMap<boolean>(`research:table:rows:${sheet.id}`);
      sheet.rows.slice(1, seed.rows.length + 1).forEach((id) => presentRows.set(id, true));
      await persistDocument(ctx, doc.id, ydoc, actor);
    }
    const columns = (seed?.columns ?? []).map((column, i) => ({ ...column, id: sheet.cols[i]! }));
    return {
      documentId: doc.id,
      sheetId: sheet.id,
      columns,
      rowIds: sheet.rows.slice(1, (seed?.rows.length ?? 0) + 1),
    };
  });
}

function cellValue(raw: unknown, column: ResearchTableColumn): ResearchCellValue {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw);
  const value = text.startsWith("'") ? text.slice(1) : text;
  if (column.missingValues?.includes(value)) return null;
  // 公式结果不以猜测值代替；计算步骤会拒绝不能作为数字使用的公式文本。
  if (!text.startsWith("'") && !text.startsWith('=') && column.type === 'number') {
    const number = Number(value);
    if (value.trim() && Number.isFinite(number)) return number;
  }
  if (!text.startsWith("'") && column.type === 'boolean') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return value;
}

/** 与实际工作簿读取一致，供单元格来源记录当时的值。 */
export function researchSeedCellValue(value: ResearchCellValue, column: ResearchTableColumn) {
  return cellValue(literal(value), column);
}

/** 直接导出完整表格，保留稳定行列身份；文本不会被 CSV 软件当成公式。 */
export function researchTableCsv(table: ResearchStructuredTable): string {
  const cell = (value: ResearchCellValue) => {
    let text = value === null ? '' : String(value);
    if (typeof value === 'string' && /^[\s\u007f]*[=+@-]/u.test(value)) text = `'${text}`;
    return `"${text.replace(/"/gu, '""')}"`;
  };
  const header = [
    '行 ID',
    ...table.columns.map(
      (column) => `${column.name} [${column.id}]${column.unit ? ` (${column.unit})` : ''}`,
    ),
  ];
  const rows = table.rows.map((row) => [
    row.id,
    ...table.columns.map((column) => row.cells[column.id] ?? null),
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** 读取一个一致的 Y.Doc 副本；不使用会截断的 Markdown 表示。 */
export async function readResearchTable(
  ctx: AppContext,
  projectId: string,
  item: ResearchItem,
  query: { sheetId?: string; cursor?: string; limit?: number } = {},
): Promise<ResearchStructuredTable> {
  if (item.kind !== 'table' || item.resource?.kind !== 'document')
    throw new ApiError('validation_failed', '研究条目没有关联工作簿');
  await checkResource(ctx, projectId, item.resource);
  const row = await getRow(ctx, projectId, item.resource.id);
  if (row.kind !== 'sheet') throw new ApiError('validation_failed', '关联文档不是工作簿');
  return withDocumentSnapshot(ctx, row, async (live) => {
    const doc = new Y.Doc();
    const frozenState = Y.encodeStateAsUpdate(live);
    Y.applyUpdate(doc, frozenState);
    try {
      ensureWorkbook(doc);
      const sheets = listSheets(doc);
      const wanted =
        query.sheetId ?? (item.payload?.kind === 'table' ? item.payload.sheetId : undefined);
      const sheet = wanted ? sheets.find((entry) => entry.id === wanted) : sheets[0];
      if (!sheet) throw new ApiError('not_found', '工作表不存在');
      const rowIndex = new Map(sheet.rows.map((id, index) => [id, index]));
      const colIndex = new Map(sheet.cols.map((id, index) => [id, index]));
      let lastRow = 0;
      let lastCol = -1;
      doc.getMap<boolean>(`research:table:rows:${sheet.id}`).forEach((_present, id) => {
        const index = rowIndex.get(id);
        if (index !== undefined) lastRow = Math.max(lastRow, index);
      });
      sheet.cells.forEach((value, key) => {
        if (value === '' || value === null || value === undefined) return;
        const colon = key.indexOf(':');
        const r = rowIndex.get(key.slice(0, colon));
        const c = colIndex.get(key.slice(colon + 1));
        if (r !== undefined && c !== undefined) {
          lastRow = Math.max(lastRow, r);
          lastCol = Math.max(lastCol, c);
        }
      });
      const metadata =
        item.payload?.kind === 'table' &&
        (!item.payload.sheetId || item.payload.sheetId === sheet.id)
          ? (item.payload.columns ?? [])
          : [];
      const metaById = new Map(metadata.map((column) => [column.id, column]));
      for (const column of metadata) lastCol = Math.max(lastCol, colIndex.get(column.id) ?? -1);
      const columns = sheet.cols.slice(0, lastCol + 1).map((id, i) => {
        const existing = metaById.get(id);
        const rawName = sheet.cells.get(`${sheet.rows[0]}:${id}`);
        const name =
          typeof rawName === 'string' && rawName.trim()
            ? rawName.startsWith("'")
              ? rawName.slice(1)
              : rawName
            : (existing?.name ?? `列 ${i + 1}`);
        return { ...existing, id, name };
      });
      const rowIds = sheet.rows.slice(1, lastRow + 1);
      // 分页仅构造请求行；版本摘要来自同一份冻结工作簿和列元数据。
      const fingerprint = createHash('sha256')
        .update(frozenState)
        .update(JSON.stringify({ documentId: item.resource!.id, sheetId: sheet.id, columns }))
        .digest('hex');
      let start = 0;
      if (query.cursor) {
        const index = rowIds.indexOf(query.cursor);
        if (index < 0) throw new ApiError('validation_failed', '分页位置已失效，请重新读取表格');
        start = index + 1;
      }
      const limit =
        query.limit === undefined ? rowIds.length : Math.max(1, Math.min(1000, query.limit));
      const page = rowIds.slice(start, start + limit).map((id) => ({
        id,
        cells: Object.fromEntries(
          columns.map((column) => [
            column.id,
            cellValue(sheet.cells.get(`${id}:${column.id}`), column),
          ]),
        ),
      }));
      await checkResource(ctx, projectId, item.resource!);
      return {
        documentId: item.resource!.id,
        sheetId: sheet.id,
        sourceVersion: fingerprint,
        hash: fingerprint,
        columns,
        rows: page,
        totalRows: rowIds.length,
        nextCursor: start + limit < rowIds.length ? page.at(-1)!.id : null,
      };
    } finally {
      doc.destroy();
    }
  });
}
