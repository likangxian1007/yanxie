import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowDown, ArrowLeft, ChevronDown, FileSearch, ImagePlus, Send } from 'lucide-react';
import {
  TICKET_KIND_LABEL,
  TICKET_PRIORITY_LABEL,
  TICKET_ROADMAP_LABEL,
  TICKET_STATUS_LABEL,
  type TicketDetail,
  type TicketKind,
  type TicketMessage,
  type TicketPriority,
  type TicketRoadmap,
  type TicketStatus,
  type UpdateTicketInput,
} from '@srh/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  IconButton,
  Markdown,
  RelativeTime,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { trServer } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { useAdminUsers } from '@/features/admin/api';
import { markTicketRead, useSendMessage, useTicket, useUpdateTicket } from '../api';
import { AttachmentGallery } from '../components/AttachmentGallery';
import { ImageThumbs } from '../components/ImageThumbs';
import { FEEDBACK_COPY } from '../copy';
import { imagesFromClipboard, useImageList } from '../image-files';
import { KIND_TONE, STATUS_TONE } from '../ticket-meta';

const c = FEEDBACK_COPY.detail;

function options<K extends string>(labels: Record<K, string>) {
  return (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));
}

function Bubble({
  name,
  avatar,
  staff,
  mine,
  at,
  body,
  children,
}: {
  name: string;
  avatar: ReactNode;
  staff: boolean;
  mine: boolean;
  at: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <li className={cn('flex gap-3', mine && 'flex-row-reverse')}>
      <span className="shrink-0 pt-0.5">{avatar}</span>
      <div className={cn('flex min-w-0 max-w-[min(36rem,85%)] flex-col', mine && 'items-end')}>
        <span className="flex items-center gap-2 text-caption text-fg-subtle">
          <span className="font-medium text-fg-muted">{name}</span>
          {staff && <Badge tone="accent">{c.support}</Badge>}
          <RelativeTime iso={at} />
        </span>
        <div
          className={cn(
            'mt-1 rounded-lg px-3 py-2 break-words',
            mine ? 'bg-accent-soft' : 'bg-subtle',
          )}
        >
          {body && <Markdown size="compact">{body}</Markdown>}
          {children}
        </div>
      </div>
    </li>
  );
}

function MessageItem({ m, meId }: { m: TicketMessage; meId: string | undefined }) {
  if (m.isSystem)
    return (
      <li className="text-center text-caption text-fg-subtle">
        {trServer(m.body)} · <RelativeTime iso={m.createdAt} />
      </li>
    );
  const name = m.isStaff ? c.support : (m.author?.name ?? FEEDBACK_COPY.list.anonymous);
  return (
    <Bubble
      name={m.isStaff && m.author ? `${m.author.name}` : name}
      avatar={
        <Avatar
          size={32}
          name={m.author?.name ?? name}
          color={m.author?.avatarColor}
          src={m.author?.avatarUrl}
        />
      }
      staff={m.isStaff}
      mine={!!meId && m.author?.id === meId}
      at={m.createdAt}
      body={m.body}
    >
      <AttachmentGallery items={m.attachments} />
    </Bubble>
  );
}

function ReplyBox({ t }: { t: TicketDetail }) {
  const send = useSendMessage(t.no);
  const [body, setBody] = useState('');
  const imgs = useImageList();
  const fileRef = useRef<HTMLInputElement>(null);
  const ended = t.status === 'done' || t.status === 'closed';

  const submit = () => {
    const text = body.trim();
    if (!text || send.isPending) return;
    send.mutate(
      { body: text, files: imgs.images.map((i) => i.file) },
      {
        onSuccess: () => {
          setBody('');
          imgs.clear();
        },
        onError: (e) => toast.error(c.sendFailed, e instanceof Error ? e.message : undefined),
      },
    );
  };

  return (
    <form
      className="sticky bottom-0 z-10 mt-4 flex flex-col gap-2 border-t border-line bg-canvas pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {ended && <p className="text-caption text-fg-subtle">{c.reopenHint}</p>}
      <ImageThumbs images={imgs.images} onRemove={imgs.remove} />
      <div className="flex items-end gap-2">
        <IconButton
          type="button"
          label={c.attach}
          disabled={imgs.full}
          onClick={() => fileRef.current?.click()}
          className="max-md:size-11"
        >
          <ImagePlus strokeWidth={1.75} aria-hidden />
        </IconButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            imgs.add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <Textarea
          aria-label={c.reply}
          placeholder={c.replyPlaceholder}
          value={body}
          rows={1}
          autoGrow
          wrapperClassName="flex-1"
          onChange={(e) => setBody(e.target.value)}
          onPaste={(e) => {
            const files = imagesFromClipboard(e.clipboardData);
            if (files.length) {
              e.preventDefault();
              imgs.add(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          loading={send.isPending}
          disabled={!body.trim()}
          leftIcon={<Send strokeWidth={1.75} aria-hidden />}
          className="max-md:h-11"
        >
          {c.send}
        </Button>
      </div>
    </form>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <dt className="text-caption text-fg-subtle">{label}</dt>
      <dd className="text-small text-fg">{children}</dd>
    </div>
  );
}

function InfoPanel({ t, isAdmin }: { t: TicketDetail; isAdmin: boolean }) {
  const update = useUpdateTicket(t.no);
  const admins = useAdminUsers('', isAdmin);
  const [diagOpen, setDiagOpen] = useState(false);
  const patch = (p: UpdateTicketInput) =>
    update.mutate(p, {
      onError: (e) => toast.error(c.updateFailed, e instanceof Error ? e.message : undefined),
    });
  const staff = (admins.data ?? []).filter((u) => u.isAdmin);
  const ctx = t.context;
  const diagRows = ctx
    ? (
        [
          [FEEDBACK_COPY.diag.route, ctx.route ?? ctx.url],
          [FEEDBACK_COPY.diag.project, ctx.projectId],
          [FEEDBACK_COPY.diag.thread, ctx.threadId],
          [FEEDBACK_COPY.diag.browser, ctx.userAgent],
          [FEEDBACK_COPY.diag.viewport, ctx.viewport],
          [FEEDBACK_COPY.diag.version, ctx.appVersion],
        ] as [string, string | undefined][]
      ).flatMap(([k, v]) => (v ? [[k, v] as const] : []))
    : [];

  return (
    <aside aria-label={c.info} className="lg:sticky lg:top-4 lg:self-start">
      <h2 className="text-small font-medium text-fg-muted">{c.info}</h2>
      <dl className="mt-1 divide-y divide-line">
        <InfoRow label={c.status}>
          {isAdmin ? (
            <Tabs<TicketStatus>
              variant="segmented"
              size="sm"
              layoutId="ticket-status"
              aria-label={c.status}
              value={t.status}
              onValueChange={(status) => patch({ status })}
              items={options(TICKET_STATUS_LABEL)}
            />
          ) : (
            <span className="flex items-center gap-2">
              <Badge tone={STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Badge>
              {t.mine && t.status !== 'closed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={update.isPending}
                  onClick={() =>
                    update.mutate(
                      { status: 'closed' },
                      {
                        onSuccess: () => toast.success(c.closed),
                        onError: () => toast.error(c.updateFailed),
                      },
                    )
                  }
                >
                  {c.close}
                </Button>
              )}
            </span>
          )}
        </InfoRow>
        {isAdmin ? (
          <>
            <InfoRow label={c.priority}>
              <Select
                size="sm"
                aria-label={c.priority}
                value={t.priority}
                onChange={(e) => patch({ priority: e.target.value as TicketPriority })}
                options={options(TICKET_PRIORITY_LABEL)}
                className="max-md:h-11"
              />
            </InfoRow>
            <InfoRow label={c.assignee}>
              <Select
                size="sm"
                aria-label={c.assignee}
                value={t.assignee?.id ?? ''}
                onChange={(e) => patch({ assigneeUserId: e.target.value || null })}
                options={[
                  { value: '', label: c.unassigned },
                  ...staff.map((u) => ({ value: u.id, label: u.name })),
                  ...(t.assignee && !staff.some((u) => u.id === t.assignee?.id)
                    ? [{ value: t.assignee.id, label: t.assignee.name }]
                    : []),
                ]}
                className="max-md:h-11"
              />
            </InfoRow>
            <InfoRow label={c.kind}>
              <Select
                size="sm"
                aria-label={c.kind}
                value={t.kind}
                onChange={(e) => patch({ kind: e.target.value as TicketKind })}
                options={options(TICKET_KIND_LABEL)}
                className="max-md:h-11"
              />
            </InfoRow>
            <InfoRow label={c.roadmap}>
              <Select
                size="sm"
                aria-label={c.roadmap}
                value={t.roadmap}
                onChange={(e) => patch({ roadmap: e.target.value as TicketRoadmap })}
                options={options(TICKET_ROADMAP_LABEL)}
                className="max-md:h-11"
              />
            </InfoRow>
          </>
        ) : (
          <>
            <InfoRow label={c.priority}>{TICKET_PRIORITY_LABEL[t.priority]}</InfoRow>
            <InfoRow label={c.assignee}>{t.assignee?.name ?? c.unassigned}</InfoRow>
            <InfoRow label={c.kind}>{TICKET_KIND_LABEL[t.kind]}</InfoRow>
            {t.kind === 'idea' && (
              <InfoRow label={c.roadmap}>{TICKET_ROADMAP_LABEL[t.roadmap]}</InfoRow>
            )}
          </>
        )}
        <InfoRow label={c.project}>
          {t.projectId ? (
            <Link to={`/p/${t.projectId}`} className="text-accent-text hover:underline">
              {t.projectId}
            </Link>
          ) : (
            <span className="text-fg-subtle">{c.noProject}</span>
          )}
        </InfoRow>
        <InfoRow label={c.reporter}>
          {t.reporter?.name ?? FEEDBACK_COPY.list.anonymous}
          <span className="text-fg-subtle">
            {' '}
            · {c.created} <RelativeTime iso={t.createdAt} />
          </span>
        </InfoRow>
        {t.opsEventId && <InfoRow label={c.opsEvent}>{t.opsEventId}</InfoRow>}
        {(diagRows.length > 0 || t.hiddenLogCount > 0 || (ctx?.recentErrors?.length ?? 0) > 0) && (
          <div className="py-2.5">
            <button
              type="button"
              aria-expanded={diagOpen}
              onClick={() => setDiagOpen(!diagOpen)}
              className="flex w-full cursor-pointer items-center justify-between text-caption text-fg-subtle hover:text-fg max-md:min-h-11"
            >
              {c.diagnostics}
              <ChevronDown
                size={16}
                strokeWidth={1.75}
                aria-hidden
                className={cn(
                  'transition-transform duration-(--dur-fast)',
                  diagOpen && 'rotate-180',
                )}
              />
            </button>
            {diagOpen && (
              <div className="mt-2 flex flex-col gap-2 text-caption">
                <dl className="grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1">
                  {diagRows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-fg-subtle">{k}</dt>
                      <dd className="font-mono break-all text-fg-muted">{v}</dd>
                    </div>
                  ))}
                </dl>
                {(ctx?.recentErrors?.length ?? 0) > 0 && (
                  <pre className="max-h-40 overflow-auto rounded-md bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-muted">
                    {ctx?.recentErrors?.join('\n')}
                  </pre>
                )}
                {t.hiddenLogCount > 0 && (
                  <p className="text-fg-subtle">{c.hiddenLogs(t.hiddenLogCount)}</p>
                )}
              </div>
            )}
          </div>
        )}
      </dl>
    </aside>
  );
}

function Thread({ t, meId }: { t: TicketDetail; meId: string | undefined }) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = t.messages.length;
  const seen = useRef(count);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (count <= seen.current) return;
    seen.current = count;
    const last = t.messages[count - 1];
    const el = endRef.current;
    if (!el) return;
    const near = el.getBoundingClientRect().top < window.innerHeight + 160;
    if (near || last?.author?.id === meId) el.scrollIntoView({ block: 'end' });
    else setFresh(true);
  }, [count, t.messages, meId]);

  const lastMine = [...t.messages].reverse().find((m) => !m.isSystem && m.author?.id === meId);
  const peerRead = lastMine && t.peerReadAt && t.peerReadAt >= lastMine.createdAt;

  return (
    <>
      <ol className="flex flex-col gap-5">
        <Bubble
          name={t.reporter?.name ?? FEEDBACK_COPY.list.anonymous}
          avatar={
            <Avatar
              size={32}
              name={t.reporter?.name ?? '?'}
              color={t.reporter?.avatarColor}
              src={t.reporter?.avatarUrl}
            />
          }
          staff={false}
          mine={!!meId && t.reporter?.id === meId}
          at={t.createdAt}
          body={t.body}
        >
          <AttachmentGallery items={t.attachments} />
        </Bubble>
        {t.messages.map((m) => (
          <MessageItem key={m.id} m={m} meId={meId} />
        ))}
      </ol>
      {lastMine && (
        <p className="mt-2 text-right text-caption text-fg-subtle">
          {peerRead ? c.read : c.delivered}
        </p>
      )}
      <div ref={endRef} />
      {fresh && (
        <button
          type="button"
          onClick={() => {
            setFresh(false);
            endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
          }}
          className="fixed bottom-28 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-accent-solid px-3 text-small text-accent-fg shadow-lg max-md:h-11"
        >
          <ArrowDown size={16} strokeWidth={1.75} aria-hidden />
          {c.newMessages}
        </button>
      )}
    </>
  );
}

export function TicketDetailPage() {
  const { no = '' } = useParams();
  const query = useTicket(no);
  const me = useMe().data?.user;
  const isAdmin = me?.isAdmin === true;
  const t = query.data;
  const lastAt = t?.messages.at(-1)?.createdAt ?? t?.createdAt;

  // 打开时、以及有新消息时标记已读
  useEffect(() => {
    if (!lastAt) return;
    void markTicketRead(no).catch(() => undefined);
  }, [no, lastAt]);

  const back = (
    <Link
      to="/feedback"
      className="inline-flex items-center gap-1 text-small text-fg-muted hover:text-fg max-md:min-h-11"
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      {c.back}
    </Link>
  );

  if (query.isPending)
    return (
      <Page width="full" className="max-w-6xl">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="mt-6 h-40 w-full" />
      </Page>
    );

  if (!t) {
    const notFound =
      query.error instanceof ApiRequestError &&
      (query.error.status === 404 || query.error.status === 403);
    return (
      <Page width="full" className="max-w-6xl">
        <div className="mb-4">{back}</div>
        <EmptyState
          framed
          icon={FileSearch}
          title={notFound ? c.notFound : c.loadFailed}
          description={notFound ? c.notFoundHint : undefined}
          action={
            notFound ? undefined : (
              <Button onClick={() => void query.refetch()}>{FEEDBACK_COPY.list.retry}</Button>
            )
          }
        />
      </Page>
    );
  }

  return (
    <Page width="full" className="max-w-6xl">
      <PageHeader eyebrow={back} title={`${t.code} ${t.title}`} />
      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONE[t.kind]}>{FEEDBACK_COPY.kindShort[t.kind]}</Badge>
        <Badge tone={STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Badge>
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-label={c.reply} className="min-w-0">
          <Thread t={t} meId={me?.id} />
          <ReplyBox t={t} />
        </section>
        <InfoPanel t={t} isAdmin={isAdmin} />
      </div>
    </Page>
  );
}
