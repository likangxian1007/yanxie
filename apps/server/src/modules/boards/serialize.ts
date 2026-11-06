import type { Board, BoardColumn, Card } from '@srh/shared';
import type { boardColumns, boards, cards } from '../../db/schema';
import { iso, isoReq } from '../collab-common';

export type BoardRow = typeof boards.$inferSelect;
export type ColumnRow = typeof boardColumns.$inferSelect;
export type CardRow = typeof cards.$inferSelect;

/** 行 → DTO（时间转 ISO） */
export function columnDto(row: ColumnRow): BoardColumn {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    position: row.position,
    color: row.color,
  };
}

/** columns 需按 position 排好序 */
export function boardDto(row: BoardRow, columns: ColumnRow[]): Board {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    columns: columns.map(columnDto),
    createdAt: isoReq(row.createdAt),
  };
}

export function cardDto(row: CardRow): Card {
  return {
    id: row.id,
    boardId: row.boardId,
    columnId: row.columnId,
    title: row.title,
    description: row.description,
    position: row.position,
    assigneeIds: row.assigneeIds,
    labels: row.labels,
    dueAt: iso(row.dueAt),
    threadId: row.threadId,
    experimentId: null,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}
