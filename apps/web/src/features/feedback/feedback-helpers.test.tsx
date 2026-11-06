import { describe, expect, it } from 'vitest';
import type { TicketSummary } from '@srh/shared';
import { badgeText } from './components/NotificationBell';
import { parseTicketNos } from './components/ChangelogTab';
import { groupIdeas } from './components/IdeasTab';
import { isFeedbackAttachmentUrl } from './components/AttachmentGallery';
import { diagnosticsText, idsFromLocation, stripSensitive, toFeedbackContext } from './diagnostics';
import {
  formatWait,
  parseTicketFilters,
  sortTickets,
  ticketQuery,
  waitHeat,
  waitingLabel,
} from './ticket-meta';

const NOW = Date.parse('2026-11-01T12:00:00Z');

function ticket(p: Partial<TicketSummary> & { no: number }): TicketSummary {
  return {
    id: `t${p.no}`,
    code: `YX-${p.no}`,
    kind: 'bug',
    title: `工单 ${p.no}`,
    status: 'open',
    priority: 'normal',
    roadmap: 'none',
    source: 'feedback',
    reporter: null,
    assignee: null,
    projectId: null,
    voteCount: 0,
    voted: false,
    lastReplyBy: null,
    lastReplyAt: null,
    unread: false,
    waiting: false,
    mine: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    ...p,
  } as TicketSummary;
}

describe('badgeText', () => {
  it('caps at 99+', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('ticket filters', () => {
  it('ignores admin-only params for non-admins', () => {
    const p = new URLSearchParams('scope=mine&status=done&assignee=me&view=board&q=YX-3');
    expect(parseTicketFilters(p, false)).toEqual({
      scope: 'mine',
      q: 'YX-3',
      status: '',
      assignee: '',
      view: 'list',
    });
    expect(parseTicketFilters(p, true)).toMatchObject({
      status: 'done',
      assignee: 'me',
      view: 'board',
    });
  });

  it('falls back on invalid values', () => {
    const f = parseTicketFilters(new URLSearchParams('scope=x&status=y'), true);
    expect(f.scope).toBe('all');
    expect(f.status).toBe('');
  });

  it('board view drops status filter', () => {
    const base = { scope: 'all' as const, q: ' ', status: 'done' as const, assignee: '' as const };
    expect(ticketQuery({ ...base, view: 'list' }).status).toBe('done');
    expect(ticketQuery({ ...base, view: 'board' }).status).toBeUndefined();
    expect(ticketQuery({ ...base, view: 'list' }).q).toBeUndefined();
  });

  it('waiting labels and heat', () => {
    expect(waitingLabel(ticket({ no: 1, waiting: true }), false)).toBe('等你回复');
    expect(waitingLabel(ticket({ no: 1, lastReplyBy: 'user' }), true)).toBe('等待支持回复');
    expect(waitingLabel(ticket({ no: 1, lastReplyBy: 'admin' }), true)).toBe('等提交人回复');
    expect(waitingLabel(ticket({ no: 1, status: 'done', waiting: true }), true)).toBeNull();
    expect(waitHeat(3 * 3_600_000)).toBe('none');
    expect(waitHeat(5 * 3_600_000)).toBe('warm');
    expect(waitHeat(25 * 3_600_000)).toBe('hot');
    expect(formatWait(30_000)).toBe('1 分钟');
    expect(formatWait(3 * 3_600_000)).toBe('3 小时');
    expect(formatWait(50 * 3_600_000)).toBe('2 天');
  });

  it('sorts waiting first, longest wait first for admins', () => {
    const list = [
      ticket({ no: 1, updatedAt: '2026-11-01T11:00:00Z' }),
      ticket({ no: 2, waiting: true, createdAt: '2026-11-01T10:00:00Z' }),
      ticket({ no: 3, waiting: true, createdAt: '2026-10-30T10:00:00Z' }),
    ];
    expect(sortTickets(list, true, NOW).map((t) => t.no)).toEqual([3, 2, 1]);
  });
});

describe('ideas wall', () => {
  it('groups by roadmap, sorts by votes, hides closed', () => {
    const groups = groupIdeas([
      ticket({ no: 1, kind: 'idea', roadmap: 'planned', voteCount: 1 }),
      ticket({ no: 2, kind: 'idea', roadmap: 'planned', voteCount: 5 }),
      ticket({ no: 3, kind: 'idea', roadmap: 'none', voteCount: 9 }),
      ticket({ no: 4, kind: 'idea', roadmap: 'planned', status: 'closed', voteCount: 99 }),
    ]);
    const planned = groups.find((g) => g.roadmap === 'planned');
    expect(planned?.items.map((t) => t.no)).toEqual([2, 1]);
    expect(groups.find((g) => g.roadmap === 'none')?.items.map((t) => t.no)).toEqual([3]);
  });
});

describe('changelog ticket numbers', () => {
  it('accepts numbers and codes, dedupes, rejects junk', () => {
    expect(parseTicketNos('12, YX-3，12 4')).toEqual([12, 3, 4]);
    expect(parseTicketNos('')).toEqual([]);
    expect(parseTicketNos('12 abc')).toBeNull();
  });
});

describe('diagnostics', () => {
  const d = {
    url: 'https://x.test/app/p/prj_1/chat?token=secret',
    route: '/p/prj_1/chat',
    projectId: 'prj_1',
    projectName: '课题一',
    userAgent: 'UA',
    viewport: '1440×900',
    theme: 'light',
    appVersion: '1.2.3',
    errors: [
      {
        message: 'boom',
        source: 'error' as const,
        route: '/p',
        at: '2026-11-01T00:00:00Z',
        stack: 'Error\n at a',
      },
    ],
  };

  it('strips query and guesses ids', () => {
    expect(stripSensitive(d.url)).toBe('https://x.test/app/p/prj_1/chat');
    expect(idsFromLocation('/p/prj_1/chat', '?thread=thr_9')).toEqual({
      projectId: 'prj_1',
      threadId: 'thr_9',
    });
  });

  it('builds context and log text', () => {
    const ctx = toFeedbackContext(d);
    expect(ctx.projectId).toBe('prj_1');
    expect(ctx.recentErrors).toHaveLength(1);
    expect(ctx).not.toHaveProperty('theme');
    const text = diagnosticsText(d, new Date(NOW));
    expect(text).toContain('课题一（prj_1）');
    expect(text).toContain('boom');
    expect(text).toContain('light');
  });

  it('only opens feedback attachment urls in the lightbox', () => {
    expect(isFeedbackAttachmentUrl('/api/v1/feedback/attachments/a')).toBe(true);
    expect(isFeedbackAttachmentUrl('https://evil.test/a.png')).toBe(false);
  });
});
