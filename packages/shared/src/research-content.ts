import { z } from 'zod';
import { ActorRef } from './entities';
import { ResearchResourceRef } from './research';
import { tr } from './i18n';

const Id = z.string().min(1);
const Name = z.string().trim().min(1).max(200);
export const ResearchCellValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type ResearchCellValue = z.infer<typeof ResearchCellValue>;
export const ResearchDraftBlock = z.discriminatedUnion('kind', [
  z.object({ id: Id, kind: z.literal('text'), text: z.string().max(200000) }),
  z.object({
    id: Id,
    kind: z.literal('resource'),
    resource: ResearchResourceRef,
    title: z.string().max(200).optional(),
  }),
  z.object({ id: Id, kind: z.literal('excerpt'), excerptId: Id }),
]);
export type ResearchDraftBlock = z.infer<typeof ResearchDraftBlock>;
export const ResearchTableColumn = z.object({
  id: Id,
  name: Name,
  type: z.enum(['text', 'number', 'boolean', 'date']).optional(),
  unit: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  missingValues: z.array(z.string()).optional(),
});
export type ResearchTableColumn = z.infer<typeof ResearchTableColumn>;
export const ResearchCellSource = z.object({
  rowId: Id,
  columnId: Id,
  itemId: Id.optional(),
  blockId: Id.optional(),
  excerptId: Id.optional(),
  quote: z.string().max(20000).optional(),
  locator: z.unknown().optional(),
  verification: z.enum(['matched', 'unverified']).default('unverified'),
});
export type ResearchCellSource = z.infer<typeof ResearchCellSource>;
export const ResearchTableSeed = z.object({
  columns: z.array(ResearchTableColumn).min(1).max(1000),
  rows: z.array(z.array(ResearchCellValue)).max(100000),
  lineage: z.array(ResearchCellSource).optional(),
});
export type ResearchTableSeed = z.infer<typeof ResearchTableSeed>;
export const ResearchTableTransform = z.object({
  select: z.array(Id).optional(),
  filters: z
    .array(
      z.object({
        columnId: Id,
        operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'missing', 'present']),
        value: ResearchCellValue.optional(),
      }),
    )
    .optional(),
  sort: z.array(z.object({ columnId: Id, direction: z.enum(['asc', 'desc']) })).optional(),
  deduplicateBy: z.array(Id).optional(),
  groupBy: z.array(Id).optional(),
  aggregates: z
    .array(z.object({ columnId: Id.optional(), op: z.enum(['count', 'sum', 'mean']), as: Name }))
    .optional(),
});
export type ResearchTableTransform = z.infer<typeof ResearchTableTransform>;
export const ResearchChartSpec = z.object({
  kind: z.enum(['bar', 'line', 'scatter']),
  xColumn: Id,
  yColumns: z.array(Id).min(1).max(20),
  title: z.string().max(200).optional(),
  xLabel: z.string().max(200).optional(),
  yLabel: z.string().max(200).optional(),
  missing: z.enum(['omit', 'error']).default('omit'),
});
export type ResearchChartSpec = z.infer<typeof ResearchChartSpec>;
export const ResearchItemPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft'), blocks: z.array(ResearchDraftBlock).max(500) }),
  z.object({
    kind: z.literal('table'),
    sheetId: Id.optional(),
    columns: z.array(ResearchTableColumn).optional(),
    lineage: z.array(ResearchCellSource).optional(),
  }),
  z.object({
    kind: z.literal('figure'),
    svgFileId: Id.optional(),
    pngFileId: Id.optional(),
    caption: z.string().max(5000).optional(),
    chart: ResearchChartSpec.optional(),
    dataArtifactId: Id.optional(),
  }),
]);
export type ResearchItemPayload = z.infer<typeof ResearchItemPayload>;
export const ResearchActionInput = z.object({
  name: Name,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('item'), itemId: Id, blockIds: z.array(Id).optional() }),
    z.object({
      kind: z.literal('output'),
      stepId: Id,
      outputKey: Name,
      artifactVersionId: Id.optional(),
    }),
  ]),
});
export type ResearchActionInput = z.infer<typeof ResearchActionInput>;
export const ResearchActionOutput = z.object({
  key: Name,
  kind: z.enum(['note', 'table', 'figure']),
  title: z.string().max(200).optional(),
});
export type ResearchActionOutput = z.infer<typeof ResearchActionOutput>;
export const ResearchOperation = z.enum([
  'free',
  'organize',
  'extract_table',
  'transform_table',
  'chart',
]);
export type ResearchOperation = z.infer<typeof ResearchOperation>;
export const ResearchArtifactRef = z.object({
  id: Id,
  itemId: Id,
  version: z.number().int().positive(),
  kind: z.enum(['note', 'table', 'figure', 'resource', 'draft']),
  mime: z.string(),
  hash: z.string(),
  size: z.number().int().nonnegative(),
  downloadUrl: z.string().optional(),
  outputKey: z.string().optional(),
});
export type ResearchArtifactRef = z.infer<typeof ResearchArtifactRef>;
export const ResearchArtifactVersion = ResearchArtifactRef.extend({
  projectId: Id,
  recordId: Id,
  runId: Id.nullable(),
  stepId: Id.nullable(),
  summary: z.string(),
  createdBy: ActorRef,
  createdAt: z.string(),
  origin: z.enum(['ai_draft', 'computation', 'member_report']),
  inputs: z.array(Id),
  metadata: z.unknown().optional(),
});
export type ResearchArtifactVersion = z.infer<typeof ResearchArtifactVersion>;
export const ResearchStructuredTable = z.object({
  documentId: Id,
  sheetId: Id,
  sourceVersion: z.string(),
  hash: z.string(),
  columns: z.array(ResearchTableColumn),
  rows: z.array(z.object({ id: Id, cells: z.record(Id, ResearchCellValue) })),
  totalRows: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type ResearchStructuredTable = z.infer<typeof ResearchStructuredTable>;
export const ResearchLayoutUpdateInput = z.object({
  moves: z
    .array(
      z.object({
        itemId: Id,
        basePositionVersion: z.number().int().positive(),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
      }),
    )
    .min(1)
    .max(1000)
    .refine(
      (moves) => new Set(moves.map((m) => m.itemId)).size === moves.length,
      tr('条目不能重复'),
    ),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
});
export type ResearchLayoutUpdateInput = z.input<typeof ResearchLayoutUpdateInput>;
