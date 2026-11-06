import { useListQueryState } from '@/lib/list-state';
import { useEffect, useEffectEvent, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Columns3 } from 'lucide-react';
import type { Board } from '@srh/shared';
import { EmptyState, toast } from '@/components/ui';
import { useMeUser } from '@/lib/session';
import { ck } from '@/features/collab-kit/keys';
import { fetchBoard, useBoard, useBoardActions } from '../data';
import { collectLabels, filterCards, type CardFilter } from '../lib/filter';
import { BoardCanvas } from './BoardCanvas';
import { BoardFilterBar } from './BoardFilterBar';
import { BoardSkeleton, LoadError } from './BoardStates';
import { CardDetailSheet } from './CardDetailSheet';
import { tr } from '@/lib/i18n';

export interface BoardViewProps {
  pid: string;
  board: Board;
  boards: Board[];
  writable: boolean;
  /** URL 里的 ?card= */
  cardId: string | null;
  onOpenCard: (cardId: string) => void;
  onCloseCard: () => void;
  /** ?card= 指向别的看板时切过去 */
  onSwitchBoard: (boardId: string, cardId: string) => void;
}

/** 一个看板：筛选条 + 列与卡片 + 卡片详情 */
export function BoardView({
  pid,
  board,
  boards,
  writable,
  cardId,
  onOpenCard,
  onCloseCard,
  onSwitchBoard,
}: BoardViewProps) {
  const qc = useQueryClient();
  const me = useMeUser();
  const query = useBoard(pid, board.id);
  const actions = useBoardActions(pid, board.id);
  const [queryFilter, setQueryFilter] = useListQueryState('q', '');
  const [assignee, setAssignee] = useListQueryState('assignee', '');
  const [label, setLabel] = useListQueryState('label', '');
  const filter = useMemo<CardFilter>(
    () => ({ query: queryFilter, assignee, label }),
    [queryFilter, assignee, label],
  );
  const setFilter = (next: CardFilter) => {
    setQueryFilter(next.query);
    setAssignee(next.assignee);
    setLabel(next.label);
  };
  const detail = query.data;

  const labels = useMemo(() => collectLabels(detail?.cards ?? []), [detail?.cards]);
  const shown = useMemo(
    () => filterCards(detail?.cards ?? [], filter, me?.id ?? null).length,
    [detail?.cards, filter, me?.id],
  );
  const openCard = detail && cardId ? detail.cards.find((c) => c.id === cardId) : undefined;
  const loaded = Boolean(detail);
  const otherBoardIds = boards
    .filter((b) => b.id !== board.id)
    .map((b) => b.id)
    .join(',');

  // ?card= 不在当前看板：到其他看板里找；都没有就提示并清掉参数
  const locate = useEffectEvent(async (target: string, isCancelled: () => boolean) => {
    for (const id of otherBoardIds ? otherBoardIds.split(',') : []) {
      try {
        const other = await qc.fetchQuery({
          queryKey: ck.board(pid, id),
          queryFn: () => fetchBoard(pid, id),
          staleTime: 30_000,
        });
        if (isCancelled()) return;
        if (other.cards.some((c) => c.id === target)) {
          onSwitchBoard(id, target);
          return;
        }
      } catch {
        // 这个看板读不到就跳过
      }
    }
    if (isCancelled()) return;
    toast({
      title: tr('没有找到这张卡片'),
      description: tr('它可能已被删除或移走。'),
      tone: 'warning',
    });
    onCloseCard();
  });

  const missing = Boolean(cardId) && loaded && !openCard;
  useEffect(() => {
    if (!missing || !cardId) return;
    let cancelled = false;
    void locate(cardId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [missing, cardId]);

  if (query.isLoading) return <BoardSkeleton />;
  if (query.isError || !detail) {
    return (
      <LoadError
        title={tr('看板没能加载')}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <>
      <BoardFilterBar
        pid={pid}
        filter={filter}
        onChange={setFilter}
        labels={labels}
        shown={shown}
        total={detail.cards.length}
      />
      {detail.columns.length === 0 && (
        <EmptyState
          icon={Columns3}
          title={tr('这个看板还没有列')}
          description={
            writable
              ? tr('先添加几列，比如“想法 / 进行中 / 完成”，再把任务拆成卡片放进去。')
              : tr('有编辑权限的成员添加列之后，卡片会出现在这里。')
          }
          className="py-8"
        />
      )}
      <BoardCanvas
        detail={detail}
        writable={writable}
        filter={filter}
        meId={me?.id ?? null}
        actions={actions}
        onOpenCard={onOpenCard}
      />
      <CardDetailSheet
        pid={pid}
        card={openCard}
        columns={detail.columns}
        allCards={detail.cards}
        labelSuggestions={labels}
        writable={writable}
        actions={actions}
        onClose={onCloseCard}
      />
    </>
  );
}
