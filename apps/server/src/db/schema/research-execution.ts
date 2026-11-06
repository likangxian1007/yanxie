import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ResearchRecipe, ResearchRun } from '@srh/shared';
import { createdAt, id, updatedAt } from './_helpers';
import { projects } from './core';

/** 已发布的方案版本不可变，每个版本独立存储。 */
export const researchRecipeVersions = pgTable(
  'research_recipe_versions',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    data: jsonb('data').$type<ResearchRecipe>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('research_recipe_record_idx').on(t.projectId, t.recordId),
  ],
);

/** 用 revision 作 CAS，避免确认、取消与后台执行互相覆盖。 */
export const researchRuns = pgTable(
  'research_runs',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    revision: integer('revision').notNull().default(1),
    data: jsonb('data').$type<ResearchRun>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('research_runs_record_idx').on(t.projectId, t.recordId)],
);

/** 同一操作者的同一启动键必须返回同一 run；请求内容不同则冲突。 */
export const researchRunKeys = pgTable(
  'research_run_keys',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    actorId: text('actor_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('research_run_key_scope_idx').on(t.projectId, t.recordId, t.actorId, t.key)],
);
