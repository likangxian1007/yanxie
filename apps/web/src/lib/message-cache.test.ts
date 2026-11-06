import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Message } from '@srh/shared';
import { updateMessageCaches, removeMessageCaches, type MessagePages } from './apply-event';
import { qk } from './query-keys';

const message = (id: string, agentVisible: boolean): Message => ({
  id,
  projectId: 'p',
  threadId: null,
  author: { kind: 'user', id: 'u', name: '同名' },
  kind: 'text',
  body: '相同内容',
  meta: {},
  agentVisible,
  reactions: [],
  outputs: [],
  rootOfThreadId: null,
  editedAt: null,
  createdAt: '2026-10-27T00:00:00Z',
});
const pages = (items: Message[] = []): MessagePages => ({
  pages: [{ items, nextCursor: 'older' }],
  pageParams: [null],
});

describe('channel message caches', () => {
  it('preserves old keys and only updates matching loaded streams', () => {
    const qc = new QueryClient();
    for (const channel of ['all', 'agent', 'team'] as const)
      qc.setQueryData(qk.timeline('p', channel), pages());
    updateMessageCaches(qc, message('msg_team', false));
    updateMessageCaches(qc, message('msg_agent', true));
    const ids = (channel: 'all' | 'agent' | 'team') =>
      qc.getQueryData<MessagePages>(qk.timeline('p', channel))?.pages[0]?.items.map((m) => m.id);
    expect(qk.timeline('p')).toEqual(['p', 'p', 'timeline']);
    expect(ids('all')).toEqual(['msg_agent', 'msg_team']);
    expect(ids('agent')).toEqual(['msg_agent']);
    expect(ids('team')).toEqual(['msg_team']);
    updateMessageCaches(qc, { ...message('msg_team', false), body: '编辑后的讨论' });
    expect(qc.getQueryData<MessagePages>(qk.timeline('p', 'team'))?.pages[0]?.items[0]?.body).toBe(
      '编辑后的讨论',
    );
    removeMessageCaches(qc, 'p', null, 'msg_team');
    expect(ids('team')).toEqual([]);
    expect(ids('all')).toEqual(['msg_agent']);
  });
  it('does not initialize unopened channels or replace optimism in a different channel', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      qk.timeline('p'),
      pages([message('tmp_team', false), message('tmp_agent', true)]),
    );
    updateMessageCaches(qc, message('msg_agent', true));
    expect(qc.getQueryData(qk.timeline('p', 'team'))).toBeUndefined();
    expect(
      qc.getQueryData<MessagePages>(qk.timeline('p'))?.pages[0]?.items.map((m) => m.id),
    ).toEqual(['msg_agent', 'tmp_team']);
    updateMessageCaches(qc, message('msg_agent', true), 'tmp_agent');
    expect(qc.getQueryData<MessagePages>(qk.timeline('p'))?.pages[0]?.items).toHaveLength(2);
  });
});
