import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { ActorRef } from '@srh/shared';
import { actor, createdAt, id, ts, updatedAt } from './_helpers';
import { projects } from './core';
import { bytea } from './collab';

/**
 * Notebook（Jupyter 式）。归属：后端线程（modules/notebooks）。
 * 内容是 Y.Doc（ydoc_state），由 /collab 持久化；cell_count、language 是冗余摘要，给列表用。
 */
export const notebooks = pgTable(
  'notebooks',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('未命名 Notebook'),
    language: text('language').notNull().default('python'),
    cellCount: integer('cell_count').notNull().default(0),
    ydocState: bytea('ydoc_state'),
    createdBy: actor('created_by'),
    updatedBy: jsonb('updated_by').$type<ActorRef>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('notebooks_project_idx').on(t.projectId)],
);
