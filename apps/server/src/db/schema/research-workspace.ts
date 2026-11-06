import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type {
  ResearchAction,
  ResearchEvidenceRef,
  ResearchItemKind,
  ResearchItemOrigin,
  ResearchItemPayload,
  ResearchPosition,
  ResearchResourceRef,
} from '@srh/shared';
import { actor, createdAt, id, ts, updatedAt } from './_helpers';
import { projects } from './core';
import { researchEntities } from './research';

/** 每个条目独立版本；布局版本独立于内容，避免拖动和正文编辑互相覆盖。 */
export const researchWorkspaceItems = pgTable(
  'research_workspace_items',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => researchEntities.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ResearchItemKind>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    payload: jsonb('payload').$type<ResearchItemPayload | null>(),
    preview: text('preview').notNull().default(''),
    resource: jsonb('resource').$type<ResearchResourceRef | null>(),
    evidenceRef: jsonb('evidence_ref').$type<ResearchEvidenceRef | null>(),
    action: jsonb('action').$type<ResearchAction | null>(),
    origin: jsonb('origin').$type<ResearchItemOrigin | null>(),
    parentId: text('parent_id'),
    position: jsonb('position').$type<ResearchPosition>().notNull(),
    version: integer('version').notNull().default(1),
    positionVersion: integer('position_version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [index('research_workspace_items_list_idx').on(t.projectId, t.recordId, t.id)],
);

/** 普通语义关系；执行依赖由运行配置单独保存。 */
export const researchWorkspaceRelations = pgTable(
  'research_workspace_relations',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => researchEntities.id, { onDelete: 'cascade' }),
    fromItemId: text('from_item_id')
      .notNull()
      .references(() => researchWorkspaceItems.id),
    toItemId: text('to_item_id')
      .notNull()
      .references(() => researchWorkspaceItems.id),
    label: text('label').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
  },
  (t) => [index('research_workspace_relations_list_idx').on(t.projectId, t.recordId, t.id)],
);
