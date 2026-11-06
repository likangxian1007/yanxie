import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { COLLAB_PATH } from '@srh/shared';
import { withBase } from '@/lib/base-path';
import { paletteIndex } from '@/lib/palette';
import { useMeUser } from '@/lib/session';
import { localCacheName, openLocalCache, type LocalCache } from './localCache';
import {
  deriveSyncState,
  isConnectionStale,
  shouldWarnBeforeUnload,
  type SyncState,
} from './syncState';
import { tr } from '@/lib/i18n';

/**
 * 协同文档连接（/collab/:docId，Hocuspocus 协议）。四类编辑器（富文本、表格、幻灯片、LaTeX）共用。
 *
 * awareness 约定（API.md §3.2）：
 *   user: { id, name, color: '#rrggbb', colorIndex, kind: 'user' | 'agent' }
 *   color 用十六进制：y-prosemirror / y-codemirror 只认 #rrggbb；界面上按 colorIndex 取 var(--palette-n)。
 *   cursor / selection 由各编辑器的绑定（y-prosemirror、y-codemirror）写入；
 *   表格写 `cell: 'r:c'`，幻灯片写 `slide: <slideId>`。
 *
 * 离线与本机缓存：
 *   - 每次修改都写进 IndexedDB（localCache.ts），断网时的修改在刷新 / 关闭后不会丢，恢复联网后自动补发；
 *   - 同步状态（syncState.ts）同时看浏览器 online/offline、provider 状态和未确认修改数，断网立即显示；
 *   - 有未确认的修改时，离开页面前提醒。
 */
export interface CollabUser {
  id: string;
  name: string;
  /** #rrggbb（与 STYLE 色板 --palette-n 同值），给第三方光标绑定用 */
  color: string;
  colorIndex: number;
  kind: 'user' | 'agent';
}

export interface CollabPeer {
  clientId: number;
  user: CollabUser;
  /** 该客户端 awareness 的其他字段（cell、slide 等） */
  state: Record<string, unknown>;
  isSelf: boolean;
}

export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'denied';

export interface CollabDoc {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  status: CollabStatus;
  /** 至少和服务端完整同步过一次 */
  synced: boolean;
  me: CollabUser;
  peers: CollabPeer[];
  // 以下是离线 / 同步状态（详情页用）。编辑器不需要，所以是可选的，编辑器测试里的假对象不用补。
  /** 浏览器是否联网 */
  online?: boolean;
  /** 服务端还没确认的本地修改数 */
  unsynced?: number;
  /** 顶部同步徽标要显示的状态 */
  sync?: SyncState;
  /** 可以显示编辑器：已和服务端同步，或连不上服务端但本机缓存里有内容 */
  ready?: boolean;
  /** 本机缓存是否已载入 */
  localLoaded?: boolean;
}

/** 色板兜底值：与 styles/tokens.css 的 --palette-0..7 相同（读不到 CSS 变量时用，例如测试环境） */
const PALETTE_FALLBACK = [
  '#6e56cf',
  '#3e63dd',
  '#0090ff',
  '#12a594',
  '#30a46c',
  '#f76b15',
  '#e54666',
  '#7c7b88',
] as const;

function normalizeHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/u.exec(v);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return null;
}

/**
 * 色板第 i 色的 #rrggbb：运行时从 CSS 变量 --palette-i 读（awareness 要跨端传，不能直接传 var()），
 * 读不到或不是十六进制 / rgb 时退回内置值。
 */
export function paletteHex(index: number): string {
  const i = paletteIndex(index);
  const fallback = PALETTE_FALLBACK[i] ?? PALETTE_FALLBACK[0];
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--palette-${i}`);
    return normalizeHex(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 握手被拒的关闭码：4401 未登录、4403 无权限 / 来源不允许、4404 不是成员或文档不存在 */
const DENIED_CODES: ReadonlySet<number> = new Set([4401, 4403, 4404]);

export function collabUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${withBase(COLLAB_PATH)}`;
}

function readPeers(provider: HocuspocusProvider): CollabPeer[] {
  const awareness = provider.awareness;
  if (!awareness) return [];
  const out: CollabPeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: CollabUser }).user;
    if (!user) return;
    out.push({
      clientId,
      user,
      state: state as Record<string, unknown>,
      isSelf: clientId === awareness.clientID,
    });
  });
  // 同一个人开了多个标签页时只显示一次（保留自己那份）
  const seen = new Map<string, CollabPeer>();
  for (const p of out) {
    const prev = seen.get(p.user.id);
    if (!prev || p.isSelf) seen.set(p.user.id, p);
  }
  return [...seen.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** 让 provider 立即判定断开（关掉当前 socket），之后按退避自动重连 */
function forceReconnect(provider: HocuspocusProvider, { pause = false } = {}) {
  const socket = provider.configuration.websocketProvider;
  if (!socket) return;
  // 离线时暂停自动重连（每次重试都会在控制台报一条连接失败），联网后由 online 事件立即重连
  if (pause) socket.disconnect();
  if (socket.status === 'disconnected') return;
  // 走 'close' 事件：socket 自己清理并安排重连，provider 也会重置同步状态、清掉别人的光标
  // （与 Hocuspocus 自己检测到超时时用的 4408 相同）
  (socket as unknown as { emit(event: string, payload: unknown): void }).emit('close', {
    event: { code: 4408, reason: 'stale' },
  });
}

/**
 * 连接一篇协同文档。连接在 effect 里创建（StrictMode 下也安全），docId 变化或卸载时销毁。
 * 返回 null 表示连接还没建立（首帧）。
 */
export function useCollabDoc(docId: string): CollabDoc | null {
  const meUser = useMeUser();
  const userId = meUser?.id ?? null;
  const me = useMemo<CollabUser>(() => {
    const colorIndex = paletteIndex(meUser?.avatarColor ?? 0);
    return {
      id: meUser?.id ?? 'anonymous',
      name: meUser?.name ?? tr('访客'),
      color: paletteHex(colorIndex),
      colorIndex,
      kind: 'user',
    };
  }, [meUser?.id, meUser?.name, meUser?.avatarColor]);

  const [conn, setConn] = useState<Connection | null>(null);
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [online, setOnline] = useState(browserOnline);
  const [unsynced, setUnsynced] = useState(0);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [local, setLocal] = useState<{ loaded: boolean; hadContent: boolean }>({
    loaded: false,
    hadContent: false,
  });

  useEffect(() => {
    const c = createConnection(docId);
    const { provider, doc } = c;
    let cache: LocalCache | null = null;
    let disposed = false;
    // 一旦被拒（未登录 / 无权限 / 文档不存在）就停在 denied：不再自动重连，后续 status 事件也不覆盖。
    // 无权限 / 不是成员 / 文档不存在（4403 / 4404）时删掉这篇文档的本机缓存。
    // 4401（登录过期）保留：缓存按用户分库，别人看不到；本人重新登录后，断网期间的修改还能补发。
    let denied = false;
    let deniedBeforeCache = false;
    const deny = (clearCache: boolean) => {
      if (denied) return;
      denied = true;
      provider.disconnect();
      setStatus('denied');
      if (!clearCache) return;
      if (cache) void cache.clear();
      else deniedBeforeCache = true;
    };
    const onStatus = ({ status: s }: { status: string }) => {
      if (denied) return;
      setStatus(
        s === 'connected' ? 'connected' : s === 'connecting' ? 'connecting' : 'disconnected',
      );
      // 每条新连接重新计时：否则积压超过阈值后，重连一连上就被判为卡死、立刻又断开，
      // 永远没机会把积压的修改发出去（权限从只读升到可编辑时最容易触发）
      if (s === 'connected') setPendingSince((prev) => (prev === null ? null : Date.now()));
    };
    const onSynced = ({ state: s }: { state: boolean }) => setSynced(s);
    const onDenied = () => deny(true);
    const onClose = ({ event }: { event: { code: number } }) => {
      if (DENIED_CODES.has(event.code)) deny(event.code !== 4401);
    };
    const onUnsynced = ({ number }: { number: number }) => {
      setUnsynced(number);
      setPendingSince((prev) => (number > 0 ? (prev ?? Date.now()) : null));
    };
    // 编辑器在渲染期间创建时会同步写 awareness（光标扩展），这里推迟到微任务，避免“渲染中更新别的组件”
    let pending = false;
    const onAwareness = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!disposed) setPeers(readPeers(provider));
      });
    };
    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('authenticationFailed', onDenied);
    provider.on('close', onClose);
    provider.on('awarenessUpdate', onAwareness);
    provider.on('unsyncedChanges', onUnsynced);
    // 外部连接只能在 effect 里创建（StrictMode 会挂载两次），创建后同步进 state 是这里的本意
    /* eslint-disable react-hooks/set-state-in-effect */
    setConn(c);
    setSynced(false);
    setStatus('connecting');
    setUnsynced(0);
    setPendingSince(null);
    setLocal({ loaded: false, hadContent: false });
    /* eslint-enable react-hooks/set-state-in-effect */

    // 真正连接推迟到下一轮事件循环：StrictMode 的“挂载 → 立即卸载”不会建出一条马上被关掉的 WebSocket
    // （否则控制台会出现 “WebSocket is closed before the connection is established”）
    const start = setTimeout(() => {
      if (disposed) return;
      if (userId) {
        cache = openLocalCache(localCacheName(userId, docId), doc);
        if (cache && deniedBeforeCache) void cache.clear();
        if (cache) {
          void cache.whenLoaded.then(({ hadContent }) => {
            if (!disposed) setLocal({ loaded: true, hadContent });
          });
        } else {
          setLocal({ loaded: true, hadContent: false });
        }
      }
      // 离线打开（本机缓存里有内容时照样能编辑）：先不连，等 online 事件
      if (denied) return;
      if (browserOnline()) void provider.connect();
      else setStatus('disconnected');
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(start);
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
      provider.off('authenticationFailed', onDenied);
      provider.off('close', onClose);
      provider.off('awarenessUpdate', onAwareness);
      provider.off('unsyncedChanges', onUnsynced);
      provider.destroy();
      cache?.destroy();
      doc.destroy();
      setConn(null);
    };
  }, [docId, userId]);

  // 浏览器联网状态：断网立刻知道（WebSocket 自己要几十秒才发现）；恢复联网立即重连，不等退避
  useEffect(() => {
    const provider = conn?.provider;
    const goOnline = () => {
      setOnline(true);
      if (provider && status !== 'denied') {
        const socket = provider.configuration.websocketProvider;
        if (socket.status !== 'connected') void socket.connect();
      }
    };
    const goOffline = () => {
      setOnline(false);
      if (provider) forceReconnect(provider, { pause: true });
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [conn, status]);

  // 有未确认的修改时每 500ms 重新判定：超过阈值显示“有未同步的修改”，长时间没确认就主动重连
  useEffect(() => {
    if (pendingSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [pendingSince]);

  const pendingMs = pendingSince === null ? 0 : Math.max(0, now - pendingSince);
  const inputs = { status, synced, online, unsynced, pendingMs };

  const stale = isConnectionStale(inputs);
  useEffect(() => {
    if (stale && conn) forceReconnect(conn.provider);
  }, [stale, conn]);

  // 还有没被服务端确认的修改：离开页面前提醒（修改已存在本机，但别人还看不到）
  const warn = shouldWarnBeforeUnload(inputs);
  useEffect(() => {
    if (!warn) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 旧版浏览器需要 returnValue 才会弹确认
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [warn]);

  // 本人身份写进 awareness
  useEffect(() => {
    conn?.provider.setAwarenessField('user', me);
  }, [conn, me]);

  if (!conn) return null;
  const sync = deriveSyncState(inputs);
  const ready =
    synced || (local.loaded && local.hadContent && (status === 'disconnected' || !online));
  return {
    doc: conn.doc,
    provider: conn.provider,
    status,
    synced,
    me,
    peers,
    online,
    unsynced,
    sync,
    ready: status !== 'denied' && ready,
    localLoaded: local.loaded,
  };
}

interface Connection {
  docId: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

function createConnection(docId: string): Connection {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${collabUrl()}/${encodeURIComponent(docId)}`,
    name: docId,
    document: doc,
    // 鉴权走同源 Cookie；协议仍要求带一个 token 字段
    token: 'cookie',
    // 不在构造时连接：由 effect 推迟到下一轮再连（见上）
    autoConnect: false,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  return { docId, doc, provider };
}
