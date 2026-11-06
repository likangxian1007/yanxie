import {
  WS_CLOSE,
  WS_PATH,
  WS_PING_INTERVAL_MS,
  type ClientFrameInput,
  type ServerFrame,
} from '@srh/shared';
import { withBase } from './base-path';
import { SeqCursors } from './realtime-cursor';

/**
 * 应用实时通道（/ws）的小型客户端：
 * - 自动重连：指数退避（0.5s 起，上限 10s，带少量抖动）
 * - 心跳：每 WS_PING_INTERVAL_MS 发 ping；超过 1.8 倍间隔没有任何消息视为断线
 * - 订阅：`subscribe(projectId, lowerBound)` 会被记住，服务端从下界补发；重连后用最新 seq 重新订阅
 *   （seq 记账见 realtime-cursor.ts）
 * - 监听：`on('event', handler)` 返回取消函数
 *
 * 单例 `realtime` 不会自动连接；进入项目页时由调用方 `realtime.connect()`。
 */

export type ServerOp = ServerFrame['op'];
export type FrameOf<Op extends ServerOp> = Extract<ServerFrame, { op: Op }>;
export type FrameHandler<Op extends ServerOp> = (frame: FrameOf<Op>) => void;

export type RealtimeStatus =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';

export interface RealtimeClientOptions {
  /** 完整 ws(s):// 地址；默认同源 WS_PATH */
  url?: string;
  /** 便于测试注入 */
  WebSocketImpl?: typeof WebSocket;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
}

const BASE_BACKOFF_MS = 500;

export function defaultWsUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${withBase(WS_PATH)}`;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private readonly cursors = new SeqCursors();
  private readonly listeners = new Map<ServerOp, Set<(frame: ServerFrame) => void>>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private shouldRun = false;
  private _status: RealtimeStatus = 'idle';

  private readonly options: Required<Omit<RealtimeClientOptions, 'url' | 'WebSocketImpl'>> &
    Pick<RealtimeClientOptions, 'url' | 'WebSocketImpl'>;

  constructor(options: RealtimeClientOptions = {}) {
    this.options = {
      pingIntervalMs: WS_PING_INTERVAL_MS,
      maxBackoffMs: 10_000,
      ...options,
    };
  }

  get status(): RealtimeStatus {
    return this._status;
  }

  connect(): void {
    this.shouldRun = true;
    if (this.socket && this.socket.readyState <= 1) return;
    this.open();
  }

  disconnect(): void {
    this.shouldRun = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= 1) socket.close(1000, 'client disconnect');
    this.setStatus('closed');
  }

  /**
   * 订阅项目事件。`lowerBound` 是不晚于本地数据的 seq（如 /auth/me 的 eventSeq），
   * 服务端会补发它之后的事件；重连后自动用已处理的最大 seq 重新订阅。
   */
  subscribe(projectId: string, lowerBound?: number): void {
    const args = this.cursors.begin(projectId, lowerBound);
    this.send({ op: 'subscribe', projectId, ...args });
  }

  unsubscribe(projectId: string): void {
    if (!this.cursors.end(projectId)) return;
    this.send({ op: 'unsubscribe', projectId });
  }

  /** 某项目已处理到的 seq（测试与调试用）。 */
  seqOf(projectId: string): number | null | undefined {
    return this.cursors.seqOf(projectId);
  }

  /** 发送一帧；未连接时静默丢弃（订阅信息会在重连时补发）。 */
  send(frame: ClientFrameInput): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  on<Op extends ServerOp>(op: Op, handler: FrameHandler<Op>): () => void {
    let set = this.listeners.get(op);
    if (!set) {
      set = new Set();
      this.listeners.set(op, set);
    }
    const wrapped = handler as (frame: ServerFrame) => void;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  onStatus(handler: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  // ---------------------------------------------------------------- 内部

  private open(): void {
    const Impl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new Impl(this.options.url ?? defaultWsUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus('open');
      for (const [projectId, args] of this.cursors.entries()) {
        this.send({ op: 'subscribe', projectId, ...args });
      }
      this.startHeartbeat();
    });

    socket.addEventListener('message', (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      this.armWatchdog();
      if (typeof ev.data !== 'string') return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      if (this.track(frame)) this.emit(frame);
    });

    socket.addEventListener('close', (ev: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (ev.code === WS_CLOSE.unauthorized || ev.code === WS_CLOSE.forbidden) {
        this.shouldRun = false;
        this.setStatus('unauthorized');
        return;
      }
      if (this.shouldRun) this.scheduleReconnect();
      else this.setStatus('closed');
    });
  }

  /**
   * 记录每个项目已处理的最大 seq，重连时用来补拉；返回 false 表示重复事件，不再分发。
   * 服务端保证同一项目的事件按 seq 递增推送（见 apps/server/src/realtime/ws.ts）。
   */
  private track(frame: ServerFrame): boolean {
    if (frame.op === 'event') return this.cursors.onEvent(frame.event.projectId, frame.event.seq);
    if (frame.op === 'subscribed' || frame.op === 'resync') {
      // subscribed：≤ latestSeq 的都已补发，之后从这里继续（重连时据此补拉断线期间的事件）
      // resync：缺口太大，调用方会整体重拉 REST，之后从最新 seq 继续
      this.cursors.onCaughtUp(frame.projectId, frame.latestSeq);
    }
    return true;
  }

  private emit(frame: ServerFrame): void {
    const set = this.listeners.get(frame.op);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(frame);
      } catch (err) {
        console.error('[realtime] 处理消息出错', err);
      }
    }
  }

  private startHeartbeat(): void {
    this.armWatchdog();
    this.pingTimer = setInterval(() => {
      this.send({ op: 'ping' });
    }, this.options.pingIntervalMs);
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(
      () => {
        // 太久没有任何消息：主动断开，走重连流程
        this.socket?.close(4000, 'heartbeat timeout');
      },
      Math.round(this.options.pingIntervalMs * 1.8),
    );
  }

  private scheduleReconnect(): void {
    const exp = BASE_BACKOFF_MS * 2 ** this.attempt;
    const delay = Math.min(this.options.maxBackoffMs, exp) * (0.85 + Math.random() * 0.3);
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(
      () => {
        if (this.shouldRun) this.open();
      },
      Math.round(Math.min(delay, this.options.maxBackoffMs)),
    );
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.watchdogTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setStatus(status: RealtimeStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const handler of [...this.statusListeners]) handler(status);
  }
}

/** 全局单例：不自动连接。 */
export const realtime = new RealtimeClient();
