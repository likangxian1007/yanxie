import { useListStateScope } from '@/lib/list-state';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { MoreHorizontal, Pencil, Plus, SquareKanban, Trash2 } from 'lucide-react';
import { Button, Dialog, EmptyState, IconButton, Menu, MenuItem, Tabs } from '@/components/ui';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useBoardListActions, useBoardRealtime, useBoards } from '../data';
import { BoardNameDialog } from '../components/BoardDialogs';
import { BoardSkeleton, LoadError } from '../components/BoardStates';
import { BoardView } from '../components/BoardView';
import { tr, trServer } from '@/lib/i18n';

/** 科研看板：多个看板用 Tabs 切换（?board=），?card= 打开卡片详情。 */
export function BoardPage() {
  const pid = useProjectId();
  useListStateScope('board');
  const writable = canWrite(useMyRole(pid));
  const [params, setParams] = useSearchParams();
  const boardsQuery = useBoards(pid);
  const listActions = useBoardListActions(pid);
  useBoardRealtime(pid);

  const [nameDialog, setNameDialog] = useState<'create' | 'rename' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const boards = boardsQuery.data ?? [];
  const current = boards.find((b) => b.id === params.get('board')) ?? boards[0];
  const cardId = params.get('card');

  const update = (fn: (next: URLSearchParams) => void, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        fn(next);
        return next;
      },
      { replace },
    );

  const selectBoard = (id: string) =>
    update((p) => {
      p.set('board', id);
      p.delete('card');
    });

  const newBoardButton = writable ? (
    <Button
      variant="primary"
      leftIcon={<Plus strokeWidth={2} aria-hidden />}
      onClick={() => setNameDialog('create')}
    >
      {tr('新建看板')}
    </Button>
  ) : undefined;

  let body;
  if (boardsQuery.isLoading) {
    body = <BoardSkeleton />;
  } else if (boardsQuery.isError) {
    body = (
      <LoadError
        title={tr('看板没能加载')}
        error={boardsQuery.error}
        onRetry={() => void boardsQuery.refetch()}
      />
    );
  } else if (!current) {
    body = (
      <EmptyState
        framed
        icon={SquareKanban}
        title={tr('还没有看板')}
        description={
          writable
            ? tr('新建一个看板，把任务拆成卡片，拖动即可更新进度；协调者也会把拆出的工作放进来。')
            : tr('项目成员建好看板后会显示在这里。')
        }
        action={newBoardButton}
      />
    );
  } else {
    body = (
      <>
        <div className="mb-4 flex min-w-0 items-center gap-2">
          {boards.length > 1 ? (
            <Tabs
              className="min-w-0 flex-1"
              layoutId="board-tabs"
              aria-label={tr('切换看板')}
              value={current.id}
              onValueChange={selectBoard}
              items={boards.map((b) => ({ value: b.id, label: trServer(b.name) }))}
            />
          ) : (
            <h2 className="min-w-0 flex-1 truncate text-h3 text-fg">{trServer(current.name)}</h2>
          )}
          {writable && (
            <Menu
              align="end"
              label={tr('看板操作')}
              trigger={
                <IconButton label={tr('看板操作')}>
                  <MoreHorizontal strokeWidth={1.75} aria-hidden />
                </IconButton>
              }
            >
              <MenuItem
                icon={<Pencil strokeWidth={1.75} />}
                onSelect={() => setNameDialog('rename')}
              >
                {tr('重命名看板')}
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 strokeWidth={1.75} />}
                disabled={boards.length <= 1}
                description={boards.length <= 1 ? tr('项目至少保留一个看板') : undefined}
                onSelect={() => setConfirmDelete(true)}
              >
                {tr('删除看板')}
              </MenuItem>
            </Menu>
          )}
        </div>
        <BoardView
          key={current.id}
          pid={pid}
          board={current}
          boards={boards}
          writable={writable}
          cardId={cardId}
          onOpenCard={(id) => update((p) => p.set('card', id))}
          onCloseCard={() => update((p) => p.delete('card'), true)}
          onSwitchBoard={(boardId, card) =>
            update((p) => {
              p.set('board', boardId);
              p.set('card', card);
            }, true)
          }
        />
      </>
    );
  }

  return (
    <Page width="full" className="min-w-0">
      <PageTitle>{tr('看板')}</PageTitle>
      <PageActions>{newBoardButton}</PageActions>
      {body}

      <BoardNameDialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        mode={nameDialog ?? 'create'}
        initialName={nameDialog === 'rename' ? (current?.name ?? '') : ''}
        onSubmit={async (name) => {
          if (nameDialog === 'rename') {
            return current ? listActions.renameBoard(current, name) : false;
          }
          const board = await listActions.createBoard(name);
          if (board) selectBoard(board.id);
          return Boolean(board);
        }}
      />

      <Dialog
        open={confirmDelete && Boolean(current)}
        onOpenChange={setConfirmDelete}
        title={tr('删除看板「{value}」', { value: trServer(current?.name ?? '') })}
        description={tr('看板里的列和卡片会一起删除，不能恢复。关联的线程和实验不受影响。')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tr('取消')}
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              onClick={async () => {
                if (!current) return;
                setDeleting(true);
                const ok = await listActions.deleteBoard(current);
                setDeleting(false);
                if (ok) {
                  setConfirmDelete(false);
                  update((p) => {
                    p.delete('board');
                    p.delete('card');
                  }, true);
                }
              }}
            >
              {tr('删除看板')}
            </Button>
          </>
        }
      />
    </Page>
  );
}
