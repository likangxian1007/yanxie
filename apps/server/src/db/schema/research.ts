import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ResearchTemplate } from '@srh/shared';
import { actor, createdAt, id, updatedAt } from './_helpers';
import { projects } from './core';

/** 项目发布模板的每个版本独立成行；预置模板由 shared 常量提供。 */
export const researchTemplates = pgTable(
  'research_templates',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    data: jsonb('data').$type<ResearchTemplate>().notNull(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    index('research_templates_project_idx').on(t.projectId, t.id),
  ],
);

/** 不同对象的通用存储：data 保存完整 DTO，record_id 用于列表及项目内索引。 */
export const researchEntities = pgTable(
  'research_entities',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id'),
    kind: text('kind').notNull(),
    version: integer('version').notNull().default(1),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('research_entities_list_idx').on(t.projectId, t.kind, t.recordId, t.id)],
);

/** 每次 record 更新的不可变完整修订。 */
export const researchRevisions = pgTable(
  'research_revisions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    version: integer('version').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('research_revisions_version_idx').on(t.recordId, t.version)],
);

/** 同项目、操作者、动作内幂等键；hash 防止相同键不同请求被当作成功。 */
export const researchIdempotency = pgTable(
  'research_idempotency',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('research_idempotency_scope_idx').on(t.projectId, t.actorId, t.action, t.key),
  ],
);

/** Snapshot 的实际字节放 STORAGE_DIR/research-snapshots/<project>/<id>，数据库仅存私有定位。 */
export const researchSnapshotFiles = pgTable('research_snapshot_files', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  relativePath: text('relative_path').notNull(),
  createdAt: createdAt(),
});
