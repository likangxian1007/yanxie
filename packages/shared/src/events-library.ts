import { z } from 'zod';
import { Paper } from './entities-library';

/**
 * 文献库事件（events.ts 自动合并）。解析进度按阶段推送 paper.updated（每篇约 5 条），
 * 不按百分比逐条落库。
 */
export const LIBRARY_EVENT_PAYLOADS = {
  'paper.qa.changed': z.object({
    paperId: z.string(),
    sessionId: z.string(),
    turnId: z.string().nullable(),
    deleted: z.boolean(),
  }),
  'paper.created': Paper,
  'paper.updated': Paper,
  'paper.deleted': z.object({ id: z.string() }),
  'paper.notes.changed': z.object({
    paperId: z.string(),
    noteId: z.string(),
    deleted: z.boolean(),
  }),
  'paper.annotations.changed': z.object({
    paperId: z.string(),
    annotationId: z.string(),
    deleted: z.boolean(),
  }),
} as const;
