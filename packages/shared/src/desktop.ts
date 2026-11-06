/** @deprecated 云电脑功能已移除。本文件仅保留历史协议类型兼容，不再提供运行时能力。 */
import { z } from 'zod';

/**
 * 共享云电脑（每个项目一台隔离的 Linux 桌面容器，浏览器里用 noVNC 观看与操作）。
 * 归属：云电脑线程。REST 见 API.md §2.14，实现在 apps/server/src/modules/desktops。
 *
 * 控制模型：
 * - mode=turns（轮流操作）：同一时刻只有 controller 能输入；其他人只能看。
 * - mode=free（同时操作）：所有非访客成员都能输入；controller 只用来表示「谁接管了」（agent 暂停）。
 * - agent 操作时 controller 临时变成 agent（租约，最后一次操作后 60 秒自动释放）；
 *   人任何时候都可以「接管」agent，之后 agent 的工具返回错误，直到人交还控制。
 * - 访客（guest）永远只读。服务端在 VNC 代理里逐条丢弃无权连接的键盘/鼠标/剪贴板消息。
 */

export const DESKTOP_STATUSES = [
  /** DESKTOP_ENABLED=false */
  'disabled',
  /** 已启用但 Docker 不可达或镜像不存在 */
  'unavailable',
  /** 已创建过、容器停止（休眠）；或从未启动 */
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
] as const;
export type DesktopStatus = (typeof DESKTOP_STATUSES)[number];

export const DESKTOP_MODES = ['turns', 'free'] as const;
export const DesktopMode = z.enum(DESKTOP_MODES);
export type DesktopMode = z.infer<typeof DesktopMode>;

export const DesktopController = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string(),
    name: z.string(),
    avatarColor: z.number().int(),
    since: z.string(),
  }),
  z.object({
    kind: z.literal('agent'),
    sessionId: z.string(),
    /** 显示名：「张三的 agent」 */
    name: z.string(),
    threadId: z.string().nullable(),
    since: z.string(),
  }),
]);
export type DesktopController = z.infer<typeof DesktopController>;

export const DesktopViewer = z.object({
  userId: z.string(),
  name: z.string(),
  avatarColor: z.number().int(),
  /** 同一个人开了几个标签页 */
  connections: z.number().int(),
  canInput: z.boolean(),
  since: z.string(),
});
export type DesktopViewer = z.infer<typeof DesktopViewer>;

export const DesktopLimits = z.object({
  memoryMb: z.number(),
  cpus: z.number(),
  idleMinutes: z.number(),
  maxRunning: z.number().int(),
  screen: z.object({ width: z.number().int(), height: z.number().int() }),
});
export type DesktopLimits = z.infer<typeof DesktopLimits>;

export const DesktopState = z.object({
  projectId: z.string(),
  status: z.enum(DESKTOP_STATUSES),
  /** status 为 unavailable / error 时的中文原因 */
  message: z.string().nullable(),
  mode: DesktopMode,
  controller: DesktopController.nullable(),
  /** 轮流模式下有人申请控制 */
  pendingRequest: z
    .object({ userId: z.string(), name: z.string(), avatarColor: z.number().int(), at: z.string() })
    .nullable(),
  viewers: z.array(DesktopViewer),
  limits: DesktopLimits,
  /** 本服务器上正在运行的云电脑台数（含本项目） */
  runningCount: z.number().int(),
  startedAt: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  /** 预计自动休眠时间（没人看、agent 也没操作时才有） */
  sleepsAt: z.string().nullable(),
});
export type DesktopState = z.infer<typeof DesktopState>;

/** GET 状态时额外返回的「我」相关字段 */
export const DesktopStateForMe = DesktopState.extend({
  me: z.object({
    role: z.string(),
    /** 能启动、休眠、切换模式、申请/接管控制（非访客） */
    canOperate: z.boolean(),
    /** 当前能否向桌面输入 */
    canInput: z.boolean(),
  }),
});
export type DesktopStateForMe = z.infer<typeof DesktopStateForMe>;

export const DesktopStats = z.object({
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  pids: z.number(),
});
export type DesktopStats = z.infer<typeof DesktopStats>;

export const DESKTOP_CONTROL_ACTIONS = ['take', 'release', 'request', 'handoff', 'deny'] as const;
export const DesktopControlInput = z.object({
  action: z.enum(DESKTOP_CONTROL_ACTIONS),
  /** handoff：交给谁 */
  userId: z.string().optional(),
});
export type DesktopControlInput = z.infer<typeof DesktopControlInput>;

export const DesktopSettingsInput = z.object({ mode: DesktopMode });
export type DesktopSettingsInput = z.infer<typeof DesktopSettingsInput>;

/** 「直接输入」：由服务端用 xdotool 在桌面上打字（支持中文），需要当前有输入权限 */
export const DesktopTypeInput = z.object({
  text: z.string().min(1).max(4000),
  enter: z.boolean().optional(),
});
export type DesktopTypeInput = z.infer<typeof DesktopTypeInput>;

export const DESKTOP_ACTIVITY_KINDS = [
  'start',
  'screenshot',
  'click',
  'type',
  'key',
  'scroll',
  'exec',
  'open_url',
  'stop',
] as const;
export type DesktopActivityKind = (typeof DESKTOP_ACTIVITY_KINDS)[number];

/** agent 在云电脑上的一次操作（瞬时事件 desktop.activity，前端画点击涟漪与活动条） */
export const DesktopActivity = z.object({
  id: z.string(),
  kind: z.enum(DESKTOP_ACTIVITY_KINDS),
  /** 一句话中文说明：「点击 (812, 344)」「输入 “graph contrastive”」 */
  summary: z.string(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  /** 输入的文字 / 命令 / 网址（截断到 500 字） */
  text: z.string().nullable(),
  /** 截图保存到项目文件里的 id 与路径 */
  fileId: z.string().nullable(),
  filePath: z.string().nullable(),
  actor: z.object({ sessionId: z.string(), name: z.string(), threadId: z.string().nullable() }),
  ok: z.boolean(),
  at: z.string(),
});
export type DesktopActivity = z.infer<typeof DesktopActivity>;

export const DESKTOP_EPHEMERAL_PAYLOADS = {
  /** 云电脑状态 / 控制权 / 观看者变化 */
  'desktop.updated': DesktopState,
  'desktop.activity': DesktopActivity,
} as const;

/** VNC WebSocket 的关闭码 */
export const DESKTOP_WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  /** 云电脑没有在运行 */
  notRunning: 4409,
  /** 客户端发来了无法识别的 RFB 消息 */
  protocol: 4400,
  /** 云电脑被休眠 / 停止 */
  stopped: 4410,
} as const;
