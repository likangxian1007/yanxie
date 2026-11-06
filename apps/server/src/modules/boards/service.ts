import { and, asc, desc, eq, ne, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ApiError,
  BoardCreateInput,
  BoardUpdateInput,
  CardCreateInput,
  CardUpdateInput,
  ColumnUpsertInput,
  newId,
  type ActorRef,
  type Board,
  type BoardColumn,
  type Card,
  type ProjectEvent,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { boardColumns, boards, cards, projects } from '../../db/schema';
import { parse } from '../../lib/http';
import {
  assertExperimentInProject,
  assertLinkableThread,
  assertVersion,
  notFound,
  parseDate,
  positionBetween,
} from '../collab-common';
import { markInboxDoneBySource } from '../collab-common/inbox';
import { addedAssignees, eventThreadId, notifyAssigned, validateAssignees } from './assignees';
import { posAfter, posKey } from './position';
import {
  boardDto,
  cardDto,
  columnDto,
  type BoardRow,
  type CardRow,
  type ColumnRow,
} from './serialize';

/**
 * 科研看板的业务逻辑（路由与 agent 工具共用）。
 * 写操作：事务里写表 + bus.record，提交后 bus.emit；指派通知在提交后写收件箱。
 */

export type BoardCreate = z.input<typeof BoardCreateInput>;
export type BoardUpdate = z.input<typeof BoardUpdateInput>;
export type ColumnUpsert = z.input<typeof ColumnUpsertInput>;
export type ColumnPatch = Partial<ColumnUpsert>;
export type CardCreate = CardCreateInput;
export type CardUpdate = CardUpdateInput;
export type BoardWithCards = Board & { cards: Card[] };

export const DEFAULT_BOARD_NAME = '研究看板';
/** 默认列：想法 / 进行中 / 待审阅 / 完成（颜色为色板序号，见 STYLE.md §1.2） */
export const DEFAULT_COLUMNS: readonly { name: string; color: number }[] = [
  { name: '想法', color: 1 },
  { name: '进行中', color: 2 },
  { name: '待审阅', color: 0 },
  { name: '完成', color: 4 },
];
/** 自定义列按这个顺序轮流取色 */
const COLOR_CYCLE = [1, 2, 0, 4, 3, 5, 6, 7] as const;

const ColumnPatchInput = ColumnUpsertInput.partial();

export const cardHref = (projectId: string, cardId: string) =>
  `/p/${projectId}/board?card=${cardId}`;

// ---------------------------------------------------------------- 读取

function invalid(field: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path: field, message }] });
}

async function columnsOf(exec: Db, boardId: string): Promise<ColumnRow[]> {
  return exec
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(asc(posKey(boardColumns.position)), asc(boardColumns.id));
}

async function boardRow(exec: Db, projectId: string, boardId: string): Promise<BoardRow> {
  const [row] = await exec
    .select()
    .from(boards)
    .where(and(eq(boards.id, boardId), eq(boards.projectId, projectId)));
  if (!row) notFound('看板');
  return row;
}

async function boardOf(exec: Db, row: BoardRow): Promise<Board> {
  return boardDto(row, await columnsOf(exec, row.id));
}

async function columnRow(exec: Db, projectId: string, columnId: string): Promise<ColumnRow> {
  const [row] = await exec
    .select({ column: boardColumns })
    .from(boardColumns)
    .innerJoin(boards, eq(boards.id, boardColumns.boardId))
    .where(and(eq(boardColumns.id, columnId), eq(boards.projectId, projectId)));
  if (!row) notFound('列');
  return row.column;
}

async function cardRow(
  exec: Db,
  projectId: string,
  cardId: string,
  lock = false,
): Promise<CardRow> {
  const query = exec
    .select({ card: cards })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(eq(cards.id, cardId), eq(boards.projectId, projectId)));
  // 只锁卡片行（FOR UPDATE OF cards），不锁看板
  const [row] = lock ? await query.for('update', { of: cards }) : await query;
  if (!row) notFound('卡片');
  return row.card;
}

/** 列必须属于给定看板，否则 422 */
async function columnInBoard(exec: Db, boardId: string, columnId: string): Promise<ColumnRow> {
  const [row] = await exec
    .select()
    .from(boardColumns)
    .where(and(eq(boardColumns.id, columnId), eq(boardColumns.boardId, boardId)));
  if (!row) invalid('columnId', '目标列不在这个看板里');
  return row;
}

/**
 * 卡片在列里的位置：afterCardId 为 undefined = 列尾，null = 列首，否则插在该卡与其下一张之间。
 * excludeId：移动时排除卡片自己。
 */
async function cardPosition(
  exec: Db,
  columnId: string,
  afterCardId: string | null | undefined,
  excludeId?: string,
): Promise<string> {
  const inColumn = (...extra: SQL[]) =>
    and(eq(cards.columnId, columnId), ...(excludeId ? [ne(cards.id, excludeId)] : []), ...extra);
  if (afterCardId === undefined) {
    const [last] = await exec
      .select({ position: cards.position })
      .from(cards)
      .where(inColumn())
      .orderBy(desc(posKey(cards.position)))
      .limit(1);
    return positionBetween(last?.position ?? null, null);
  }
  if (afterCardId === null) {
    const [first] = await exec
      .select({ position: cards.position })
      .from(cards)
      .where(inColumn())
      .orderBy(asc(posKey(cards.position)))
      .limit(1);
    return positionBetween(null, first?.position ?? null);
  }
  const [after] = await exec
    .select({ position: cards.position })
    .from(cards)
    .where(inColumn(eq(cards.id, afterCardId)));
  if (!after) invalid('afterCardId', 'afterCardId 指向的卡片不在目标列里');
  const [next] = await exec
    .select({ position: cards.position })
    .from(cards)
    .where(inColumn(posAfter(cards.position, after.position)))
    .orderBy(asc(posKey(cards.position)))
    .limit(1);
  return positionBetween(after.position, next?.position ?? null);
}

async function lastColumnPosition(exec: Db, boardId: string): Promise<string | null> {
  const [last] = await exec
    .select({ position: boardColumns.position })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(desc(posKey(boardColumns.position)))
    .limit(1);
  return last?.position ?? null;
}

/** 校验客户端传来的分数位置；非法时 422 */
function checkPosition(position: string): string {
  try {
    positionBetween(position, null);
    return position;
  } catch {
    invalid('position', '列位置格式不对');
  }
}

async function firstBoardRow(exec: Db, projectId: string): Promise<BoardRow | undefined> {
  const [row] = await exec
    .select()
    .from(boards)
    .where(eq(boards.projectId, projectId))
    .orderBy(asc(boards.createdAt), asc(boards.id))
    .limit(1);
  return row;
}

function emitAll(ctx: AppContext, events: ProjectEvent[]) {
  for (const ev of events) ctx.bus.emit(ev);
}

// ---------------------------------------------------------------- 看板

async function insertBoard(
  exec: Db,
  projectId: string,
  name: string,
  columns: readonly { name: string; color: number | null }[],
): Promise<Board> {
  const [row] = await exec
    .insert(boards)
    .values({ id: newId('board'), projectId, name })
    .returning();
  if (!row) throw new Error('看板写入失败');
  let prev: string | null = null;
  const columnRows: ColumnRow[] = [];
  for (const col of columns) {
    const position = positionBetween(prev, null);
    prev = position;
    const [c] = await exec
      .insert(boardColumns)
      .values({ id: newId('column'), boardId: row.id, name: col.name, position, color: col.color })
      .returning();
    if (c) columnRows.push(c);
  }
  return boardDto(row, columnRows);
}

/**
 * 项目的看板（按创建时间）；还没有看板时先建默认看板，前端打开就有内容。
 * createDefault=false（访客等只读角色）：不建，没有就返回空列表——只读请求不能产生写入。
 */
export async function listBoards(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  { createDefault = true }: { createDefault?: boolean } = {},
): Promise<Board[]> {
  const db = ctx.db.db;
  let rows = await db
    .select()
    .from(boards)
    .where(eq(boards.projectId, projectId))
    .orderBy(asc(boards.createdAt), asc(boards.id));
  if (!rows.length && createDefault) {
    await ensureDefaultBoard(ctx, actor, projectId);
    rows = await db
      .select()
      .from(boards)
      .where(eq(boards.projectId, projectId))
      .orderBy(asc(boards.createdAt), asc(boards.id));
  }
  const result: Board[] = [];
  for (const row of rows) result.push(await boardOf(db, row));
  return result;
}

/** 幂等：已有看板返回第一个（按 createdAt），否则建“研究看板”+ 默认列。 */
export async function ensureDefaultBoard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
): Promise<Board> {
  const existing = await firstBoardRow(ctx.db.db, projectId);
  if (existing) return boardOf(ctx.db.db, existing);
  const { board, events } = await ctx.db.db.transaction(async (tx) => {
    // 锁住项目行，并发的 ensure 只会有一个真正建看板
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (!project) notFound('项目');
    const again = await firstBoardRow(tx, projectId);
    if (again) return { board: await boardOf(tx, again), events: [] as ProjectEvent[] };
    const created = await insertBoard(tx, projectId, DEFAULT_BOARD_NAME, DEFAULT_COLUMNS);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'board.created',
      payload: created,
      actor,
    });
    return { board: created, events: [ev] as ProjectEvent[] };
  });
  emitAll(ctx, events);
  return board;
}

export async function createBoard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: BoardCreate,
): Promise<Board> {
  const data = parse(BoardCreateInput, input);
  const names = (data.columns ?? []).map((n) => n.trim()).filter(Boolean);
  const columns = names.length
    ? names.map((name, i) => ({ name, color: COLOR_CYCLE[i % COLOR_CYCLE.length] ?? null }))
    : DEFAULT_COLUMNS;
  const { board, ev } = await ctx.db.db.transaction(async (tx) => {
    const created = await insertBoard(tx, projectId, data.name, columns);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'board.created',
      payload: created,
      actor,
    });
    return { board: created, ev };
  });
  ctx.bus.emit(ev);
  return board;
}

export async function getBoard(
  ctx: AppContext,
  projectId: string,
  boardId: string,
): Promise<BoardWithCards> {
  const db = ctx.db.db;
  const row = await boardRow(db, projectId, boardId);
  const board = await boardOf(db, row);
  const cardRows = await db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.columnId), asc(posKey(cards.position)), asc(cards.id));
  return { ...board, cards: cardRows.map(cardDto) };
}

export async function updateBoard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  boardId: string,
  input: BoardUpdate,
): Promise<Board> {
  const data = parse(BoardUpdateInput, input);
  const { board, ev } = await ctx.db.db.transaction(async (tx) => {
    await boardRow(tx, projectId, boardId);
    const [row] = await tx
      .update(boards)
      .set({ name: data.name })
      .where(eq(boards.id, boardId))
      .returning();
    if (!row) notFound('看板');
    const board = await boardOf(tx, row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'board.updated',
      payload: board,
      actor,
    });
    return { board, ev };
  });
  ctx.bus.emit(ev);
  return board;
}

export async function deleteBoard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  boardId: string,
): Promise<void> {
  const ev = await ctx.db.db.transaction(async (tx) => {
    await boardRow(tx, projectId, boardId);
    const all = await tx
      .select({ id: boards.id })
      .from(boards)
      .where(eq(boards.projectId, projectId));
    if (all.length <= 1) {
      throw new ApiError('conflict', '这是项目的最后一个看板，不能删除。可以先新建一个看板再删它');
    }
    await tx.delete(boards).where(eq(boards.id, boardId));
    return ctx.bus.record(tx, {
      projectId,
      type: 'board.deleted',
      payload: { id: boardId },
      actor,
    });
  });
  ctx.bus.emit(ev);
}

// ---------------------------------------------------------------- 列

export async function createColumn(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  boardId: string,
  input: ColumnUpsert,
): Promise<BoardColumn> {
  const data = parse(ColumnUpsertInput, input);
  const { column, ev } = await ctx.db.db.transaction(async (tx) => {
    await boardRow(tx, projectId, boardId);
    const position =
      data.position !== undefined
        ? checkPosition(data.position)
        : positionBetween(await lastColumnPosition(tx, boardId), null);
    const [row] = await tx
      .insert(boardColumns)
      .values({
        id: newId('column'),
        boardId,
        name: data.name,
        position,
        color: data.color ?? null,
      })
      .returning();
    if (!row) throw new Error('列写入失败');
    const column = columnDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'column.created',
      payload: column,
      actor,
    });
    return { column, ev };
  });
  ctx.bus.emit(ev);
  return column;
}

/** PATCH 列：name / position / color 任意组合 */
export async function updateColumn(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  columnId: string,
  input: ColumnPatch,
): Promise<BoardColumn> {
  const data = parse(ColumnPatchInput, input);
  const { column, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await columnRow(tx, projectId, columnId);
    const patch: Partial<ColumnRow> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.position !== undefined) patch.position = checkPosition(data.position);
    if (data.color !== undefined) patch.color = data.color;
    let row = current;
    if (Object.keys(patch).length) {
      const [updated] = await tx
        .update(boardColumns)
        .set(patch)
        .where(eq(boardColumns.id, columnId))
        .returning();
      if (!updated) notFound('列');
      row = updated;
    }
    const column = columnDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'column.updated',
      payload: column,
      actor,
    });
    return { column, ev };
  });
  ctx.bus.emit(ev);
  return column;
}

/**
 * 删除列。列里还有卡片时：传 moveTo（同一看板的另一列）则把卡片按原顺序移到目标列末尾
 * （每张发 card.updated），否则 409。
 */
export async function deleteColumn(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  columnId: string,
  moveTo?: string,
): Promise<void> {
  const events = await ctx.db.db.transaction(async (tx) => {
    const column = await columnRow(tx, projectId, columnId);
    const siblings = await columnsOf(tx, column.boardId);
    if (siblings.length <= 1) {
      throw new ApiError('conflict', '看板至少要保留一列，不能删除最后一列');
    }
    const inColumn = await tx
      .select()
      .from(cards)
      .where(eq(cards.columnId, columnId))
      .orderBy(asc(posKey(cards.position)), asc(cards.id));
    const out: ProjectEvent[] = [];
    if (inColumn.length) {
      if (!moveTo) {
        throw new ApiError('conflict', '这一列还有卡片，先移走或指定 moveTo', {
          cardCount: inColumn.length,
        });
      }
      if (moveTo === columnId) invalid('moveTo', 'moveTo 不能是要删除的这一列');
      await columnInBoard(tx, column.boardId, moveTo);
      const [last] = await tx
        .select({ position: cards.position })
        .from(cards)
        .where(eq(cards.columnId, moveTo))
        .orderBy(desc(posKey(cards.position)))
        .limit(1);
      let prev = last?.position ?? null;
      for (const card of inColumn) {
        const position = positionBetween(prev, null);
        prev = position;
        const [moved] = await tx
          .update(cards)
          .set({ columnId: moveTo, position, version: card.version + 1, updatedAt: new Date() })
          .where(eq(cards.id, card.id))
          .returning();
        if (!moved) continue;
        out.push(
          await ctx.bus.record(tx, {
            projectId,
            threadId: moved.threadId,
            type: 'card.updated',
            payload: cardDto(moved),
            actor,
          }),
        );
      }
    }
    await tx.delete(boardColumns).where(eq(boardColumns.id, columnId));
    out.push(
      await ctx.bus.record(tx, {
        projectId,
        type: 'column.deleted',
        payload: { id: columnId },
        actor,
      }),
    );
    return out;
  });
  emitAll(ctx, events);
}

// ---------------------------------------------------------------- 卡片

export async function createCard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  boardId: string,
  input: CardCreate,
): Promise<Card> {
  const data = parse(CardCreateInput, input);
  const dueAt = parseDate(data.dueAt, 'dueAt');
  const { card, ev } = await ctx.db.db.transaction(async (tx) => {
    await boardRow(tx, projectId, boardId);
    await columnInBoard(tx, boardId, data.columnId);
    await assertLinkableThread(tx, actor, projectId, data.threadId);
    await assertExperimentInProject(tx, projectId, data.experimentId);
    const assigneeIds = await validateAssignees(tx, projectId, data.assigneeIds);
    const position = await cardPosition(tx, data.columnId, data.afterCardId);
    const [row] = await tx
      .insert(cards)
      .values({
        id: newId('card'),
        boardId,
        columnId: data.columnId,
        title: data.title,
        description: data.description,
        position,
        assigneeIds,
        labels: data.labels,
        dueAt,
        threadId: data.threadId,
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error('卡片写入失败');
    const card = cardDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      threadId: eventThreadId(card.threadId, assigneeIds),
      type: 'card.created',
      payload: card,
      actor,
    });
    return { card, ev };
  });
  ctx.bus.emit(ev);
  await notifyAssigned(ctx, actor, projectId, card.assigneeIds, {
    title: card.title,
    href: cardHref(projectId, card.id),
    sourceId: card.id,
  });
  return card;
}

/**
 * 改卡片（必须带 baseVersion）。改 columnId 和/或 afterCardId 即移动：
 * 只改列不给 afterCardId = 目标列末尾。
 */
export async function updateCard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  cardId: string,
  input: CardUpdate,
): Promise<Card> {
  const data = parse(CardUpdateInput, input);
  const dueAt = data.dueAt === undefined ? undefined : parseDate(data.dueAt, 'dueAt');
  const { card, added, ev } = await ctx.db.db.transaction(async (tx) => {
    // 锁住卡片行：并发的两次修改串行，后到的那次按版本号 409
    const current = await cardRow(tx, projectId, cardId, true);
    assertVersion(current, data.baseVersion, cardDto(current));

    const patch: Partial<CardRow> = {
      version: current.version + 1,
      updatedAt: new Date(),
    };
    const targetColumn = data.columnId ?? current.columnId;
    if (data.columnId !== undefined && data.columnId !== current.columnId) {
      await columnInBoard(tx, current.boardId, data.columnId);
      patch.columnId = data.columnId;
    }
    const moving = patch.columnId !== undefined || data.afterCardId !== undefined;
    if (moving && data.afterCardId !== cardId) {
      patch.position = await cardPosition(tx, targetColumn, data.afterCardId, cardId);
    }
    if (data.title !== undefined) patch.title = data.title;
    if (data.description !== undefined) patch.description = data.description;
    if (data.labels !== undefined) patch.labels = data.labels;
    if (dueAt !== undefined) patch.dueAt = dueAt;
    // 只在改关联时校验：原样带回已有的值不算重新关联
    if (data.threadId !== undefined && data.threadId !== current.threadId) {
      await assertLinkableThread(tx, actor, projectId, data.threadId);
      patch.threadId = data.threadId;
    }
    if (data.experimentId !== undefined && data.experimentId !== null) {
      await assertExperimentInProject(tx, projectId, data.experimentId);
    }
    let added: string[] = [];
    if (data.assigneeIds !== undefined) {
      const next = await validateAssignees(tx, projectId, data.assigneeIds);
      added = addedAssignees(current.assigneeIds, next);
      patch.assigneeIds = next;
    }

    // 行已锁，版本条件只是兜底：万一没命中就按版本冲突处理
    const [row] = await tx
      .update(cards)
      .set(patch)
      .where(and(eq(cards.id, cardId), eq(cards.version, data.baseVersion)))
      .returning();
    if (!row) {
      const latest = await cardRow(tx, projectId, cardId);
      throw new ApiError('version_conflict', '内容已被他人修改，已为你载入最新版本', {
        current: cardDto(latest),
      });
    }
    const card = cardDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      threadId: eventThreadId(card.threadId, added),
      type: 'card.updated',
      payload: card,
      actor,
    });
    return { card, added, ev };
  });
  ctx.bus.emit(ev);
  await notifyAssigned(ctx, actor, projectId, added, {
    title: card.title,
    href: cardHref(projectId, card.id),
    sourceId: card.id,
  });
  return card;
}

export async function deleteCard(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  cardId: string,
): Promise<void> {
  const ev = await ctx.db.db.transaction(async (tx) => {
    const current = await cardRow(tx, projectId, cardId);
    await tx.delete(cards).where(eq(cards.id, cardId));
    return ctx.bus.record(tx, {
      projectId,
      threadId: current.threadId,
      type: 'card.deleted',
      payload: { id: cardId },
      actor,
    });
  });
  ctx.bus.emit(ev);
  // 卡片没了，相关的“指派给你”也就处理完了
  await markInboxDoneBySource(ctx, projectId, cardId, actor);
}

/**
 * agent 端口用：boardId 缺省 = 默认看板；columnId 缺省 = 第一列。
 */
export async function createCardAuto(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: Partial<CardCreate> & { title: string; boardId?: string },
): Promise<Card> {
  const { boardId: givenBoardId, ...rest } = input;
  const boardId = givenBoardId ?? (await ensureDefaultBoard(ctx, actor, projectId)).id;
  let columnId = rest.columnId;
  if (!columnId) {
    const columns = await columnsOf(ctx.db.db, (await boardRow(ctx.db.db, projectId, boardId)).id);
    const first = columns[0];
    if (!first) throw new ApiError('conflict', '这个看板还没有列，先建一列再加卡片');
    columnId = first.id;
  }
  return createCard(ctx, actor, projectId, boardId, { ...rest, columnId });
}
