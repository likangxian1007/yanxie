import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { TicketStatus, TicketSummary } from '@srh/shared';
import { Badge, RelativeTime, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMoveTicket } from '../api';
import { FEEDBACK_COPY } from '../copy';
import { KIND_TONE, waitedMs, waitHeat } from '../ticket-meta';

const c = FEEDBACK_COPY.board;

function CardBody({ t, now }: { t: TicketSummary; now: number }) {
  const heat = t.waiting ? waitHeat(waitedMs(t, now)) : 'none';
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="font-mono text-caption text-fg-subtle tabular-nums">{t.code}</span>
        <Badge tone={KIND_TONE[t.kind]}>{FEEDBACK_COPY.kindShort[t.kind]}</Badge>
        {t.waiting && (
          <Badge tone={heat === 'hot' ? 'danger' : 'warning'} dot>
            {FEEDBACK_COPY.list.waitingYou}
          </Badge>
        )}
      </span>
      <span className="mt-1.5 line-clamp-2 block text-small text-fg">{t.title}</span>
      <span className="mt-1.5 flex items-center gap-1.5 text-caption text-fg-subtle">
        <span className="truncate">{t.reporter?.name ?? FEEDBACK_COPY.list.anonymous}</span>
        <span aria-hidden>·</span>
        <RelativeTime iso={t.updatedAt} />
      </span>
    </>
  );
}

function DraggableCard({ t, now, active }: { t: TicketSummary; now: number; active: boolean }) {
  const { setNodeRef, attributes, listeners } = useDraggable({ id: String(t.no) });
  return (
    <li ref={setNodeRef} {...attributes} {...listeners} className="touch-none">
      <Link
        to={`/feedback/${t.no}`}
        draggable={false}
        className={cn(
          'block rounded-lg border border-line bg-surface p-3 hover:border-line-strong',
          active && 'opacity-40',
          t.unread && 'border-l-2 border-l-accent-solid',
        )}
      >
        <CardBody t={t} now={now} />
      </Link>
    </li>
  );
}

function Column({
  status,
  label,
  tickets,
  now,
  activeNo,
}: {
  status: TicketStatus;
  label: string;
  tickets: TicketSummary[];
  now: number;
  activeNo: number | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        'flex min-h-60 min-w-0 flex-col rounded-lg bg-subtle p-2 transition-colors duration-(--dur-fast)',
        isOver && 'bg-accent-soft',
      )}
    >
      <header className="flex items-center justify-between px-1.5 pt-1 pb-2">
        <h2 className="text-small font-medium text-fg">{label}</h2>
        <span className="text-caption text-fg-subtle tabular-nums">{c.count(tickets.length)}</span>
      </header>
      {tickets.length === 0 ? (
        <p className="px-1.5 py-6 text-center text-caption text-fg-subtle">{c.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.map((t) => (
            <DraggableCard key={t.id} t={t} now={now} active={activeNo === t.no} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 管理员看板：四列对应四个状态，拖动卡片改状态（乐观更新，失败回滚）。 */
export function TicketBoard({ tickets, now }: { tickets: TicketSummary[]; now: number }) {
  const move = useMoveTicket();
  const [activeNo, setActiveNo] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const active = tickets.find((t) => t.no === activeNo);

  const onStart = (e: DragStartEvent) => setActiveNo(Number(e.active.id));
  const onEnd = (e: DragEndEvent) => {
    setActiveNo(null);
    const no = Number(e.active.id);
    const status = e.over?.id as TicketStatus | undefined;
    const t = tickets.find((x) => x.no === no);
    if (!t || !status || t.status === status) return;
    const label = c.columns.find((col) => col.status === status)?.label ?? status;
    move.mutate(
      { no, status },
      {
        onSuccess: () => toast({ title: c.moved(t.code, label), tone: 'success' }),
        onError: () => toast.error(c.moveFailed),
      },
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setActiveNo(null)}
    >
      <p className="mb-3 text-small text-fg-subtle">{c.hint(tickets.length)}</p>
      <div className="grid grid-cols-4 gap-3">
        {c.columns.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            label={col.label}
            now={now}
            activeNo={activeNo}
            tickets={tickets.filter((t) => t.status === col.status)}
          />
        ))}
      </div>
      {createPortal(
        <DragOverlay>
          {active && (
            <div className="rounded-lg border border-line-strong bg-elevated p-3 shadow-md">
              <CardBody t={active} now={now} />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
