import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '@srh/shared';
import { z } from 'zod';
import * as Y from 'yjs';
import { parse } from '../../lib/http';
import { liveDocument, withLiveDocument } from '../../realtime/collab';
import { requireProject, type Params } from '../collab-common';
import { kernelManager } from '../notebooks';
import { cellsOf, findCell, makeCell, newCellId, readNotebook } from '../notebooks/nbformat';
import { findNotebookRow } from '../notebooks/service';

type PN = Params<'projectId' | 'notebookId'>;

export const NotebookContentQuery = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100_000).default(20_000),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});

const CellOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    type: z.enum(['code', 'markdown', 'raw']),
    source: z.string().max(200_000),
    afterCellId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal('replace'),
    cellId: z.string().min(1),
    source: z.string().max(200_000),
  }),
  z.object({ op: z.literal('delete'), cellId: z.string().min(1) }),
]);
export const NotebookCellEditInput = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  operations: z.array(CellOperation).min(1).max(100),
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const content = (doc: Y.Doc) => JSON.stringify(readNotebook(doc));

/** Return a coherent JSON snapshot in resumable UTF-16 chunks; continuation checks its hash. */
function chunk(value: unknown, query: z.infer<typeof NotebookContentQuery>) {
  const json = JSON.stringify(value);
  const contentHash = hash(json);
  if (query.offset > 0 && !query.contentHash) {
    throw new ApiError('validation_failed', '续读时必须提供首次读取的 contentHash');
  }
  if (query.contentHash && query.contentHash !== contentHash) {
    throw new ApiError('conflict', 'Notebook 内容已变化，请重新读取', { contentHash });
  }
  if (query.offset > json.length) throw new ApiError('validation_failed', '读取位置超出内容长度');
  const end = Math.min(json.length, query.offset + query.limit);
  return {
    contentHash,
    offset: query.offset,
    endOffset: end,
    totalLength: json.length,
    nextOffset: end < json.length ? end : null,
    json: json.slice(query.offset, end),
  };
}

async function snapshot(app: FastifyInstance, projectId: string, notebookId: string) {
  const row = await findNotebookRow(app.ctx, projectId, notebookId);
  const live = liveDocument(app.ctx, notebookId);
  if (live) return live;
  const doc = new Y.Doc();
  if (row.ydocState) Y.applyUpdate(doc, row.ydocState);
  return doc;
}

export function registerNotebookIntegrationRoutes(app: FastifyInstance) {
  app.get<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/contents', async (req) => {
    const { projectId, notebookId } = req.params;
    await requireProject(req, projectId, 'view');
    const query = parse(NotebookContentQuery, req.query);
    const doc = await snapshot(app, projectId, notebookId);
    try {
      return chunk(readNotebook(doc), query);
    } finally {
      if (liveDocument(app.ctx, notebookId) !== doc) doc.destroy();
    }
  });

  app.get<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/execution', async (req) => {
    const { projectId, notebookId } = req.params;
    await requireProject(req, projectId, 'view');
    const query = parse(NotebookContentQuery, req.query);
    const doc = await snapshot(app, projectId, notebookId);
    try {
      const cells = readNotebook(doc).cells.map(({ id, type, executionCount, outputs }) => ({
        id,
        type,
        executionCount,
        outputs,
      }));
      return chunk(
        {
          kernel: {
            ...doc.getMap('kernel').toJSON(),
            status: kernelManager(app.ctx).kernelStatus(notebookId),
          },
          runs: doc.getMap('runs').toJSON(),
          cells,
        },
        query,
      );
    } finally {
      if (liveDocument(app.ctx, notebookId) !== doc) doc.destroy();
    }
  });

  app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/cells', async (req) => {
    const { projectId, notebookId } = req.params;
    const access = await requireProject(req, projectId, 'write');
    const input = parse(NotebookCellEditInput, req.body ?? {});
    await findNotebookRow(app.ctx, projectId, notebookId);
    return withLiveDocument(app.ctx, notebookId, access.actor, (doc) => {
      const currentHash = hash(content(doc));
      if (currentHash !== input.contentHash)
        throw new ApiError('conflict', 'Notebook 内容已变化，请重新读取', {
          contentHash: currentHash,
        });
      // Validate the complete sequence before changing Yjs: transactions do not roll back exceptions.
      const ids = readNotebook(doc).cells.map((cell) => cell.id);
      const insertIds = new Map<number, string>();
      input.operations.forEach((op, i) => {
        if (op.op === 'insert') {
          const index =
            op.afterCellId === 'start'
              ? 0
              : op.afterCellId
                ? ids.indexOf(op.afterCellId) + 1
                : ids.length;
          if (op.afterCellId && op.afterCellId !== 'start' && index === 0)
            throw new ApiError('not_found', '单元格不存在');
          const id = newCellId();
          insertIds.set(i, id);
          ids.splice(index, 0, id);
        } else {
          const index = ids.indexOf(op.cellId);
          if (index < 0) throw new ApiError('not_found', '单元格不存在');
          if (op.op === 'delete') ids.splice(index, 1);
        }
      });
      const cells = cellsOf(doc);
      const results = input.operations.map((op, i) => {
        if (op.op === 'insert') {
          const index =
            op.afterCellId === 'start'
              ? 0
              : op.afterCellId
                ? findCell(doc, op.afterCellId)!.index + 1
                : cells.length;
          const id = insertIds.get(i)!;
          cells.insert(index, [makeCell({ id, type: op.type, source: op.source })]);
          return { op: op.op, cellId: id };
        }
        const found = findCell(doc, op.cellId)!;
        if (op.op === 'delete') cells.delete(found.index, 1);
        else {
          const source = found.cell.get('source');
          if (source instanceof Y.Text) {
            source.delete(0, source.length);
            source.insert(0, op.source);
          } else found.cell.set('source', new Y.Text(op.source));
        }
        return { op: op.op, cellId: op.cellId };
      });
      if (cells.length === 0) cells.insert(0, [makeCell({ type: 'code' })]);
      return { results, contentHash: hash(content(doc)) };
    });
  });
}
