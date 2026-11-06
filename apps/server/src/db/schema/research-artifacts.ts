import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ResearchArtifactVersion } from '@srh/shared';
import { createdAt, id } from './_helpers';
import { projects } from './core';
import { researchWorkspaceItems } from './research-workspace';

/** 只保存不可变版本索引；完整快照和图像保存在项目隔离目录。 */
export const researchArtifactVersions = pgTable(
  'research_artifact_versions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    itemId: text('item_id')
      .notNull()
      .references(() => researchWorkspaceItems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    storagePath: text('storage_path').notNull(),
    requestKey: text('request_key').notNull(),
    data: jsonb('data').$type<ResearchArtifactVersion>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('research_artifact_item_version_idx').on(t.itemId, t.version),
    uniqueIndex('research_artifact_request_idx').on(t.projectId, t.requestKey),
    index('research_artifact_record_idx').on(t.projectId, t.recordId, t.itemId, t.id),
  ],
);
