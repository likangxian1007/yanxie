import { z } from 'zod';
import { type PresenceState } from './entities';
import type { AnyProjectEvent, EphemeralPayload, EphemeralType } from './events';

/**
 * 应用 WebSocket 协议（路径 /ws）。协同文档另走 /collab（Yjs / Hocuspocus 协议）。
 *
 * 连接：浏览器自动带上会话 Cookie；服务端鉴权后发 `ready`。
 * 订阅：进入项目页时 `subscribe { projectId, afterSeq }`，服务端先补发 seq > afterSeq 的事件，
 *       再实时推送；若缺口太大（> 1000 条）发 `resync`，客户端改为整体重拉 REST。
 * 心跳：客户端每 25s 发 `ping`，服务端回 `pong`；45s 无消息即断开重连（指数退避，上限 10s）。
 */

export const WS_PATH = '/ws';
export const COLLAB_PATH = '/collab';
export const WS_RESYNC_THRESHOLD = 1000;
export const WS_PING_INTERVAL_MS = 25_000;

// ---------------------------------------------------------------- 客户端 → 服务端

export const ClientFrame = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ping') }),
  z.object({
    op: z.literal('subscribe'),
    projectId: z.string(),
    /** 客户端已有的最大 seq；首次进入传 0 表示只要实时事件 */
    afterSeq: z.number().int().min(0).default(0),
    /**
     * true：afterSeq 是客户端数据的下界（如 /auth/me 的 eventSeq），即使为 0 也补发
     * seq > afterSeq 的事件。不传时沿用旧语义（afterSeq=0 只要实时事件）。
     */
    replay: z.boolean().optional(),
  }),
  z.object({ op: z.literal('unsubscribe'), projectId: z.string() }),
  z.object({
    op: z.literal('presence'),
    projectId: z.string(),
    view: z.string(),
    objectId: z.string().nullable().default(null),
    activity: z.enum(['viewing', 'typing', 'editing']).default('viewing'),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
export type ClientFrameInput = z.input<typeof ClientFrame>;

// ---------------------------------------------------------------- 服务端 → 客户端

export type ServerFrame =
  | { op: 'ready'; userId: string | null; serverTime: string }
  | { op: 'pong' }
  | { op: 'subscribed'; projectId: string; latestSeq: number }
  | { op: 'event'; event: AnyProjectEvent }
  | {
      op: 'ephemeral';
      projectId: string;
      type: EphemeralType;
      payload: EphemeralPayload<EphemeralType>;
    }
  | { op: 'presence'; projectId: string; members: z.infer<typeof PresenceState>[] }
  | { op: 'resync'; projectId: string; latestSeq: number }
  | { op: 'error'; code: string; message: string };

/** WebSocket close code（4000–4999 为应用自定义）。 */
export const WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  notImplemented: 4501,
  serverShutdown: 4503,
} as const;
