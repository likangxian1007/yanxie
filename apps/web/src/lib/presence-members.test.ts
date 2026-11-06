import { beforeEach, describe, expect, it } from 'vitest';
import type { PresenceState } from '@srh/shared';
import { presenceMembers } from './presence-members';
import { useRealtimeStore } from './realtime-store';
const p = (userId: string, extra: Partial<PresenceState> = {}): PresenceState => ({
  userId,
  name: userId,
  avatarColor: 0,
  view: 'timeline',
  objectId: null,
  activity: 'viewing',
  lastSeenAt: '2026-10-27T00:00:00Z',
  ...extra,
});
describe('presence identities', () => {
  beforeEach(() => useRealtimeStore.setState({ status: 'idle', presence: {} }));
  it('excludes self, deduplicates tabs and orders by name then id', () => {
    expect(presenceMembers([p('b'), p('me'), p('a'), p('b')], 'me').map((x) => x.userId)).toEqual([
      'a',
      'b',
    ]);
  });
  it('prefers the current resource then the latest activity', () => {
    const local = p('a', { view: 'document', objectId: 'doc', activity: 'editing' });
    const newer = p('a', { lastSeenAt: '2026-10-27T01:00:00Z', activity: 'typing' });
    expect(
      presenceMembers([local, newer], undefined, { view: 'document', objectId: 'doc' })[0],
    ).toEqual(local);
    expect(presenceMembers([local, newer])[0]).toEqual(newer);
  });
  it('retains snapshots through heartbeat and connection-order changes, publishes meaningful activity changes', () => {
    const store = useRealtimeStore.getState();
    store.setPresence('p', [p('b'), p('a')]);
    const before = useRealtimeStore.getState();
    store.setPresence('p', [p('a', { lastSeenAt: '2026-10-27T01:00:00Z' }), p('b')]);
    expect(useRealtimeStore.getState()).toBe(before);
    store.setPresence('p', [p('a', { activity: 'editing' }), p('b')]);
    expect(useRealtimeStore.getState().presence.p).not.toBe(before.presence.p);
  });
  it('requires a fresh snapshot when subscribing to a previously visited project', () => {
    const store = useRealtimeStore.getState();
    store.setPresence('p', [p('a')]);
    store.setPresence('other', [p('b')]);
    store.clearPresence('p');
    expect(Object.hasOwn(useRealtimeStore.getState().presence, 'p')).toBe(false);
    expect(useRealtimeStore.getState().presence.other).toHaveLength(1);
  });
  it('clears disconnected snapshots and waits for a new server snapshot', () => {
    const store = useRealtimeStore.getState();
    store.setStatus('open');
    store.setPresence('p', [p('a')]);
    store.setStatus('reconnecting');
    expect(useRealtimeStore.getState().presence).toEqual({});
    store.setStatus('open');
    expect(Object.hasOwn(useRealtimeStore.getState().presence, 'p')).toBe(false);
    store.setPresence('p', []);
    expect(Object.hasOwn(useRealtimeStore.getState().presence, 'p')).toBe(true);
  });
});
