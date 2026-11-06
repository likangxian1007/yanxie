import type { Board, BoardColumn, Card } from '@srh/shared';
import { positionBetween, sortByPosition } from './position';

/** GET P/boards/:boardId 的响应 */
export type BoardDetail = Board & { cards: Card[] };

/** 乐观创建时的临时卡片 id 前缀 */
export const TEMP_CARD_PREFIX = 'tmp_';

export function isTempCard(id: string): boolean {
  return id.startsWith(TEMP_CARD_PREFIX);
}

export function sortColumns(columns: readonly BoardColumn[]): BoardColumn[] {
  return sortByPosition(columns);
}

/** 列 id → 按位置排好的卡片（每一列都有条目，空列为 []；不属于任何列的卡片丢弃） */
export function groupCards(
  cards: readonly Card[],
  columns: readonly BoardColumn[],
): Map<string, Card[]> {
  const map = new Map<string, Card[]>(columns.map((c) => [c.id, []]));
  for (const card of sortByPosition(cards)) map.get(card.columnId)?.push(card);
  return map;
}

/** 写入一张卡（新增或替换）；已有更新版本时忽略过期的事件。 */
export function upsertCard(detail: BoardDetail, card: Card): BoardDetail {
  if (card.boardId !== detail.id) return detail;
  const existing = detail.cards.find((c) => c.id === card.id);
  if (existing && existing.version > card.version) return detail;
  const cards = existing
    ? detail.cards.map((c) => (c.id === card.id ? card : c))
    : [...detail.cards, card];
  return { ...detail, cards };
}

export function removeCard(detail: BoardDetail, cardId: string): BoardDetail {
  if (!detail.cards.some((c) => c.id === cardId)) return detail;
  return { ...detail, cards: detail.cards.filter((c) => c.id !== cardId) };
}

export function upsertColumn(detail: BoardDetail, column: BoardColumn): BoardDetail {
  if (column.boardId !== detail.id) return detail;
  const exists = detail.columns.some((c) => c.id === column.id);
  const columns = exists
    ? detail.columns.map((c) => (c.id === column.id ? column : c))
    : [...detail.columns, column];
  return { ...detail, columns };
}

/** 删除列；moveTo 给出时把该列的卡片挪到目标列末尾（与服务端 DELETE ?moveTo= 一致），否则一并删除。 */
export function removeColumn(
  detail: BoardDetail,
  columnId: string,
  moveTo?: string | null,
): BoardDetail {
  if (!detail.columns.some((c) => c.id === columnId)) return detail;
  const columns = detail.columns.filter((c) => c.id !== columnId);
  let cards = detail.cards;
  if (moveTo && columns.some((c) => c.id === moveTo)) {
    const target = sortByPosition(cards.filter((c) => c.columnId === moveTo));
    let last = target[target.length - 1]?.position ?? null;
    const moving = sortByPosition(cards.filter((c) => c.columnId === columnId));
    const moved = new Map<string, Card>();
    for (const card of moving) {
      const position = positionBetween(last, null);
      last = position;
      moved.set(card.id, { ...card, columnId: moveTo, position });
    }
    cards = cards.map((c) => moved.get(c.id) ?? c);
  } else {
    cards = cards.filter((c) => c.columnId !== columnId);
  }
  return { ...detail, columns, cards };
}

export interface CardMove {
  cards: Card[];
  /** 发给服务端的 afterCardId（null = 列首） */
  afterCardId: string | null;
  /** 本地临时位置 */
  position: string;
  /** 位置或列真的变了 */
  changed: boolean;
}

/**
 * 把卡片移到 toColumnId 的第 toIndex 位（toIndex 按“去掉这张卡之后”的目标列计算）。
 * 返回本地重排后的卡片与 PATCH 用的 afterCardId；卡片不存在时返回 null。
 */
export function moveCard(
  cards: readonly Card[],
  cardId: string,
  toColumnId: string,
  toIndex: number,
): CardMove | null {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const target = sortByPosition(cards.filter((c) => c.columnId === toColumnId && c.id !== cardId));
  const index = Math.max(0, Math.min(toIndex, target.length));
  const prev = target[index - 1] ?? null;
  const next = target[index] ?? null;

  const sameColumn = card.columnId === toColumnId;
  const before = sortByPosition(cards.filter((c) => c.columnId === toColumnId));
  const unchanged = sameColumn && before.findIndex((c) => c.id === cardId) === index;
  if (unchanged) {
    return {
      cards: [...cards],
      afterCardId: prev?.id ?? null,
      position: card.position,
      changed: false,
    };
  }

  const position = positionBetween(prev?.position ?? null, next?.position ?? null);
  return {
    cards: cards.map((c) => (c.id === cardId ? { ...c, columnId: toColumnId, position } : c)),
    afterCardId: prev?.id ?? null,
    position,
    changed: true,
  };
}

/**
 * 与服务端语义一致的移动：插在 afterCardId 之后（null = 列首）。
 * afterCardId 不在目标列里时放到列尾。
 */
export function moveCardAfter(
  cards: readonly Card[],
  cardId: string,
  toColumnId: string,
  afterCardId: string | null,
): CardMove | null {
  if (afterCardId === null) return moveCard(cards, cardId, toColumnId, 0);
  const target = sortByPosition(cards.filter((c) => c.columnId === toColumnId && c.id !== cardId));
  const i = target.findIndex((c) => c.id === afterCardId);
  return moveCard(cards, cardId, toColumnId, i === -1 ? target.length : i + 1);
}

/** 新卡追加到列尾时的临时位置 */
export function positionAtEnd(cards: readonly Card[], columnId: string): string {
  const list = sortByPosition(cards.filter((c) => c.columnId === columnId));
  return positionBetween(list[list.length - 1]?.position ?? null, null);
}

/** 列表里写入/替换一个看板（保持原顺序，新看板追加） */
export function upsertBoard(list: readonly Board[], board: Board): Board[] {
  const exists = list.some((b) => b.id === board.id);
  return exists ? list.map((b) => (b.id === board.id ? board : b)) : [...list, board];
}

/** 看板列表按创建时间排序（默认看板在前） */
export function sortBoards(list: readonly Board[]): Board[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1));
}
