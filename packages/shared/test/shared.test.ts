import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ClientFrame,
  EVENT_TYPES,
  MessageListQuery,
  PersonalThreadCreateInput,
  checklistProgress,
  isId,
  newId,
  parseChecklist,
  parseEventPayload,
  relativeTimeZh,
  ulid,
} from '../src';

describe('ids', () => {
  it('generates sortable prefixed ids', () => {
    const a = newId('project', 1_700_000_000_000);
    const b = newId('project', 1_700_000_000_001);
    expect(a.startsWith('prj_')).toBe(true);
    expect(a.length).toBe(4 + 26);
    expect(a < b).toBe(true);
    expect(isId('project', a)).toBe(true);
    expect(isId('thread', a)).toBe(false);
  });

  it('ulid is 26 chars of crockford base32', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
  });
});

describe('checklist', () => {
  it('parses marks, title and highlight', () => {
    const list = parseChecklist(
      '复现基线\n\n✓ 读了论文\n**✓ 跑通了代码**\n✱ 正在调参\n○ 写实验记录',
    );
    expect(list.title).toBe('复现基线');
    expect(list.lines.map((l) => l.mark)).toEqual(['done', 'done', 'active', 'todo']);
    expect(list.lines[1]?.highlight).toBe(true);
    expect(checklistProgress(list)).toBe(0.5);
  });
});

describe('protocol', () => {
  it('validates message channels and personal first-turn settings', () => {
    expect(MessageListQuery.parse({})).toEqual({ limit: 50, order: 'desc', channel: 'all' });
    for (const channel of ['all', 'agent', 'team']) {
      expect(MessageListQuery.parse({ channel }).channel).toBe(channel);
    }
    expect(MessageListQuery.safeParse({ channel: 'other' }).success).toBe(false);
    expect(
      PersonalThreadCreateInput.parse({
        body: '问题',
        model: 'provider/model',
        effort: 'max',
        profile: 'paper-reader',
      }),
    ).toMatchObject({ model: 'provider/model', effort: 'max', profile: 'paper-reader' });
    expect(PersonalThreadCreateInput.parse({ body: '问题', model: null, effort: null })).toEqual({
      body: '问题',
      model: null,
      effort: null,
    });
    expect(PersonalThreadCreateInput.safeParse({ body: '问题', effort: 'ultra' }).success).toBe(
      false,
    );
    expect(
      PersonalThreadCreateInput.safeParse({ body: '问题', model: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('validates client frames with defaults', () => {
    const f = ClientFrame.parse({ op: 'subscribe', projectId: 'prj_x' });
    expect(f).toEqual({ op: 'subscribe', projectId: 'prj_x', afterSeq: 0 });
    expect(() => ClientFrame.parse({ op: 'nope' })).toThrow();
  });

  it('has a schema for every event type', () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(40);
    expect(parseEventPayload('message.deleted', { id: 'msg_1' })).toEqual({ id: 'msg_1' });
  });

  it('ApiError maps code to status', () => {
    const e = new ApiError('version_conflict', '已被他人修改', { current: { version: 3 } });
    expect(e.status).toBe(409);
    expect(e.toBody().error.code).toBe('version_conflict');
  });

  it('relative time in chinese', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(relativeTimeZh('2026-10-26T11:59:50Z', now)).toBe('刚刚');
    expect(relativeTimeZh('2026-10-26T11:30:00Z', now)).toBe('30 分钟前');
  });
});
