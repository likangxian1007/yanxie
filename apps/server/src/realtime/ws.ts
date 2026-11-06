import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  ClientFrame,
  WS_CLOSE,
  WS_PATH,
  WS_RESYNC_THRESHOLD,
  type AnyProjectEvent,
  type PresenceState,
  type ServerFrame,
} from '@srh/shared';
import type { EventBus } from './bus';
import { watchApiTokenSocket } from '../modules/integrations/service';
import { isAllowedOrigin, type AccessPolicy, type RealtimeUser } from './access';

/**
 * /ws：应用事件通道（协议见 @srh/shared ws.ts 与 API.md §3）。
 * 职责：鉴权 → 订阅项目 → 补发缺失事件 → 实时推送 → 在线状态 → 心跳清理死连接。
 *
 * 顺序保证：订阅时先把实时事件缓冲起来，补发完历史后再按 seq 去重冲刷缓冲，
 * 所以客户端收到的同一项目事件严格按 seq 递增、不重不漏。
 */
const HEARTBEAT_MS = 30_000;

interface Conn {
  id: number;
  socket: WebSocket;
  user: RealtimeUser | null;
  projects: Set<string>;
  /** 正在补发历史的项目：实时事件先进缓冲 */
  buffering: Map<string, AnyProjectEvent[]>;
  /** 每个项目已推送的最大 seq，用于去重 */
  sentSeq: Map<string, number>;
  closed: boolean;
  alive: boolean;
}

export function registerRealtime(
  app: FastifyInstance,
  bus: EventBus,
  access: AccessPolicy,
  publicUrl: string,
) {
  const byProject = new Map<string, Set<Conn>>();
  const presence = new Map<string, Map<number, PresenceState>>();
  const all = new Set<Conn>();
  let nextId = 1;

  const send = (conn: Conn, frame: ServerFrame) => {
    if (!conn.closed && conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(frame));
    }
  };

  const sendEvent = (conn: Conn, event: AnyProjectEvent) => {
    if (!conn.projects.has(event.projectId)) return;
    const last = conn.sentSeq.get(event.projectId) ?? 0;
    if (event.seq <= last) return;
    conn.sentSeq.set(event.projectId, event.seq);
    if (conn.user && access.canSeeEvent(conn.user, event)) send(conn, { op: 'event', event });
  };

  const broadcastPresence = (projectId: string) => {
    const members = [...(presence.get(projectId)?.values() ?? [])];
    for (const conn of byProject.get(projectId) ?? []) {
      send(conn, { op: 'presence', projectId, members });
    }
  };

  const leave = (conn: Conn, projectId: string) => {
    conn.projects.delete(projectId);
    conn.buffering.delete(projectId);
    conn.sentSeq.delete(projectId);
    byProject.get(projectId)?.delete(conn);
    if (presence.get(projectId)?.delete(conn.id)) broadcastPresence(projectId);
  };

  const revoke = (conn: Conn) => {
    send(conn, { op: 'error', code: 'forbidden', message: '项目访问权限已变更，请重新进入项目' });
    conn.closed = true;
    all.delete(conn);
    for (const projectId of [...conn.projects]) leave(conn, projectId);
    conn.socket.close(WS_CLOSE.forbidden, 'project access revoked');
  };

  bus.onEvent((event) => {
    for (const conn of [...(byProject.get(event.projectId) ?? [])]) {
      if (
        (event.type === 'project.updated' && event.payload.archivedAt) ||
        (event.type === 'member.removed' && event.payload.userId === conn.user?.id)
      ) {
        if (conn.projects.size === 1 && event.type === 'member.removed') revoke(conn);
        else {
          leave(conn, event.projectId);
          send(conn, { op: 'error', code: 'forbidden', message: '没有该项目的访问权限' });
        }
        continue;
      }
      const buffer = conn.buffering.get(event.projectId);
      if (buffer) buffer.push(event);
      else sendEvent(conn, event);
    }
  });
  bus.onEphemeral((event) => {
    for (const conn of byProject.get(event.projectId) ?? []) {
      if (!conn.user || !(access.canSeeEphemeral?.(conn.user, event) ?? true)) continue;
      send(conn, {
        op: 'ephemeral',
        projectId: event.projectId,
        type: event.type,
        payload: event.payload,
      });
    }
  });

  // 心跳：每 30s ping 一次，上一轮没回 pong 的连接直接断开（同时清理在线状态）
  const heartbeat = setInterval(() => {
    for (const conn of all) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook('onClose', async () => clearInterval(heartbeat));

  app.get(WS_PATH, { websocket: true }, async (socket, req) => {
    if (!isAllowedOrigin(req, publicUrl)) {
      socket.close(WS_CLOSE.forbidden, 'origin not allowed');
      return;
    }
    const conn: Conn = {
      id: nextId++,
      socket,
      user: null,
      projects: new Set(),
      buffering: new Map(),
      sentSeq: new Map(),
      closed: false,
      alive: true,
    };
    all.add(conn);

    // 先挂监听再 await，避免握手后客户端立刻发来的帧丢失
    const pending: string[] = [];
    let ready = false;
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (raw) => {
      if (socket.readyState !== socket.OPEN) return;
      conn.alive = true;
      const text = raw.toString();
      if (ready) void safeHandle(text);
      else pending.push(text);
    });
    socket.on('close', () => {
      conn.closed = true;
      all.delete(conn);
      for (const projectId of [...conn.projects]) leave(conn, projectId);
    });

    try {
      conn.user = await access.userFromRequest(req);
    } catch (err) {
      req.log.error({ err }, 'ws auth failed');
      conn.user = null;
    }
    if (conn.closed) return;
    if (!conn.user) {
      socket.close(WS_CLOSE.unauthorized, 'unauthorized');
      return;
    }
    await watchApiTokenSocket(req, socket);
    if (socket.readyState !== socket.OPEN) return;
    send(conn, { op: 'ready', userId: conn.user.id, serverTime: new Date().toISOString() });
    ready = true;
    for (const text of pending.splice(0)) await safeHandle(text);

    async function safeHandle(text: string) {
      try {
        await handle(text);
      } catch (err) {
        req.log.error({ err }, 'ws frame failed');
        send(conn, { op: 'error', code: 'internal', message: '服务器处理消息时出错' });
      }
    }

    async function handle(text: string) {
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(text));
      } catch {
        send(conn, { op: 'error', code: 'bad_frame', message: '无法识别的消息' });
        return;
      }
      switch (frame.op) {
        case 'ping':
          send(conn, { op: 'pong' });
          return;
        case 'subscribe': {
          const { projectId, afterSeq } = frame;
          // replay=true 时 afterSeq=0 也补发（客户端拿 /auth/me 的 eventSeq 当下界，新项目可能是 0）
          const replay = afterSeq > 0 || frame.replay === true;
          if (!(await access.canAccessProject(conn.user, projectId))) {
            send(conn, { op: 'error', code: 'forbidden', message: '没有该项目的访问权限' });
            return;
          }
          if (conn.closed) return;
          // 先登记并开始缓冲实时事件，再读历史，避免两者之间的事件丢失
          conn.projects.add(projectId);
          conn.buffering.set(projectId, []);
          let set = byProject.get(projectId);
          if (!set) byProject.set(projectId, (set = new Set()));
          set.add(conn);
          try {
            // 鉴权与登记之间可能发生移出或归档；登记后重新检查，避免漏掉变化事件。
            if (!(await access.canAccessProject(conn.user, projectId))) {
              leave(conn, projectId);
              send(conn, { op: 'error', code: 'forbidden', message: '没有该项目的访问权限' });
              return;
            }
            if (!conn.projects.has(projectId) || conn.closed) return;
            const latestSeq = await bus.latestSeq(projectId);
            if (!conn.projects.has(projectId) || conn.closed) return;
            if (replay && latestSeq - afterSeq > WS_RESYNC_THRESHOLD) {
              send(conn, { op: 'resync', projectId, latestSeq });
              conn.sentSeq.set(projectId, latestSeq);
            } else if (replay) {
              const history = await bus.listSince(projectId, afterSeq, WS_RESYNC_THRESHOLD);
              if (conn.closed) return;
              if (!(await access.canAccessProject(conn.user, projectId))) {
                revoke(conn);
                return;
              }
              conn.sentSeq.set(projectId, afterSeq);
              for (const event of history) {
                sendEvent(conn, event);
              }
            }
            // 不补发（afterSeq=0 且没要 replay）：只要实时事件，缓冲里的都是订阅之后发生的，全部推送
            if (conn.closed || !conn.projects.has(projectId)) return;
            for (const event of conn.buffering.get(projectId) ?? []) sendEvent(conn, event);
            conn.buffering.delete(projectId);
            send(conn, {
              op: 'subscribed',
              projectId,
              latestSeq: Math.max(latestSeq, conn.sentSeq.get(projectId) ?? 0),
            });
            const members = [...(presence.get(projectId)?.values() ?? [])];
            send(conn, { op: 'presence', projectId, members });
          } catch (err) {
            leave(conn, projectId);
            throw err;
          }
          return;
        }
        case 'unsubscribe':
          leave(conn, frame.projectId);
          return;
        case 'presence': {
          if (!conn.projects.has(frame.projectId) || !conn.user) return;
          let map = presence.get(frame.projectId);
          if (!map) presence.set(frame.projectId, (map = new Map()));
          map.set(conn.id, {
            userId: conn.user.id,
            name: conn.user.name,
            avatarColor: conn.user.avatarColor,
            view: frame.view,
            objectId: frame.objectId,
            activity: frame.activity,
            lastSeenAt: new Date().toISOString(),
          });
          broadcastPresence(frame.projectId);
          return;
        }
      }
    }
  });
}
