import { z } from 'zod';
import { ActorRef } from './entities';
import {
  ResearchActionOutput,
  ResearchArtifactRef,
  ResearchChartSpec,
  ResearchTableTransform,
} from './research-content';

/** 仅组织已有研究操作；未设置 processing 的行动保持旧执行语义。 */
export const ResearchProcessingConfig = z.object({
  mode: z.enum(['auto', 'fixed']),
  expectedOutputs: z
    .array(z.enum(['note', 'table', 'figure']))
    .max(3)
    .default([]),
  locks: z
    .object({
      transform: ResearchTableTransform.optional(),
      chart: ResearchChartSpec.optional(),
    })
    .optional(),
});
export type ResearchProcessingConfig = z.infer<typeof ResearchProcessingConfig>;

export const ResearchProcessingOperation = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  operation: z.enum(['organize', 'extract_table', 'transform_table', 'chart']),
  /** input:1、input:2…对应冻结输入；其他值为本方案内前序操作的 id。 */
  inputKeys: z.array(z.string().min(1)).min(1).max(100),
  instructions: z.string().max(20000).default(''),
  transform: ResearchTableTransform.optional(),
  chart: ResearchChartSpec.optional(),
});
export type ResearchProcessingOperation = z.infer<typeof ResearchProcessingOperation>;
export const ResearchProcessingPlan = z.object({
  summary: z.string().trim().min(1).max(5000),
  steps: z.array(ResearchProcessingOperation).min(1).max(100),
  outputs: z
    .array(ResearchActionOutput.extend({ stepId: z.string().min(1) }))
    .min(1)
    .max(20),
});
export type ResearchProcessingPlan = z.infer<typeof ResearchProcessingPlan>;
export const ResearchProcessingQuestion = z.object({
  questionId: z.string().min(1),
  question: z.string().trim().min(1).max(20000),
  reason: z.enum(['missing_input', 'ambiguous', 'unsupported']),
  choices: z.array(z.string().min(1).max(2000)).max(20).optional(),
});
export type ResearchProcessingQuestion = z.infer<typeof ResearchProcessingQuestion>;
export const ResearchProcessingExecution = z.object({
  version: z.number().int().positive(),
  phase: z.enum(['planning', 'executing', 'waiting', 'succeeded', 'failed']),
  fingerprint: z.string(),
  reused: z.boolean(),
  plan: ResearchProcessingPlan.nullable(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(['queued', 'running', 'succeeded', 'failed']),
      error: z.string().optional(),
    }),
  ),
  question: ResearchProcessingQuestion.optional(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      question: z.string(),
      answer: z.string(),
      actor: ActorRef,
      answeredAt: z.string(),
      idempotencyKey: z.string(),
    }),
  ),
  intermediates: z.array(ResearchArtifactRef).default([]),
});
export type ResearchProcessingExecution = z.infer<typeof ResearchProcessingExecution>;
export const ResearchRunAnswerInput = z.object({
  questionId: z.string().min(1),
  answer: z.string().trim().min(1).max(20000),
  baseVersion: z.number().int().positive(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
});
export type ResearchRunAnswerInput = z.input<typeof ResearchRunAnswerInput>;
