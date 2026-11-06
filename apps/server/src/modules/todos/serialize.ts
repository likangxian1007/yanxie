import type { Todo } from '@srh/shared';
import type { todos } from '../../db/schema';
import { iso, isoReq } from '../collab-common';

export type TodoRow = typeof todos.$inferSelect;

/** 行 → DTO（时间转 ISO） */
export function todoDto(row: TodoRow): Todo {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerUserId: row.ownerUserId,
    assigneeId: row.assigneeId,
    title: row.title,
    notes: row.notes,
    done: row.done,
    priority: row.priority,
    dueAt: iso(row.dueAt),
    position: row.position,
    source: row.source ?? null,
    createdBy: row.createdBy,
    createdAt: isoReq(row.createdAt),
    completedAt: iso(row.completedAt),
  };
}
