import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Activity,
  ChevronDown,
  ExternalLink,
  KanbanSquare,
  Megaphone,
  RotateCw,
  Search,
  ShieldOff,
  Ticket,
  Trash2,
} from 'lucide-react';
import type { AdminOverview, OpsEvent, OpsLevel, OpsSource } from '@srh/shared';
import { Page, PageHeader } from '@/components/layout/Page';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Input,
  RelativeTime,
  Select,
  Skeleton,
  Switch,
  Tabs,
  toast,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe } from '@/lib/session';
import {
  useAdminOverview,
  useAdminProjects,
  useAdminUsers,
  useDeleteOpsEvent,
  useOpsEvents,
  useOpsToTicket,
  useSetAdmin,
} from '../api';
import { ADMIN_COPY } from '../copy';
import { locale, tr } from '@/lib/i18n';

type AdminTab = 'overview' | 'users' | 'projects' | 'tickets' | 'ops' | 'changelog';
const TABS = Object.keys(ADMIN_COPY.tabs) as AdminTab[];

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return tr('{d} 天 {h} 小时', { d, h });
  if (h > 0) return tr('{h} 小时 {m} 分', { h, m });
  return tr('{m} 分钟', { m });
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString(locale());
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={Activity}
      title={ADMIN_COPY.loadFailed}
      action={
        <Button leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />} onClick={onRetry}>
          {ADMIN_COPY.retry}
        </Button>
      }
    />
  );
}

// ---------------------------------------------------------------- 概览

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-caption text-fg-subtle">{label}</div>
      <div className="mt-1 text-h2 text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-caption text-fg-subtle">{hint}</div>}
    </div>
  );
}

/** 简单的占用条（不引图表库）。 */
function Bar({
  label,
  used,
  total,
  detail,
}: {
  label: string;
  used: number;
  total: number;
  detail: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'bg-danger-solid' : pct >= 75 ? 'bg-warning-solid' : 'bg-accent-solid';
  return (
    <div>
      <div className="flex items-baseline justify-between text-small">
        <span className="text-fg-muted">{label}</span>
        <span className="text-caption text-fg-subtle tabular-nums">
          {detail} · {pct}%
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={cn('h-full origin-left rounded-full', tone)}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-small font-medium text-fg">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-small">
      <span className="text-fg-subtle">{k}</span>
      <span className="min-w-0 truncate text-right text-fg tabular-nums">{v}</span>
    </div>
  );
}

function OverviewTab() {
  const q = useAdminOverview();
  const o = ADMIN_COPY.overview;
  if (q.isPending)
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  if (!q.data) return <LoadFailed onRetry={() => void q.refetch()} />;
  const d: AdminOverview = q.data;
  const s = d.server;
  const failRate = (w: { turns: number; failures: number }) =>
    w.turns > 0 ? `${Math.round((w.failures / w.turns) * 100)}%` : '0%';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption text-fg-subtle">{o.refreshed}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label={o.users} value={formatCount(d.counts.users)} />
        <Stat label={o.activeUsers} value={formatCount(d.counts.activeUsers7d)} />
        <Stat label={o.projects} value={formatCount(d.counts.projects)} />
        <Stat label={o.ticketsOpen} value={d.counts.ticketsOpen} />
        <Stat label={o.ticketsDoing} value={d.counts.ticketsDoing} />
        <Stat label={o.opsEvents} value={d.counts.opsEvents24h} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Section title={o.server}>
          <KV k={o.version} v={s.version} />
          <KV k={o.uptime} v={formatUptime(s.uptimeSec)} />
          <KV k={o.node} v={s.nodeVersion} />
          <KV k={o.platform} v={s.platform} />
          <KV k={o.cpu} v={tr('{cpus} 核', { cpus: s.cpus })} />
          <KV k={o.load} v={s.loadavg.map((n) => n.toFixed(2)).join(' / ')} />
        </Section>
        <Section title={o.memory}>
          <Bar
            label={o.memory}
            used={s.totalmem - s.freemem}
            total={s.totalmem}
            detail={`${formatBytes(s.totalmem - s.freemem)} / ${formatBytes(s.totalmem)}`}
          />
          <Bar
            label={o.heap}
            used={s.memory.heapUsed}
            total={s.memory.heapTotal}
            detail={`${formatBytes(s.memory.heapUsed)} / ${formatBytes(s.memory.heapTotal)}`}
          />
          {d.disk && (
            <Bar
              label={o.disk}
              used={d.disk.totalBytes - d.disk.freeBytes}
              total={d.disk.totalBytes}
              detail={`${formatBytes(d.disk.totalBytes - d.disk.freeBytes)} / ${formatBytes(d.disk.totalBytes)}`}
            />
          )}
        </Section>
        <Section title={`${o.db} · ${o.llm}`}>
          <KV
            k={o.db}
            v={
              <Badge tone={d.db.ok ? 'success' : 'danger'} dot>
                {d.db.driver} · {d.db.ok ? o.dbOk : o.dbDown}
              </Badge>
            }
          />
          <KV k={o.latency} v={d.db.latencyMs == null ? '—' : `${d.db.latencyMs} ms`} />
          <KV k={o.dbSize} v={formatBytes(d.db.sizeBytes)} />
          <KV
            k={o.llm}
            v={
              <Badge tone={d.llm.configured ? 'success' : 'warning'}>
                {d.llm.configured ? d.llm.defaultModel : o.llmOff}
              </Badge>
            }
          />
        </Section>
      </div>
      <Section title={o.agents}>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              [o.last24h, d.agents.last24h],
              [o.last7d, d.agents.last7d],
            ] as const
          ).map(([label, w]) => (
            <div key={label} className="flex flex-col gap-2">
              <span className="text-caption text-fg-subtle">{label}</span>
              <KV k={o.turns} v={formatCount(w.turns)} />
              <KV k={o.failures} v={`${w.failures} · ${failRate(w)}`} />
              <KV k={o.tokens} v={formatCount(w.tokens)} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- 用户

function UsersTab() {
  const [q, setQ] = useState('');
  const users = useAdminUsers(q.trim());
  const setAdmin = useSetAdmin();
  const meId = useMe().data?.user.id;
  const u = ADMIN_COPY.users;
  return (
    <div className="flex flex-col gap-4">
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={u.search}
        aria-label={u.search}
        leading={<Search strokeWidth={1.75} aria-hidden />}
        wrapperClassName="md:max-w-80"
        className="max-md:h-11"
      />
      {users.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !users.data ? (
        <LoadFailed onRetry={() => void users.refetch()} />
      ) : users.data.length === 0 ? (
        <EmptyState framed icon={Search} title={u.empty} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {users.data.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-3">
              <Avatar size={32} name={row.name} color={row.avatarColor} src={row.avatarUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body text-fg">{row.name}</span>
                  {row.isAdmin && <Badge tone="accent">{u.admin}</Badge>}
                </div>
                <div className="truncate text-small text-fg-subtle">
                  {row.email} · {u.projects} {row.projectCount} · {u.tickets} {row.ticketCount} ·{' '}
                  {u.lastLogin} {row.lastLoginAt ? <RelativeTime iso={row.lastLoginAt} /> : u.never}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {row.adminByConfig && (
                  <span className="text-caption text-fg-subtle max-sm:hidden">{u.byConfig}</span>
                )}
                <Switch
                  label={tr('{label}：{name}', { label: u.admin, name: row.name })}
                  checked={row.isAdmin}
                  disabled={row.adminByConfig || row.id === meId || setAdmin.isPending}
                  onCheckedChange={(isAdmin) =>
                    setAdmin.mutate(
                      { id: row.id, isAdmin },
                      {
                        onSuccess: () =>
                          toast.success(isAdmin ? u.granted(row.name) : u.revoked(row.name)),
                        onError: (e) =>
                          toast.error(u.toggleFailed, e instanceof Error ? e.message : undefined),
                      },
                    )
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 课题

function ProjectsTab() {
  const projects = useAdminProjects();
  const [q, setQ] = useState('');
  const p = ADMIN_COPY.projects;
  const list = (projects.data ?? []).filter((x) =>
    x.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-4">
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={p.search}
        aria-label={p.search}
        leading={<Search strokeWidth={1.75} aria-hidden />}
        wrapperClassName="md:max-w-80"
        className="max-md:h-11"
      />
      {projects.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !projects.data ? (
        <LoadFailed onRetry={() => void projects.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState framed icon={Search} title={p.empty} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-3">
              <span aria-hidden className="text-h3">
                {row.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/p/${row.id}`}
                    className="truncate text-body text-fg hover:text-accent-text"
                  >
                    {row.name}
                  </Link>
                  {row.archived && <Badge tone="neutral">{p.archived}</Badge>}
                </div>
                <div className="truncate text-small text-fg-subtle tabular-nums">
                  {p.members} {row.memberCount} · {p.threads} {row.threadCount} · {p.tokens}{' '}
                  {formatCount(row.tokens.input + row.tokens.output)}
                  {row.lastActivityAt && (
                    <>
                      {' '}
                      · {p.lastActivity} <RelativeTime iso={row.lastActivityAt} />
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 运维事件

const LEVEL_TONE: Record<OpsLevel, 'danger' | 'warning' | 'neutral'> = {
  error: 'danger',
  warn: 'warning',
  info: 'neutral',
};

function OpsRow({ e }: { e: OpsEvent }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteOpsEvent();
  const convert = useOpsToTicket();
  const o = ADMIN_COPY.ops;
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={o.detail}
          onClick={() => setOpen(!open)}
          className="mt-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-subtle hover:bg-subtle max-md:size-11"
        >
          <ChevronDown
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className={cn('transition-transform duration-(--dur-fast)', open && 'rotate-180')}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={LEVEL_TONE[e.level]}>{o.levelLabel[e.level]}</Badge>
            <Badge tone="neutral">{o.sourceLabel[e.source]}</Badge>
            <span className="text-caption text-fg-subtle tabular-nums">{o.count(e.count)}</span>
          </div>
          <p className="mt-1 line-clamp-2 font-mono text-small break-all text-fg">{e.message}</p>
          <p className="mt-0.5 text-caption text-fg-subtle">
            {o.firstAt} <RelativeTime iso={e.firstAt} /> · {o.lastAt}{' '}
            <RelativeTime iso={e.lastAt} />
          </p>
          {open && (
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-subtle p-3 font-mono text-caption whitespace-pre-wrap break-all text-fg-muted">
              {typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}
            </pre>
          )}
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
          {e.ticketNo ? (
            <Link
              to={`/feedback/${e.ticketNo}`}
              className="inline-flex h-8 items-center px-2 text-small text-accent-text hover:underline max-md:h-11"
            >
              YX-{e.ticketNo}
            </Link>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              loading={convert.isPending}
              leftIcon={<Ticket strokeWidth={1.75} aria-hidden />}
              className="max-md:h-11"
              onClick={() =>
                convert.mutate(e.id, {
                  onSuccess: (t) => toast.success(o.converted(t.code)),
                  onError: (err) => {
                    const no =
                      err instanceof ApiRequestError && err.status === 409
                        ? (err.details as { ticketNo?: number } | undefined)?.ticketNo
                        : undefined;
                    if (no) toast({ title: `${o.already} YX-${no}`, tone: 'info' });
                    else toast.error(o.convertFailed);
                  },
                })
              }
            >
              {o.toTicket}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            loading={del.isPending}
            leftIcon={<Trash2 strokeWidth={1.75} aria-hidden />}
            className="max-md:h-11"
            onClick={() =>
              del.mutate(e.id, {
                onSuccess: () => toast.success(o.cleared),
                onError: () => toast.error(o.clearFailed),
              })
            }
          >
            {o.clear}
          </Button>
        </span>
      </div>
    </li>
  );
}

function OpsTab() {
  const o = ADMIN_COPY.ops;
  const [level, setLevel] = useState<OpsLevel | ''>('');
  const [source, setSource] = useState<OpsSource | ''>('');
  const [q, setQ] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const events = useOpsEvents({
    level: level || undefined,
    source: source || undefined,
    q: q.trim(),
    open: openOnly,
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={o.search}
          aria-label={o.search}
          leading={<Search strokeWidth={1.75} aria-hidden />}
          wrapperClassName="md:max-w-72 md:flex-1"
          className="max-md:h-11"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            aria-label={o.level}
            value={level}
            onChange={(e) => setLevel(e.target.value as OpsLevel | '')}
            options={[
              { value: '', label: o.anyLevel },
              ...(Object.keys(o.levelLabel) as OpsLevel[]).map((v) => ({
                value: v,
                label: o.levelLabel[v],
              })),
            ]}
            wrapperClassName="w-auto"
            className="max-md:h-11"
          />
          <Select
            size="sm"
            aria-label={o.source}
            value={source}
            onChange={(e) => setSource(e.target.value as OpsSource | '')}
            options={[
              { value: '', label: o.anySource },
              ...(Object.keys(o.sourceLabel) as OpsSource[]).map((v) => ({
                value: v,
                label: o.sourceLabel[v],
              })),
            ]}
            wrapperClassName="w-auto"
            className="max-md:h-11"
          />
          <Switch label={o.openOnly} checked={openOnly} onCheckedChange={setOpenOnly} />
          <span className="text-small text-fg-muted">{o.openOnly}</span>
        </div>
      </div>
      {events.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !events.data ? (
        <LoadFailed onRetry={() => void events.refetch()} />
      ) : events.data.length === 0 ? (
        <EmptyState framed icon={Activity} title={o.empty} description={o.emptyHint} />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {events.data.map((e) => (
            <OpsRow key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 跳转页

function JumpTab({
  hint,
  links,
}: {
  hint: string;
  links: { to: string; label: string; icon: ReactNode }[];
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-5">
      <p className="text-small text-fg-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-small text-fg hover:bg-subtle max-md:h-11"
          >
            {l.icon}
            {l.label}
            <ExternalLink size={14} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 页面

export function AdminPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as AdminTab | null;
  const tab: AdminTab = raw && TABS.includes(raw) ? raw : 'overview';

  if (me.isPending)
    return (
      <Page width="full">
        <Skeleton className="h-8 w-40" />
      </Page>
    );

  if (!me.data?.user.isAdmin)
    return (
      <Page width="full">
        <EmptyState
          framed
          icon={ShieldOff}
          title={ADMIN_COPY.noPermission}
          description={ADMIN_COPY.noPermissionHint}
          action={
            <Link
              to="/"
              className="inline-flex h-8 items-center rounded-md border border-line px-3 text-small text-fg hover:bg-subtle max-md:h-11"
            >
              {ADMIN_COPY.backHome}
            </Link>
          }
        />
      </Page>
    );

  return (
    <Page width="full" className="max-w-6xl">
      <PageHeader title={ADMIN_COPY.title} />
      <div className="mb-5 overflow-x-auto">
        <Tabs<AdminTab>
          layoutId="admin-tab"
          aria-label={ADMIN_COPY.title}
          value={tab}
          onValueChange={(v) => setParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
          items={TABS.map((value) => ({ value, label: ADMIN_COPY.tabs[value] }))}
        />
      </div>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'ops' && <OpsTab />}
      {tab === 'tickets' && (
        <JumpTab
          hint={ADMIN_COPY.tickets.hint}
          links={[
            {
              to: '/feedback?view=board',
              label: ADMIN_COPY.tickets.open,
              icon: <KanbanSquare size={16} strokeWidth={1.75} aria-hidden />,
            },
            {
              to: '/feedback?scope=waiting',
              label: ADMIN_COPY.tickets.openList,
              icon: <Ticket size={16} strokeWidth={1.75} aria-hidden />,
            },
          ]}
        />
      )}
      {tab === 'changelog' && (
        <JumpTab
          hint={ADMIN_COPY.changelog.hint}
          links={[
            {
              to: '/feedback?tab=changelog',
              label: ADMIN_COPY.changelog.open,
              icon: <Megaphone size={16} strokeWidth={1.75} aria-hidden />,
            },
          ]}
        />
      )}
    </Page>
  );
}
