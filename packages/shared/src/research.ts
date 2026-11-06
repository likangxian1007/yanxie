import { z } from 'zod';
import { ActorRef } from './entities';
import { tr } from './i18n';

/** 科研对象的公开契约。预置模板的 projectId 为 null，项目模板则为项目 ID。 */
const Id = z.string().min(1);
const Iso = z.string();
const Text = z.string().trim().min(1);
const Version = z.number().int().positive();
const Key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);

export const ResearchMethod = z.enum([
  'general',
  'computational',
  'experimental',
  'observational',
  'qualitative',
  'literature',
  'theoretical',
]);
export type ResearchMethod = z.infer<typeof ResearchMethod>;
export const RESEARCH_METHOD_LABEL: Record<ResearchMethod, string> = {
  general: tr('通用研究'),
  computational: tr('计算仿真'),
  experimental: tr('实体实验'),
  observational: tr('调查观测'),
  qualitative: tr('质性研究'),
  literature: tr('文献史料'),
  theoretical: tr('理论推导'),
};

export const ResearchFieldType = z.enum(['text', 'number', 'date', 'select', 'resource']);
export type ResearchFieldType = z.infer<typeof ResearchFieldType>;
export const ResearchField = z.object({
  id: Id,
  label: Text.max(120),
  type: ResearchFieldType,
  required: z.boolean().default(false),
  unit: z.string().max(40).nullable().default(null),
  options: z.array(z.string().min(1).max(120)).max(100).default([]),
  order: z.number().int().min(0),
  active: z.boolean().default(true),
});
export type ResearchField = z.infer<typeof ResearchField>;
export const ResearchStep = z.object({
  id: Id,
  title: Text.max(160),
  description: z.string().max(2000).default(''),
  checklist: z
    .array(z.object({ id: Id, text: Text.max(300) }))
    .max(50)
    .default([]),
  order: z.number().int().min(0),
  active: z.boolean().default(true),
});
export type ResearchStep = z.infer<typeof ResearchStep>;
export const ResearchTemplate = z.object({
  id: Id,
  projectId: Id.nullable(),
  version: Version,
  method: ResearchMethod,
  name: Text.max(120),
  description: z.string().max(2000),
  fields: z.array(ResearchField),
  steps: z.array(ResearchStep),
  published: z.boolean(),
  createdBy: ActorRef,
  createdAt: Iso,
  publishedAt: Iso.nullable(),
});
export type ResearchTemplate = z.infer<typeof ResearchTemplate>;
export const ResearchTemplatePublishInput = z.object({
  id: Id.optional(),
  baseVersion: Version.optional(),
  method: ResearchMethod,
  name: Text.max(120),
  description: z.string().max(2000).default(''),
  fields: z.array(ResearchField).max(100).default([]),
  steps: z.array(ResearchStep).max(100).default([]),
  idempotencyKey: Key.optional(),
});
export type ResearchTemplatePublishInput = z.input<typeof ResearchTemplatePublishInput>;

export const ResearchRecordStatus = z.enum([
  'planned',
  'active',
  'paused',
  'completed',
  'abandoned',
]);
export type ResearchRecordStatus = z.infer<typeof ResearchRecordStatus>;
export const ResearchResourceKind = z.enum([
  'file',
  'document',
  'paper',
  'notebook',
  'experiment',
  'research',
  'link',
]);
export type ResearchResourceKind = z.infer<typeof ResearchResourceKind>;
export const ResearchResourceRef = z.object({ kind: ResearchResourceKind, id: Id });
export type ResearchResourceRef = z.infer<typeof ResearchResourceRef>;
export const ResearchFieldValue = z.union([
  z.string(),
  z.number().finite(),
  z.object({ value: z.number().finite(), unit: z.string().min(1).max(40) }),
  ResearchResourceRef,
  z.null(),
]);
export type ResearchFieldValue = z.infer<typeof ResearchFieldValue>;
export const ResearchStepReport = z.object({
  done: z.boolean(),
  reportedBy: ActorRef,
  origin: z.enum(['member_report', 'agent_work']),
  verification: z.literal('unverified'),
  updatedAt: Iso,
});
export type ResearchStepReport = z.infer<typeof ResearchStepReport>;
export const ResearchRecord = z.object({
  id: Id,
  projectId: Id,
  templateId: Id,
  templateVersion: Version,
  method: ResearchMethod,
  title: Text.max(200),
  question: z.string().max(5000),
  status: ResearchRecordStatus,
  assigneeId: Id.nullable(),
  fieldValues: z.record(z.string(), ResearchFieldValue),
  stepState: z.record(z.string(), z.boolean()),
  /** 勾选表示有人报告该步骤已完成；不等同于独立核验或实体操作由 AI 亲自执行。 */
  stepReports: z.record(z.string(), ResearchStepReport),
  resources: z.array(ResearchResourceRef),
  sourceIds: z.array(Id),
  version: Version,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type ResearchRecord = z.infer<typeof ResearchRecord>;
export const ResearchRecordCreateInput = z.object({
  templateId: Id,
  templateVersion: Version.optional(),
  title: Text.max(200),
  question: z.string().max(5000).default(''),
  status: ResearchRecordStatus.default('planned'),
  assigneeId: Id.nullable().default(null),
  fieldValues: z.record(z.string(), ResearchFieldValue).default({}),
  stepState: z.record(z.string(), z.boolean()).default({}),
  resources: z.array(ResearchResourceRef).max(100).default([]),
  sourceIds: z.array(Id).max(200).default([]),
  idempotencyKey: Key.optional(),
});
export type ResearchRecordCreateInput = z.input<typeof ResearchRecordCreateInput>;
export const ResearchRecordUpdateInput = z.object({
  baseVersion: Version,
  migrateTemplateVersion: Version.optional(),
  title: Text.max(200).optional(),
  question: z.string().max(5000).optional(),
  status: ResearchRecordStatus.optional(),
  assigneeId: Id.nullable().optional(),
  fieldValues: z.record(z.string(), ResearchFieldValue).optional(),
  stepState: z.record(z.string(), z.boolean()).optional(),
  resources: z.array(ResearchResourceRef).max(100).optional(),
  sourceIds: z.array(Id).max(200).optional(),
});
export type ResearchRecordUpdateInput = z.input<typeof ResearchRecordUpdateInput>;
export const ResearchRecordDetail = z.object({
  record: ResearchRecord,
  template: ResearchTemplate,
  logs: z.array(z.lazy(() => ResearchLog)),
  sources: z.array(z.lazy(() => ResearchSource)),
});
export type ResearchRecordDetail = z.infer<typeof ResearchRecordDetail>;
export const ResearchRecordRevision = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  version: Version,
  record: ResearchRecord,
  createdBy: ActorRef,
  createdAt: Iso,
});
export type ResearchRecordRevision = z.infer<typeof ResearchRecordRevision>;
export const ResearchLog = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  version: Version,
  body: Text.max(20_000),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type ResearchLog = z.infer<typeof ResearchLog>;
export const ResearchLogCreateInput = z.object({
  body: Text.max(20_000),
  idempotencyKey: Key.optional(),
});

export const ResearchSourceKind = z.enum([
  'file',
  'document',
  'paper',
  'notebook',
  'bibliography',
  'url',
]);
export type ResearchSourceKind = z.infer<typeof ResearchSourceKind>;
export const ResearchSource = z.object({
  id: Id,
  projectId: Id,
  recordId: Id.nullable(),
  kind: ResearchSourceKind,
  resourceId: Id.nullable(),
  title: Text.max(500),
  citation: z.string().max(4000),
  url: z.string().url().nullable(),
  originalSourceId: Id.nullable(),
  archivedAt: Iso.nullable(),
  version: Version,
  needsReview: z.boolean(),
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type ResearchSource = z.infer<typeof ResearchSource>;
export const ResearchSourceAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['available', 'missing', 'external', 'manual']),
  resourceKind: ResearchSourceKind,
  resourceId: Id.nullable(),
  experimentId: Id.nullable(),
});
export type ResearchSourceAvailability = z.infer<typeof ResearchSourceAvailability>;
export const ResearchSourceCreateInput = z.object({
  recordId: Id.nullable().default(null),
  kind: ResearchSourceKind,
  resourceId: Id.nullable().default(null),
  title: Text.max(500),
  citation: z.string().max(4000).default(''),
  url: z.string().url().nullable().default(null),
  originalSourceId: Id.nullable().default(null),
  idempotencyKey: Key.optional(),
});
export type ResearchSourceCreateInput = z.input<typeof ResearchSourceCreateInput>;
export const ResearchSourceUpdateInput = z.object({
  baseVersion: Version,
  kind: ResearchSourceKind.optional(),
  resourceId: Id.nullable().optional(),
  title: Text.max(500).optional(),
  citation: z.string().max(4000).optional(),
  url: z.string().url().nullable().optional(),
  originalSourceId: Id.nullable().optional(),
  archived: z.boolean().optional(),
});
export type ResearchSourceUpdateInput = z.input<typeof ResearchSourceUpdateInput>;

export const ResearchSnapshotCoverage = z.enum(['complete', 'excerpt', 'external']);
export type ResearchSnapshotCoverage = z.infer<typeof ResearchSnapshotCoverage>;
export const ResearchSnapshot = z.object({
  id: Id,
  projectId: Id,
  sourceId: Id,
  version: Version,
  sourceVersion: Version,
  /** 快照创建时来源完整元数据；后续书目或 URL 更新不能改写旧证据。 */
  sourceMetadata: ResearchSource,
  coverage: ResearchSnapshotCoverage,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  byteLength: z.number().int().min(0),
  mime: z.string(),
  originalName: z.string(),
  text: z.string().nullable(),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type ResearchSnapshot = z.infer<typeof ResearchSnapshot>;
export const ResearchSnapshotCreateInput = z.object({
  coverage: ResearchSnapshotCoverage,
  text: z.string().max(2_000_000).optional(),
  idempotencyKey: Key.optional(),
});
export type ResearchSnapshotCreateInput = z.input<typeof ResearchSnapshotCreateInput>;

export const EvidenceOrigin = z.enum([
  'member_report',
  'observation',
  'tool_result',
  'ai_extraction',
  'manual',
]);
export type EvidenceOrigin = z.infer<typeof EvidenceOrigin>;
export const EvidenceLocator = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pdf'),
    page: z.number().int().positive(),
    quote: z.string().optional(),
  }),
  z.object({
    kind: z.literal('text'),
    paragraph: z.number().int().positive(),
    quote: z.string().optional(),
  }),
  z.object({ kind: z.literal('sheet'), sheet: Text, range: Text }),
  z.object({ kind: z.literal('manual'), note: Text }),
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocator>;
export const EvidenceExcerpt = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  version: Version,
  sourceId: Id,
  snapshotId: Id,
  quote: Text.max(20_000),
  locator: EvidenceLocator,
  origin: EvidenceOrigin,
  verification: z.enum(['verified', 'unverified']),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type EvidenceExcerpt = z.infer<typeof EvidenceExcerpt>;
export const EvidenceExcerptCreateInput = z.object({
  sourceId: Id,
  snapshotId: Id,
  quote: Text.max(20_000),
  locator: EvidenceLocator,
  origin: EvidenceOrigin,
  idempotencyKey: Key.optional(),
});
export type EvidenceExcerptCreateInput = z.input<typeof EvidenceExcerptCreateInput>;

export const ResearchCode = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  name: Text.max(160),
  definition: z.string().max(4000),
  group: z.string().max(160).nullable(),
  version: Version,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type ResearchCode = z.infer<typeof ResearchCode>;
export const ResearchCodeCreateInput = z.object({
  name: Text.max(160),
  definition: z.string().max(4000).default(''),
  group: z.string().max(160).nullable().default(null),
  idempotencyKey: Key.optional(),
});
export type ResearchCodeCreateInput = z.input<typeof ResearchCodeCreateInput>;
export const ResearchCodeUpdateInput = z.object({
  baseVersion: Version,
  name: Text.max(160).optional(),
  definition: z.string().max(4000).optional(),
  group: z.string().max(160).nullable().optional(),
});
export type ResearchCodeUpdateInput = z.input<typeof ResearchCodeUpdateInput>;
export const ResearchCoding = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  version: Version,
  excerptId: Id,
  codeId: Id,
  caseId: z.string().max(160).nullable(),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type ResearchCoding = z.infer<typeof ResearchCoding>;
export const ResearchCodingCreateInput = z.object({
  excerptId: Id,
  codeId: Id,
  caseId: z.string().max(160).nullable().default(null),
  idempotencyKey: Key.optional(),
});
export type ResearchCodingCreateInput = z.input<typeof ResearchCodingCreateInput>;

export const ResearchFinding = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  statement: Text.max(20_000),
  supportingExcerptIds: z.array(Id),
  counterExcerptIds: z.array(Id),
  contextExcerptIds: z.array(Id),
  limitations: z.string().max(10_000),
  humanConfirmed: z.boolean(),
  needsReview: z.boolean(),
  version: Version,
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;
export const ResearchFindingCreateInput = z.object({
  statement: Text.max(20_000),
  supportingExcerptIds: z.array(Id).max(100).default([]),
  counterExcerptIds: z.array(Id).max(100).default([]),
  contextExcerptIds: z.array(Id).max(100).default([]),
  limitations: z.string().max(10_000).default(''),
  humanConfirmed: z.boolean().default(false),
  idempotencyKey: Key.optional(),
});
export type ResearchFindingCreateInput = z.input<typeof ResearchFindingCreateInput>;
export const ResearchFindingUpdateInput = z.object({
  baseVersion: Version,
  statement: Text.max(20_000).optional(),
  supportingExcerptIds: z.array(Id).max(100).optional(),
  counterExcerptIds: z.array(Id).max(100).optional(),
  contextExcerptIds: z.array(Id).max(100).optional(),
  limitations: z.string().max(10_000).optional(),
  humanConfirmed: z.boolean().optional(),
  resolveReview: z.boolean().optional(),
});
export type ResearchFindingUpdateInput = z.input<typeof ResearchFindingUpdateInput>;

export const ResearchListItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('research'),
    id: Id,
    projectId: Id,
    title: z.string(),
    status: ResearchRecordStatus,
    method: ResearchMethod,
    updatedAt: Iso,
    href: z.string(),
  }),
  z.object({
    kind: z.literal('experiment'),
    id: Id,
    projectId: Id,
    title: z.string(),
    status: z.string(),
    method: z.null(),
    updatedAt: Iso,
    href: z.string(),
  }),
]);
export type ResearchListItem = z.infer<typeof ResearchListItem>;
export const ResearchSearchHit = z.object({
  kind: z.enum(['record', 'source', 'finding']),
  id: Id,
  projectId: Id,
  recordId: Id.nullable(),
  title: z.string(),
  snippet: z.string(),
  href: z.string(),
});
export type ResearchSearchHit = z.infer<typeof ResearchSearchHit>;
