import type { Report } from '@srh/shared';
import type { reports } from '../../db/schema';

export type ReportRow = typeof reports.$inferSelect;

export function serializeReport(row: ReportRow): Report {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    content: row.content,
    documentId: row.documentId,
    stats: row.stats ?? null,
    error: row.error,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
