import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Inbox, KanbanSquare, List, Plus, RotateCw, Search } from 'lucide-react';
import { TICKET_STATUS_LABEL, type TicketStatus } from '@srh/shared';
import { Button, EmptyState, Input, Select, Skeleton, Tabs } from '@/components/ui';
import { useIsMobile } from '@/lib/use-media-query';
import { useTickets } from '../api';
import { FEEDBACK_COPY } from '../copy';
import { openFeedbackDialog } from '../feedback-store';
import { parseTicketFilters, sortTickets, ticketQuery, type TicketScope } from '../ticket-meta';
import { TicketBoard } from './TicketBoard';
import { TicketRow } from './TicketRow';

const c = FEEDBACK_COPY.list;

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable
  );
}

export function TicketsTab({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams();
  const mobile = useIsMobile();
  const filters = parseTicketFilters(params, isAdmin);
  const view = mobile ? 'list' : filters.view;
  const [q, setQ] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const query = useTickets(ticketQuery({ ...filters, view }));
  // 「已等 X」以数据拉取时刻为准，随轮询刷新
  const now = query.dataUpdatedAt;

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // 输入停顿 300ms 再写进 URL
  useEffect(() => {
    if (q === filters.q) return;
    const id = window.setTimeout(() => set('q', q.trim()), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // 「/」聚焦搜索，「n」提交新反馈
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'n') {
        e.preventDefault();
        openFeedbackDialog();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tickets = useMemo(
    () => sortTickets(query.data ?? [], isAdmin, now),
    [query.data, isAdmin, now],
  );
  const waitingCount = (query.data ?? []).filter((t) => t.waiting).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Input
          ref={searchRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={c.search}
          aria-label={c.search}
          leading={<Search strokeWidth={1.75} aria-hidden />}
          trailing={<kbd className="text-caption text-fg-subtle max-md:hidden">/</kbd>}
          wrapperClassName="md:max-w-80 md:flex-1"
          className="max-md:h-11"
        />
        <Tabs<TicketScope>
          variant="segmented"
          size="sm"
          layoutId="ticket-scope"
          aria-label={c.status}
          value={filters.scope}
          onValueChange={(v) => set('scope', v === 'all' ? '' : v)}
          items={[
            { value: 'all', label: c.scope.all },
            { value: 'waiting', label: c.scope.waiting, count: waitingCount || undefined },
            { value: 'mine', label: c.scope.mine },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {isAdmin && (
            <>
              {view === 'list' && (
                <Select
                  size="sm"
                  aria-label={c.status}
                  value={filters.status}
                  onChange={(e) => set('status', e.target.value)}
                  options={[
                    { value: '', label: c.anyStatus },
                    ...(Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]).map((s) => ({
                      value: s,
                      label: TICKET_STATUS_LABEL[s],
                    })),
                  ]}
                  wrapperClassName="w-auto"
                  className="max-md:h-11"
                />
              )}
              <Select
                size="sm"
                aria-label={c.assignee}
                value={filters.assignee}
                onChange={(e) => set('assignee', e.target.value)}
                options={[
                  { value: '', label: c.anyAssignee },
                  { value: 'me', label: c.assigneeMe },
                  { value: 'none', label: c.assigneeNone },
                ]}
                wrapperClassName="w-auto"
                className="max-md:h-11"
              />
              {!mobile && (
                <Tabs<'list' | 'board'>
                  variant="segmented"
                  size="sm"
                  layoutId="ticket-view"
                  aria-label={c.viewList}
                  value={view}
                  onValueChange={(v) => set('view', v === 'list' ? '' : v)}
                  items={[
                    {
                      value: 'list',
                      label: c.viewList,
                      icon: <List size={16} strokeWidth={1.75} aria-hidden />,
                    },
                    {
                      value: 'board',
                      label: c.viewBoard,
                      icon: <KanbanSquare size={16} strokeWidth={1.75} aria-hidden />,
                    },
                  ]}
                />
              )}
            </>
          )}
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            onClick={openFeedbackDialog}
            className="max-md:h-11"
          >
            {c.create}
          </Button>
        </div>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : query.isError && !query.data ? (
        <EmptyState
          icon={Inbox}
          title={c.loadFailed}
          action={
            <Button
              leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
              onClick={() => void query.refetch()}
            >
              {c.retry}
            </Button>
          }
        />
      ) : view === 'board' ? (
        <TicketBoard tickets={tickets} now={now} />
      ) : tickets.length === 0 ? (
        <EmptyState framed icon={Inbox} title={c.empty} description={c.emptyHint} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {tickets.map((t) => (
            <TicketRow key={t.id} ticket={t} isAdmin={isAdmin} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
