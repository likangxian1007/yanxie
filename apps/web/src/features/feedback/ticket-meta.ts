import type { TicketKind, TicketStatus, TicketSummary } from '@srh/shared';
import type { BadgeTone } from '@/components/ui';
import { FEEDBACK_COPY } from './copy';
import type { TicketListParams } from './api';
import { tr } from '@/lib/i18n';

const c = FEEDBACK_COPY.list;

export const STATUS_TONE: Record<TicketStatus, BadgeTone> = {
  open: 'warning',
  doing: 'accent',
  done: 'success',
  closed: 'neutral',
};

export const KIND_TONE: Record<TicketKind, BadgeTone> = {
  bug: 'danger',
  idea: 'agent',
  question: 'neutral',
};

export type TicketScope = 'all' | 'waiting' | 'mine';
export type TicketView = 'list' | 'board';

export interface TicketFilters {
  scope: TicketScope;
  q: string;
  status: TicketStatus | '';
  assignee: '' | 'me' | 'none';
  view: TicketView;
}

const SCOPES: TicketScope[] = ['all', 'waiting', 'mine'];
const STATUSES: TicketStatus[] = ['open', 'doing', 'done', 'closed'];

/** URL → 筛选条件；非管理员忽略状态 / 指派 / 看板。 */
export function parseTicketFilters(params: URLSearchParams, isAdmin: boolean): TicketFilters {
  const scope = params.get('scope') as TicketScope | null;
  const status = params.get('status') as TicketStatus | null;
  const assignee = params.get('assignee');
  return {
    scope: scope && SCOPES.includes(scope) ? scope : 'all',
    q: params.get('q') ?? '',
    status: isAdmin && status && STATUSES.includes(status) ? status : '',
    assignee: isAdmin && (assignee === 'me' || assignee === 'none') ? assignee : '',
    view: isAdmin && params.get('view') === 'board' ? 'board' : 'list',
  };
}

/** 筛选条件 → 接口参数。看板视图不按状态筛（每列就是一个状态）。 */
export function ticketQuery(f: TicketFilters): TicketListParams {
  return {
    scope: f.scope,
    q: f.q.trim() || undefined,
    status: f.view === 'board' ? undefined : f.status || undefined,
    assignee: f.assignee || undefined,
    limit: 200,
  };
}

/** 「已等 3 小时」：从最近一次回复（没有则提交时间）算起。 */
export function waitedMs(t: TicketSummary, now: number): number {
  return Math.max(0, now - new Date(t.lastReplyAt ?? t.createdAt).getTime());
}

export function formatWait(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return tr('{n} 分钟', { n: Math.max(1, min) });
  const h = Math.floor(min / 60);
  if (h < 24) return tr('{n} 小时', { n: h });
  return tr('{n} 天', { n: Math.floor(h / 24) });
}

/** 等待程度：>4h warm，>24h hot（管理员队列用来排序和着色）。 */
export function waitHeat(ms: number): 'none' | 'warm' | 'hot' {
  if (ms > 24 * 3_600_000) return 'hot';
  if (ms > 4 * 3_600_000) return 'warm';
  return 'none';
}

/** 谁在等：给我 / 给支持 / 给提交人；已结束的工单不提示。 */
export function waitingLabel(t: TicketSummary, isAdmin: boolean): string | null {
  if (t.status === 'done' || t.status === 'closed') return null;
  if (t.waiting) return c.waitingYou;
  if (!t.lastReplyBy) return isAdmin ? null : c.waitingSupport;
  if (t.lastReplyBy === 'user') return c.waitingSupport;
  return isAdmin ? c.waitingReporter : null;
}

/** 列表排序：等我回复的在前，然后按等待时长（管理员）或最近更新。 */
export function sortTickets(list: TicketSummary[], isAdmin: boolean, now: number) {
  return [...list].sort((a, b) => {
    if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
    if (isAdmin && a.waiting && b.waiting) return waitedMs(b, now) - waitedMs(a, now);
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}
