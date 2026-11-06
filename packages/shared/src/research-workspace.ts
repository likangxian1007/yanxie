import { z } from 'zod';
import { ResearchProcessingConfig } from './research-processing';
import { ActorRef } from './entities';
import {
  ResearchItemPayload,
  ResearchActionInput,
  ResearchActionOutput,
  ResearchOperation,
  ResearchTableTransform,
  ResearchChartSpec,
  ResearchTableSeed,
} from './research-content';
import { ResearchRecord, ResearchResourceRef, ResearchSearchHit } from './research';
import { tr } from './i18n';

const Id = z.string().min(1);
const Version = z.number().int().positive();
const Key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);
const Title = z.string().trim().min(1).max(200);

export const ResearchWorkspaceCreateInput = z.object({
  title: Title.default(tr('未命名研究')),
  question: z.string().max(5000).default(''),
  idempotencyKey: Key.optional(),
});
export type ResearchWorkspaceCreateInput = z.input<typeof ResearchWorkspaceCreateInput>;

export const ResearchItemKind = z.enum([
  'note',
  'resource',
  'action',
  'group',
  'draft',
  'table',
  'figure',
]);
export type ResearchItemKind = z.infer<typeof ResearchItemKind>;
export const ResearchPosition = z.object({ x: z.number().finite(), y: z.number().finite() });
export type ResearchPosition = z.infer<typeof ResearchPosition>;
export const ResearchEvidenceRef = z.object({
  kind: z.enum(['source', 'excerpt', 'finding']),
  id: Id,
});
export type ResearchEvidenceRef = z.infer<typeof ResearchEvidenceRef>;
export const ResearchItemOriginInput = z.object({
  itemId: Id,
  sourceVersion: z.union([z.number(), z.string()]).nullable(),
  quote: z.string().min(1).max(20000),
  locator: z.object({
    kind: z.literal('text'),
    start: z.number().int().min(0),
    end: z.number().int().positive(),
    segment: z.number().int().min(0),
  }),
});
export const ResearchItemOrigin = ResearchItemOriginInput.extend({
  resource: ResearchResourceRef.nullable(),
  evidenceRef: ResearchEvidenceRef.nullable(),
  verification: z.literal('unverified'),
});
export type ResearchItemOrigin = z.infer<typeof ResearchItemOrigin>;
export const ResearchAction = z.object({
  processing: ResearchProcessingConfig.optional(),
  kind: z.enum(['ai', 'notebook', 'human']),
  operation: ResearchOperation.optional(),
  inputs: z.array(ResearchActionInput).max(100).optional(),
  outputs: z.array(ResearchActionOutput).max(20).optional(),
  transform: ResearchTableTransform.optional(),
  chart: ResearchChartSpec.optional(),
  instructions: z.string().max(20000).default(''),
  inputItemIds: z.array(Id).max(100).default([]),
  notebookId: Id.nullable().default(null),
  cellIds: z.array(Id).max(100).default([]),
  model: z.string().max(200).nullable().default(null),
  effort: z.string().max(100).nullable().default(null),
  profile: z.string().max(200).nullable().default(null),
});
export type ResearchAction = z.infer<typeof ResearchAction>;

export const ResearchItem = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  kind: ResearchItemKind,
  title: Title,
  body: z.string().max(200000),
  payload: ResearchItemPayload.nullable().optional(),
  resource: ResearchResourceRef.nullable(),
  evidenceRef: ResearchEvidenceRef.nullable(),
  action: ResearchAction.nullable(),
  origin: ResearchItemOrigin.nullable(),
  parentId: Id.nullable(),
  position: ResearchPosition,
  version: Version,
  positionVersion: Version,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type ResearchItem = z.infer<typeof ResearchItem>;
/** 画布列表不加载正文或 action 指令；打开条目时按需获取。 */
export const ResearchItemSummary = ResearchItem.omit({
  body: true,
  action: true,
  origin: true,
  payload: true,
}).extend({
  originItemId: Id.nullable(),
  actionKind: ResearchAction.shape.kind.nullable(),
  actionInputs: z.array(ResearchActionInput).optional(),
  actionOutputs: z.array(ResearchActionOutput).optional(),
  preview: z.string(),
  producerStepId: z.string().nullable().optional(),
  producerOutputKey: z.string().nullable().optional(),
  previewImageFileId: Id.nullable().optional(),
  runStatus: z.string().nullable().optional(),
});
export type ResearchItemSummary = z.infer<typeof ResearchItemSummary>;

export const ResearchItemCreateInput = z.object({
  kind: ResearchItemKind,
  title: Title,
  body: z.string().max(200000).default(''),
  payload: ResearchItemPayload.nullable().optional(),
  table: ResearchTableSeed.optional(),
  resource: ResearchResourceRef.nullable().default(null),
  evidenceRef: ResearchEvidenceRef.nullable().default(null),
  action: ResearchAction.nullable().default(null),
  origin: ResearchItemOriginInput.nullable().default(null),
  parentId: Id.nullable().default(null),
  position: ResearchPosition.default({ x: 0, y: 0 }),
  idempotencyKey: Key.optional(),
});
export type ResearchItemCreateInput = z.input<typeof ResearchItemCreateInput>;
export const ResearchItemUpdateInput = z.object({
  baseVersion: Version,
  title: Title.optional(),
  body: z.string().max(200000).optional(),
  payload: ResearchItemPayload.nullable().optional(),
  resource: ResearchResourceRef.nullable().optional(),
  evidenceRef: ResearchEvidenceRef.nullable().optional(),
  action: ResearchAction.nullable().optional(),
  parentId: Id.nullable().optional(),
});
export type ResearchItemUpdateInput = z.input<typeof ResearchItemUpdateInput>;
export const ResearchItemPositionInput = z.object({
  basePositionVersion: Version,
  position: ResearchPosition,
});
export type ResearchItemPositionInput = z.input<typeof ResearchItemPositionInput>;
export const ResearchArchiveInput = z.object({ baseVersion: Version });
export type ResearchArchiveInput = z.input<typeof ResearchArchiveInput>;

export const ResearchRelation = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  fromItemId: Id,
  toItemId: Id,
  label: z.string().trim().max(200),
  version: Version,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type ResearchRelation = z.infer<typeof ResearchRelation>;
export const ResearchRelationCreateInput = z.object({
  fromItemId: Id,
  toItemId: Id,
  label: z.string().trim().max(200).default(''),
  idempotencyKey: Key.optional(),
});
export type ResearchRelationCreateInput = z.input<typeof ResearchRelationCreateInput>;
export const ResearchRelationUpdateInput = z.object({
  baseVersion: Version,
  label: z.string().trim().max(200),
});
export type ResearchRelationUpdateInput = z.input<typeof ResearchRelationUpdateInput>;

const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export const ResearchWorkspace = z.object({
  record: ResearchRecord,
  items: page(ResearchItemSummary),
  relations: page(ResearchRelation),
});
export type ResearchWorkspace = z.infer<typeof ResearchWorkspace>;
/** 原件内容可能不可直接预览；href 指向既有对象，version 为读取时版本。 */
export const ResearchItemContent = z.object({
  title: z.string(),
  resource: ResearchResourceRef.nullable(),
  evidenceRef: ResearchEvidenceRef.nullable(),
  text: z.string().nullable(),
  summary: z.string().nullable(),
  locator: z.unknown().nullable(),
  nextOffset: z.number().int().nullable(),
  mime: z.string().nullable(),
  version: z.union([z.number(), z.string()]).nullable(),
  href: z.string().nullable(),
  unavailableReason: z.string().nullable(),
});
export type ResearchItemContent = z.infer<typeof ResearchItemContent>;

export const ResearchWorkspaceSearchHit = z.object({
  kind: z.literal('item'),
  id: Id,
  projectId: Id,
  recordId: Id,
  title: z.string(),
  snippet: z.string(),
  href: z.string(),
});
export type ResearchWorkspaceSearchHit = z.infer<typeof ResearchWorkspaceSearchHit>;
export const ResearchUnifiedSearchHit = z.union([ResearchSearchHit, ResearchWorkspaceSearchHit]);
export type ResearchUnifiedSearchHit = z.infer<typeof ResearchUnifiedSearchHit>;
