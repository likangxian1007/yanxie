import { useMemo } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Board, BoardColumn, Card, CardUpdateInput, User } from '@srh/shared';
import { toast } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { useMeUser } from '@/lib/session';
import { ck } from '@/features/collab-kit/keys';
import {
  getFieldSync,
  peekFieldSync,
  versionConflictCurrent,
} from '@/features/collab-kit/conflict/use-field-sync';
import {
  TEMP_CARD_PREFIX,
  moveCardAfter,
  positionAtEnd,
  removeCard,
  removeColumn,
  sortBoards,
  upsertBoard,
  upsertCard,
  upsertColumn,
  type BoardDetail,
} from './lib/board-state';
import { positionBetween, sortByPosition } from './lib/position';
import { tr } from '@/lib/i18n';

/** 列表接口按契约返回数组；兼容一下分页形状 */
function toList<T>(res: T[] | { items: T[] } | null | undefined): T[] {
  if (Array.isArray(res)) return res;
  return res?.items ?? [];
}

function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : tr('请稍后再试。');
}

// ---------------------------------------------------------------- 查询

export function boardsQueryOptions(pid: string) {
  return queryOptions({
    queryKey: ck.boards(pid),
    queryFn: async ({ signal }) =>
      sortBoards(toList(await api.get<Board[]>(`/projects/${pid}/boards`, { signal }))),
    enabled: Boolean(pid),
  });
}

export function boardQueryOptions(pid: string, boardId: string | undefined) {
  return queryOptions({
    queryKey: ck.board(pid, boardId ?? ''),
    queryFn: ({ signal }) => fetchBoard(pid, boardId ?? '', signal),
    enabled: Boolean(pid && boardId),
  });
}

export function useBoards(pid: string) {
  return useQuery(boardsQueryOptions(pid));
}

export function useBoard(pid: string, boardId: string | undefined) {
  return useQuery(boardQueryOptions(pid, boardId));
}

export function fetchBoard(pid: string, boardId: string, signal?: AbortSignal) {
  return api.get<BoardDetail>(
    `/projects/${pid}/boards/${boardId}`,
    signal ? { signal } : undefined,
  );
}

// ---------------------------------------------------------------- 实时

function eachBoardDetail(qc: QueryClient, pid: string, fn: (d: BoardDetail) => BoardDetail) {
  for (const [key, data] of qc.getQueriesData<BoardDetail>({ queryKey: ['p', pid, 'board'] })) {
    if (data) qc.setQueryData<BoardDetail>(key, fn(data));
  }
}

/** board./column./card.* 事件写进缓存；别人的改动直接出现在看板上。 */
export function useBoardRealtime(pid: string) {
  const qc = useQueryClient();
  const me = useMeUser();
  useProjectEvent(pid, (event) => {
    switch (event.type) {
      case 'board.created':
      case 'board.updated': {
        const board = event.payload;
        qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
          list ? sortBoards(upsertBoard(list, board)) : list,
        );
        qc.setQueryData<BoardDetail>(ck.board(pid, board.id), (d) =>
          d ? { ...d, name: board.name, columns: board.columns } : d,
        );
        break;
      }
      case 'board.deleted': {
        const { id } = event.payload;
        qc.setQueryData<Board[]>(ck.boards(pid), (list) => list?.filter((b) => b.id !== id));
        qc.removeQueries({ queryKey: ck.board(pid, id) });
        break;
      }
      case 'column.created':
      case 'column.updated': {
        const column = event.payload;
        qc.setQueryData<BoardDetail>(ck.board(pid, column.boardId), (d) =>
          d ? upsertColumn(d, column) : d,
        );
        qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
          list?.map((b) =>
            b.id === column.boardId
              ? {
                  ...b,
                  columns: b.columns.some((c) => c.id === column.id)
                    ? b.columns.map((c) => (c.id === column.id ? column : c))
                    : [...b.columns, column],
                }
              : b,
          ),
        );
        break;
      }
      case 'column.deleted': {
        const { id } = event.payload;
        let affected: string | null = null;
        eachBoardDetail(qc, pid, (d) => {
          if (!d.columns.some((c) => c.id === id)) return d;
          affected = d.id;
          return { ...d, columns: d.columns.filter((c) => c.id !== id) };
        });
        qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
          list?.map((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== id) })),
        );
        // 卡片可能被挪到了别的列：以服务端为准重拉
        if (affected) void qc.invalidateQueries({ queryKey: ck.board(pid, affected) });
        break;
      }
      case 'card.created':
      case 'card.updated': {
        const card = event.payload;
        // 记下是谁改的：冲突提示里写名字
        const sync = peekFieldSync(qc, cardSyncKey(pid, card.id));
        if (sync && event.actor.id !== me?.id) sync.remoteActor = event.actor.name;
        qc.setQueryData<BoardDetail>(ck.board(pid, card.boardId), (d) =>
          d ? upsertCard(d, card) : d,
        );
        break;
      }
      case 'card.deleted': {
        const { id } = event.payload;
        eachBoardDetail(qc, pid, (d) => removeCard(d, id));
        break;
      }

      default:
        break;
    }
  });
}

// ---------------------------------------------------------------- 写入

/** 同一张卡的写入（字段保存、移动）串行发送 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(cardId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(cardId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(cardId, tail);
  void tail.then(() => {
    if (queues.get(cardId) === tail) queues.delete(cardId);
  });
  return run;
}

/** 乐观创建的临时卡换成真卡后沿用原来的渲染 key，避免重新入场 */
const keyAlias = new Map<string, string>();
export function cardRenderKey(id: string): string {
  return keyAlias.get(id) ?? id;
}

export type CardPatch = Omit<CardUpdateInput, 'baseVersion' | 'afterCardId' | 'columnId'>;
/** 卡片详情里能编辑的字段 */
export type CardField = keyof CardPatch & keyof Card;

export const cardSyncKey = (pid: string, cardId: string) => `card:${pid}:${cardId}`;

const isVersionConflict = (err: unknown): err is ApiRequestError =>
  err instanceof ApiRequestError && err.code === 'version_conflict';

function createActions(qc: QueryClient, pid: string, boardId: string, me: User | null) {
  const key = ck.board(pid, boardId);
  const get = () => qc.getQueryData<BoardDetail>(key);
  const set = (fn: (d: BoardDetail) => BoardDetail) =>
    qc.setQueryData<BoardDetail>(key, (d) => (d ? fn(d) : d));
  const findCard = (id: string) => get()?.cards.find((c) => c.id === id);
  /** 不比较版本，直接写（回滚、冲突时用） */
  const forceCard = (card: Card) =>
    set((d) => ({
      ...d,
      cards: d.cards.some((c) => c.id === card.id)
        ? d.cards.map((c) => (c.id === card.id ? card : c))
        : [...d.cards, card],
    }));

  /**
   * 卡片字段的同步器（草稿基线 + 409 合并视图，见 collab-kit/conflict/field-sync.ts）。
   * 字段改动只进草稿，界面显示草稿；保存时 baseVersion = 草稿开始时 / 上次保存成功时的版本。
   */
  const cardSync = (cardId: string) =>
    getFieldSync<Card>(qc, cardSyncKey(pid, cardId), () => ({
      delay: 1200,
      getServer: () => findCard(cardId),
      send: (patch, baseVersion) =>
        enqueue(cardId, () =>
          api.patch<Card>(`/projects/${pid}/cards/${cardId}`, { ...patch, baseVersion }),
        ),
      conflictCurrent: versionConflictCurrent<Card>(cardId),
      onServer: (card, force) => (force ? forceCard(card) : set((d) => upsertCard(d, card))),
      onError: (err) => {
        if (err instanceof ApiRequestError && err.status === 404) {
          set((d) => removeCard(d, cardId));
          toast({ title: tr('这张卡片已被删除'), tone: 'warning' });
          return;
        }
        toast.error(
          tr('没能保存卡片'),
          tr('{value} 你的改动还在，可以稍后重试。', { value: errorText(err) }),
        );
      },
    }));

  return {
    cardSync,

    /** 改字段（标题、描述、指派、标签、截止、关联）；immediate = 立刻保存（选择类控件） */
    editCard(cardId: string, patch: CardPatch, opts?: { immediate?: boolean }) {
      if (!findCard(cardId)) return;
      const sync = cardSync(cardId);
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sync.edit(field as CardField, value as never, opts);
      }
    },

    /** 把卡片的草稿立刻保存（失焦、关闭详情） */
    flushCard(cardId: string): Promise<void> {
      return cardSync(cardId).flush();
    },

    /**
     * 移动卡片：插到 toColumnId 中 afterCardId 之后（null = 列首）。
     * 移动只改列和位置，不碰内容字段：撞上 409（别人刚改过这张卡）就以最新版本重发，不丢这次拖动。
     */
    async moveCard(cardId: string, toColumnId: string, afterCardId: string | null): Promise<void> {
      const d = get();
      const card = d?.cards.find((c) => c.id === cardId);
      if (!d || !card) return;
      const move = moveCardAfter(d.cards, cardId, toColumnId, afterCardId);
      if (!move || !move.changed) return;
      set((cur) => ({ ...cur, cards: move.cards }));
      const body = { columnId: toColumnId, afterCardId: move.afterCardId };
      try {
        const saved = await enqueue(cardId, async () => {
          for (let attempt = 0; ; attempt += 1) {
            const base = findCard(cardId)?.version ?? card.version;
            try {
              return await api.patch<Card>(`/projects/${pid}/cards/${cardId}`, {
                ...body,
                baseVersion: base,
              });
            } catch (err) {
              const current = isVersionConflict(err)
                ? (err.details?.['current'] as Card | undefined)
                : undefined;
              if (!current || current.id !== cardId || attempt >= 2) throw err;
              // 别人的改动先收下（保留本地的列 / 位置），再按新版本重发移动
              forceCard({ ...current, columnId: toColumnId, position: move.position });
            }
          }
        });
        set((cur) => upsertCard(cur, saved));
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          set((cur) => removeCard(cur, cardId));
          toast({ title: tr('这张卡片已被删除'), tone: 'warning' });
          return;
        }
        const latest = findCard(cardId);
        forceCard({ ...(latest ?? card), columnId: card.columnId, position: card.position });
        void qc.invalidateQueries({ queryKey: key });
        toast.error(tr('没能移动卡片'), errorText(err));
      }
    },

    async createCard(columnId: string, title: string): Promise<Card | null> {
      const d = get();
      if (!d) return null;
      const tempId = `${TEMP_CARD_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const temp: Card = {
        id: tempId,
        boardId,
        columnId,
        title,
        description: '',
        position: positionAtEnd(d.cards, columnId),
        assigneeIds: [],
        labels: [],
        dueAt: null,
        threadId: null,
        experimentId: null,
        version: 0,
        createdBy: { kind: 'user', id: me?.id ?? null, name: me?.name ?? tr('你') },
        createdAt: now,
        updatedAt: now,
      };
      set((cur) => ({ ...cur, cards: [...cur.cards, temp] }));
      try {
        const saved = await api.post<Card>(`/projects/${pid}/boards/${boardId}/cards`, {
          columnId,
          title,
        });
        keyAlias.set(saved.id, tempId);
        set((cur) => upsertCard(removeCard(cur, tempId), saved));
        return saved;
      } catch (err) {
        set((cur) => removeCard(cur, tempId));
        toast.error(tr('没能添加卡片'), errorText(err));
        return null;
      }
    },

    async deleteCard(cardId: string): Promise<boolean> {
      const card = findCard(cardId);
      if (!card) return false;
      set((d) => removeCard(d, cardId));
      try {
        await api.delete(`/projects/${pid}/cards/${cardId}`);
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return true;
        forceCard(card);
        toast.error(tr('没能删除卡片'), errorText(err));
        return false;
      }
    },

    async createColumn(name: string, color: number | null): Promise<BoardColumn | null> {
      const d = get();
      const cols = sortByPosition(d?.columns ?? []);
      try {
        const column = await api.post<BoardColumn>(`/projects/${pid}/boards/${boardId}/columns`, {
          name,
          color,
          position: positionBetween(cols[cols.length - 1]?.position ?? null, null),
        });
        set((cur) => upsertColumn(cur, column));
        return column;
      } catch (err) {
        toast.error(tr('没能添加列'), errorText(err));
        return null;
      }
    },

    /** 列左移 / 右移一格：位置用与服务端相同的 fractional-indexing 算法算出 */
    async moveColumn(column: BoardColumn, direction: -1 | 1): Promise<void> {
      const cols = sortByPosition(get()?.columns ?? []);
      const i = cols.findIndex((c) => c.id === column.id);
      if (i === -1) return;
      const rest = cols.filter((c) => c.id !== column.id);
      const at = i + direction;
      if (at < 0 || at > rest.length) return;
      const position = positionBetween(rest[at - 1]?.position ?? null, rest[at]?.position ?? null);
      const before = cols[i]!;
      set((d) => upsertColumn(d, { ...before, position }));
      try {
        const saved = await api.patch<BoardColumn>(`/projects/${pid}/columns/${column.id}`, {
          position,
        });
        set((d) => upsertColumn(d, saved));
      } catch (err) {
        set((d) => upsertColumn(d, before));
        toast.error(tr('没能移动列'), errorText(err));
      }
    },

    async updateColumn(column: BoardColumn, patch: { name?: string; color?: number | null }) {
      const next = { ...column, ...patch };
      set((d) => upsertColumn(d, next));
      try {
        const saved = await api.patch<BoardColumn>(`/projects/${pid}/columns/${column.id}`, {
          name: next.name,
          color: next.color,
        });
        set((d) => upsertColumn(d, saved));
      } catch (err) {
        set((d) => upsertColumn(d, column));
        toast.error(tr('没能保存列'), errorText(err));
      }
    },

    async deleteColumn(column: BoardColumn, moveTo: string | null): Promise<boolean> {
      const before = get();
      set((d) => removeColumn(d, column.id, moveTo));
      try {
        await api.delete(`/projects/${pid}/columns/${column.id}`, {
          query: moveTo ? { moveTo } : undefined,
        });
        if (moveTo) void qc.invalidateQueries({ queryKey: key });
        return true;
      } catch (err) {
        if (before) qc.setQueryData(key, before);
        toast.error(tr('没能删除列'), errorText(err));
        return false;
      }
    },
  };
}

export type BoardActions = ReturnType<typeof createActions>;

export function useBoardActions(pid: string, boardId: string): BoardActions {
  const qc = useQueryClient();
  const me = useMeUser();
  return useMemo(() => createActions(qc, pid, boardId, me), [qc, pid, boardId, me]);
}

/** 看板本身：新建、重命名、删除 */
export function useBoardListActions(pid: string) {
  const qc = useQueryClient();
  return useMemo(
    () => ({
      async createBoard(name: string): Promise<Board | null> {
        try {
          const board = await api.post<Board>(`/projects/${pid}/boards`, { name });
          qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
            sortBoards(upsertBoard(list ?? [], board)),
          );
          return board;
        } catch (err) {
          toast.error(tr('没能新建看板'), errorText(err));
          return null;
        }
      },
      async renameBoard(board: Board, name: string): Promise<boolean> {
        try {
          const saved = await api.patch<Board>(`/projects/${pid}/boards/${board.id}`, { name });
          qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
            list ? upsertBoard(list, { ...board, ...saved }) : list,
          );
          qc.setQueryData<BoardDetail>(ck.board(pid, board.id), (d) =>
            d ? { ...d, name: saved.name } : d,
          );
          return true;
        } catch (err) {
          toast.error(tr('没能重命名看板'), errorText(err));
          return false;
        }
      },
      async deleteBoard(board: Board): Promise<boolean> {
        try {
          await api.delete(`/projects/${pid}/boards/${board.id}`);
          qc.setQueryData<Board[]>(ck.boards(pid), (list) =>
            list?.filter((b) => b.id !== board.id),
          );
          qc.removeQueries({ queryKey: ck.board(pid, board.id) });
          return true;
        } catch (err) {
          toast.error(tr('没能删除看板'), errorText(err));
          return false;
        }
      },
    }),
    [qc, pid],
  );
}
