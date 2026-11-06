import * as Y from 'yjs';

type PendingMarker = { snapshot: string; closed: boolean; locked: boolean };
/** 每个协作连接单独留标记，另一标签页的确认不能清除仍在编辑的会话。 */
const memory = new Map<string, PendingMarker>();
const volatile = new Set<string>();
const confirmedMemory = new Map<string, Uint8Array>();
const volatileConfirmed = new Set<string>();
export const tableSyncKey = (userId: string, pid: string, recordId: string, itemId: string) =>
  `srh:research-table-pending:${encodeURIComponent(userId)}:${encodeURIComponent(pid)}:${encodeURIComponent(recordId)}:${encodeURIComponent(itemId)}:`;
const markerName = (key: string, session: string) => `${key}${session}`;
const confirmedName = (key: string) =>
  key.replace('srh:research-table-pending:', 'srh:research-table-confirmed:');
export const tableSyncLockName = (key: string, session: string) =>
  `srh:table-sync-lock:${markerName(key, session)}`;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
function decode(value: string): Uint8Array | null {
  if (!value || value.length % 2 || !/^[0-9a-f]+$/u.test(value)) return null;
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
function includesState(current: Uint8Array, previous: string): boolean {
  const bytes = decode(previous);
  if (!bytes) return false;
  try {
    const known = Y.decodeSnapshot(current);
    const wanted = Y.decodeSnapshot(bytes);
    if (![...wanted.sv].every(([client, clock]) => (known.sv.get(client) ?? 0) >= clock))
      return false;
    for (const [client, ranges] of wanted.ds.clients) {
      const available = known.ds.clients.get(client) ?? [];
      for (const range of ranges) {
        let covered = range.clock;
        const end = range.clock + range.len;
        for (const entry of available) {
          if (entry.clock > covered) break;
          covered = Math.max(covered, entry.clock + entry.len);
          if (covered >= end) break;
        }
        if (covered < end) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
function read(name: string): PendingMarker | null {
  if (volatile.has(name)) return memory.get(name) ?? null;
  try {
    const raw = localStorage.getItem(name);
    if (!raw) return volatile.has(name) ? (memory.get(name) ?? null) : null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const marker = value as Partial<PendingMarker>;
    return typeof marker.snapshot === 'string' &&
      typeof marker.closed === 'boolean' &&
      typeof marker.locked === 'boolean'
      ? (marker as PendingMarker)
      : null;
  } catch {
    return memory.get(name) ?? null;
  }
}
function write(name: string, value: PendingMarker): boolean {
  memory.set(name, value);
  try {
    localStorage.setItem(name, JSON.stringify(value));
    volatile.delete(name);
    return true;
  } catch {
    volatile.add(name);
    return false;
  }
}
function remove(name: string): void {
  memory.delete(name);
  volatile.delete(name);
  try {
    localStorage.removeItem(name);
  } catch {
    /* 仍保留存储侧标记供重试 */
  }
}
function names(key: string): Set<string> {
  const found = new Set([...volatile].filter((name) => name.startsWith(key)));
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name?.startsWith(key)) found.add(name);
    }
  } catch {
    for (const name of memory.keys()) if (name.startsWith(key)) found.add(name);
  }
  return found;
}
/** 仅在本机缓存加载完且服务器确认全部修改后记录。 */
export function rememberTableSynced(key: string, snapshot: Uint8Array): void {
  if (!names(key).size) return;
  confirmedMemory.set(key, snapshot);
  try {
    localStorage.setItem(confirmedName(key), hex(snapshot));
    volatileConfirmed.delete(key);
  } catch {
    volatileConfirmed.add(key);
  }
}
function confirmedState(key: string): Uint8Array | null {
  if (volatileConfirmed.has(key)) return confirmedMemory.get(key) ?? null;
  try {
    const value = localStorage.getItem(confirmedName(key));
    return value
      ? decode(value)
      : volatileConfirmed.has(key)
        ? (confirmedMemory.get(key) ?? null)
        : null;
  } catch {
    return confirmedMemory.get(key) ?? null;
  }
}
export function markTablePending(
  key: string,
  session: string,
  state: Uint8Array,
  locked: boolean,
): boolean {
  return write(markerName(key, session), { snapshot: hex(state), closed: false, locked });
}
export function closeTableSession(key: string, session: string): void {
  const name = markerName(key, session);
  const value = read(name);
  if (value) write(name, { ...value, closed: true });
}
export function clearTablePending(key: string, session: string): void {
  remove(markerName(key, session));
}
export function hasPendingTable(key: string): boolean {
  const confirmed = confirmedState(key);
  return [...names(key)].some((name) => {
    const marker = read(name);
    return !marker || !confirmed || !includesState(confirmed, marker.snapshot);
  });
}
/** 调用方须先加载本机缓存、完成服务器同步；快照的状态向量和删除集确认包含旧会话全部修改。 */
export function clearClosedTableSessions(
  key: string,
  currentSession: string,
  current: Uint8Array,
): void {
  for (const name of names(key)) {
    if (name === markerName(key, currentSession)) continue;
    const value = read(name);
    if (value?.closed && includesState(current, value.snapshot)) remove(name);
  }
}
/** Web Lock 证明其他会话不再存活；无法证明时保留标记。 */
export async function clearOrphanedTableSessions(
  key: string,
  currentSession: string,
  current: Uint8Array,
): Promise<void> {
  if (!navigator.locks) return;
  await Promise.all(
    [...names(key)].map(async (name) => {
      if (name === markerName(key, currentSession)) return;
      const value = read(name);
      if (!value || value.closed || !value.locked || !includesState(current, value.snapshot))
        return;
      const session = name.slice(key.length);
      try {
        await navigator.locks.request(
          tableSyncLockName(key, session),
          { ifAvailable: true },
          (lock) => {
            if (lock) {
              const latest = read(name);
              if (latest && includesState(current, latest.snapshot)) remove(name);
            }
          },
        );
      } catch {
        /* 无法判定时保留，绝不视为已同步 */
      }
    }),
  );
}
