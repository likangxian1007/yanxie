import { z } from 'zod';
import { ResearchProcessingExecution, ResearchProcessingQuestion } from './research-processing';
import { ActorRef } from './entities';
import { ResearchArtifactRef } from './research-content';
import { ResearchAction, ResearchItem } from './research-workspace';

const Id = z.string().min(1);
const Key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u);
const Version = z.number().int().positive();

/** 执行边单独声明；普通研究关系从不隐式触发运行。 */
export const ResearchExecutionStepInput = z.object({
  itemId: Id,
  dependsOn: z.array(Id).max(100).default([]),
  expectedItemVersion: Version.optional(),
});
export type ResearchExecutionStepInput = z.infer<typeof ResearchExecutionStepInput>;

export const ResearchExecutionSettings = z.object({
  replan: z.boolean().optional(),
  model: z.string().max(200).nullable().default(null),
  effort: z.string().max(100).nullable().default(null),
  profile: z.string().max(200).nullable().default(null),
});
export const ResearchRunCreateInput = ResearchExecutionSettings.extend({
  steps: z.array(ResearchExecutionStepInput).min(1).max(100),
  idempotencyKey: Key,
});
export type ResearchRunCreateInput = z.input<typeof ResearchRunCreateInput>;

export const ResearchFrozenNotebook = z.object({
  notebookId: Id,
  cells: z.array(z.object({ id: Id, source: z.string() })).min(1),
  hash: z.string(),
});
export const ResearchExecutionDefinition = z.object({
  itemId: Id,
  itemVersion: Version,
  title: z.string(),
  action: ResearchAction,
  dependsOn: z.array(Id),
  notebook: ResearchFrozenNotebook.nullable(),
});
export type ResearchExecutionDefinition = z.infer<typeof ResearchExecutionDefinition>;

export const ResearchRecipePublishInput = z.object({
  recipeId: Id.optional(),
  title: z.string().trim().min(1).max(200),
  steps: z.array(ResearchExecutionStepInput).min(1).max(100),
});
export type ResearchRecipePublishInput = z.input<typeof ResearchRecipePublishInput>;
export const ResearchRecipe = z.object({
  id: Id,
  projectId: Id,
  recordId: Id,
  title: z.string(),
  version: Version,
  definitions: z.array(ResearchExecutionDefinition),
  createdBy: ActorRef,
  createdAt: z.string(),
});
export type ResearchRecipe = z.infer<typeof ResearchRecipe>;
export const ResearchRecipeInstantiateInput = ResearchExecutionSettings.extend({
  version: Version,
  bindings: z.record(Id, Id).default({}),
  idempotencyKey: Key,
});
export type ResearchRecipeInstantiateInput = z.input<typeof ResearchRecipeInstantiateInput>;

export const ResearchRunStatus = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type ResearchRunStatus = z.infer<typeof ResearchRunStatus>;
export const ResearchRunInputSnapshot = z.object({
  item: ResearchItem,
  content: z.string(),
  artifact: ResearchArtifactRef.optional(),
  contentVersion: z.union([z.string(), z.number()]).nullable(),
  hash: z.string(),
});
export type ResearchRunInputSnapshot = z.infer<typeof ResearchRunInputSnapshot>;
export const ResearchRunOutput = z.object({
  itemId: Id,
  version: Version,
  hash: z.string(),
  title: z.string(),
  artifact: ResearchArtifactRef.optional(),
  outputKey: z.string().optional(),
  origin: z.enum(['ai_draft', 'computation', 'member_report']),
  content: z.string(),
});
export type ResearchRunOutput = z.infer<typeof ResearchRunOutput>;
export const ResearchRunAttempt = z.object({
  processing: ResearchProcessingExecution.optional(),
  number: Version,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  logs: z.array(z.string()),
  notebookId: Id.nullable(),
  error: z.string().nullable(),
  outputs: z.array(ResearchRunOutput),
});
export type ResearchRunAttempt = z.infer<typeof ResearchRunAttempt>;
export const ResearchRunStep = z.object({
  waitingFor: ResearchProcessingQuestion.extend({ kind: z.literal('clarification') }).optional(),
  definition: ResearchExecutionDefinition,
  status: ResearchRunStatus,
  attempts: z.array(ResearchRunAttempt),
  selection: z
    .object({
      model: z.string(),
      effort: z.string(),
      profile: z.string().nullable(),
      profilePrompt: z.string().nullable(),
    })
    .nullable(),
  confirmedBy: ActorRef.nullable(),
  confirmedAt: z.string().nullable(),
});
export type ResearchRunStep = z.infer<typeof ResearchRunStep>;
export const ResearchRun = z.object({
  id: Id,
  /** 网页中的运行位置；等待人工检查时聚焦首个待确认步骤。 */
  webUrl: z.string().optional(),
  projectId: Id,
  recordId: Id,
  recipeId: Id.nullable(),
  recipeVersion: Version.nullable(),
  status: ResearchRunStatus,
  cancelRequested: z.boolean(),
  inputSnapshots: z.array(ResearchRunInputSnapshot),
  steps: z.array(ResearchRunStep),
  settings: ResearchExecutionSettings,
  createdBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResearchRun = z.infer<typeof ResearchRun>;
export const ResearchRunConfirmInput = z.object({
  note: z.string().trim().min(1).max(200000),
  itemIds: z.array(Id).max(100).optional(),
});
export type ResearchRunConfirmInput = z.input<typeof ResearchRunConfirmInput>;

/** 复核当前材料；不会改变原运行及其不可变输入。 */
export const ResearchRunStaleness = z.object({
  stale: z.boolean(),
  inputs: z.array(
    z.object({
      itemId: Id,
      state: z.enum(['current', 'changed', 'unavailable']),
      reason: z.string().nullable(),
    }),
  ),
});
export type ResearchRunStaleness = z.infer<typeof ResearchRunStaleness>;
