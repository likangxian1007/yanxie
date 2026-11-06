import { describe, expect, it } from 'vitest';
import {
  deriveSyncState,
  isConnectionStale,
  shouldWarnBeforeUnload,
  type SyncInputs,
} from './syncState';

const base: SyncInputs = {
  status: 'connected',
  synced: true,
  online: true,
  unsynced: 0,
  pendingMs: 0,
};

describe('deriveSyncState', () => {
  it('连着、全部确认 → 已同步', () => {
    expect(deriveSyncState(base)).toBe('synced');
  });

  it('浏览器离线时，即使 WebSocket 还“连着”也显示离线（不等 30 秒超时）', () => {
    expect(deriveSyncState({ ...base, online: false })).toBe('offline');
    expect(deriveSyncState({ ...base, online: false, unsynced: 3, pendingMs: 100 })).toBe(
      'offline',
    );
  });

  it('有修改超过 1.5 秒没被确认 → 有未同步的修改；刚发出的不提示', () => {
    expect(deriveSyncState({ ...base, unsynced: 1, pendingMs: 200 })).toBe('synced');
    expect(deriveSyncState({ ...base, unsynced: 1, pendingMs: 1500 })).toBe('unsynced');
  });

  it('同步过之后断开 → 正在重连；从没同步过 → 正在连接', () => {
    expect(deriveSyncState({ ...base, status: 'disconnected' })).toBe('reconnecting');
    expect(deriveSyncState({ ...base, status: 'connecting' })).toBe('reconnecting');
    expect(deriveSyncState({ ...base, status: 'connecting', synced: false })).toBe('connecting');
    expect(deriveSyncState({ ...base, synced: false })).toBe('connecting');
  });

  it('被拒优先于一切', () => {
    expect(deriveSyncState({ ...base, status: 'denied', online: false })).toBe('denied');
  });
});

describe('离开提醒与失效连接', () => {
  it('有未确认修改才提醒', () => {
    expect(shouldWarnBeforeUnload({ status: 'connected', unsynced: 0 })).toBe(false);
    expect(shouldWarnBeforeUnload({ status: 'disconnected', unsynced: 2 })).toBe(true);
    expect(shouldWarnBeforeUnload({ status: 'denied', unsynced: 2 })).toBe(false);
  });

  it('连着但 6 秒都没确认 → 连接失效', () => {
    expect(isConnectionStale({ status: 'connected', unsynced: 1, pendingMs: 5999 })).toBe(false);
    expect(isConnectionStale({ status: 'connected', unsynced: 1, pendingMs: 6000 })).toBe(true);
    expect(isConnectionStale({ status: 'disconnected', unsynced: 1, pendingMs: 9000 })).toBe(false);
  });
});
