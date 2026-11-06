/**
 * 文档顶部同步状态的判定（纯函数，便于测试）。
 *
 * 只看 provider 的 status 不够：断网后 WebSocket 要几十秒才判定断开，这期间 status 仍是 connected。
 * 所以同时看三样东西：
 *   - 浏览器的 online / offline 事件（断网立即知道）；
 *   - provider.unsyncedChanges：本地修改发出后，服务端确认写入才减回 0；
 *   - 最早一条未确认修改已经等了多久（超过阈值就如实显示“有未同步的修改”）。
 */
export type SyncState =
  /** 首次连接、还没和服务端同步过 */
  | 'connecting'
  /** 所有修改都已被服务端确认 */
  | 'synced'
  /** 连着，但有修改迟迟没被确认 */
  | 'unsynced'
  /** 曾经连上过，现在断开，正在重连 */
  | 'reconnecting'
  /** 浏览器离线 */
  | 'offline'
  /** 握手被拒（未登录 / 无权限 / 文档不存在） */
  | 'denied';

export interface SyncInputs {
  status: 'connecting' | 'connected' | 'disconnected' | 'denied';
  /** 至少和服务端完整同步过一次 */
  synced: boolean;
  online: boolean;
  /** 服务端还没确认的本地修改数 */
  unsynced: number;
  /** 最早一条未确认修改发出至今的毫秒数（没有则为 0） */
  pendingMs: number;
}

/** 修改发出后多久还没确认，就提示“有未同步的修改”（正常往返远小于这个值，打字时不会闪） */
export const UNSYNCED_HINT_MS = 1500;
/** 连着却这么久都没确认：认为连接已经失效，主动断开重连（Hocuspocus 默认要 30s 才发现） */
export const STALE_CONNECTION_MS = 6000;

export function deriveSyncState(i: SyncInputs): SyncState {
  if (i.status === 'denied') return 'denied';
  if (!i.online) return 'offline';
  if (i.status !== 'connected') return i.synced ? 'reconnecting' : 'connecting';
  if (!i.synced) return 'connecting';
  if (i.unsynced > 0 && i.pendingMs >= UNSYNCED_HINT_MS) return 'unsynced';
  return 'synced';
}

/** 离开页面前是否需要提醒：还有没被服务端确认的修改 */
export function shouldWarnBeforeUnload(i: Pick<SyncInputs, 'status' | 'unsynced'>): boolean {
  return i.status !== 'denied' && i.unsynced > 0;
}

/** 连着但长时间收不到确认：连接很可能已经断了 */
export function isConnectionStale(i: Pick<SyncInputs, 'status' | 'unsynced' | 'pendingMs'>) {
  return i.status === 'connected' && i.unsynced > 0 && i.pendingMs >= STALE_CONNECTION_MS;
}
