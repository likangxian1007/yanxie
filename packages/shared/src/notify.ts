import { z } from 'zod';
import { tr } from './i18n';

/**
 * 接入：通知订阅（飞书 / 企业微信 / 钉钉 群机器人）。归属：`modules/notify`。
 *
 * 形态：用户在设置里粘贴一个群机器人 webhook 地址，项目里发生事情时我们把一条【纯文本】
 * 消息 POST 过去，群里就响。
 *
 * 三条安全底线（改之前先读）：
 * 1. **只允许三家官方域名**（见 `NOTIFY_PROVIDERS`）。第一版不做通用 webhook，
 *    这样"填内网地址让我们去打"的风险直接消失。
 * 2. **地址含密钥**（飞书 hook id / 企微 key）。只写不读：接口只回 `urlHint`（打码）。
 * 3. **只发标题 + 一句话 + 链接**，正文不外发；旁聊、个人线程、别人的收件箱绝不外发。
 */

export const NOTIFY_PROVIDERS = {
  feishu: {
    label: tr('飞书'),
    host: 'open.feishu.cn',
    pathPrefix: '/open-apis/bot/v2/hook/',
    /** 每机器人每分钟上限（平台限制），超过会被限流 */
    perMinute: 100,
  },
  wecom: {
    label: tr('企业微信'),
    host: 'qyapi.weixin.qq.com',
    pathPrefix: '/cgi-bin/webhook/send',
    perMinute: 20,
  },
  dingtalk: {
    label: tr('钉钉'),
    host: 'oapi.dingtalk.com',
    pathPrefix: '/robot/send',
    perMinute: 20,
  },
} as const;

export const NotifyProvider = z.enum(['feishu', 'wecom', 'dingtalk']);
export type NotifyProvider = z.infer<typeof NotifyProvider>;

/** 可订阅的事件类型（与 API.md §4 事件表同名） */
export const NOTIFY_EVENTS = [
  'inbox.created',
  'message.created',
  'thread.updated',
  'decision.updated',
  'review.updated',
  'claim.conflict',
  'report.updated',
] as const;
export const NotifyEventType = z.enum(NOTIFY_EVENTS);
export type NotifyEventType = z.infer<typeof NotifyEventType>;

/** 默认只订阅收件箱：@我、请我审阅、决策卡、认领冲突、指派都会进收件箱 */
export const NOTIFY_DEFAULT_EVENTS: NotifyEventType[] = ['inbox.created'];

/** 每人最多几个订阅（够用且防刷） */
export const NOTIFY_MAX_PER_USER = 3;
export const NOTIFY_NAME_MAX = 40;

/** 列表项：永远不含完整地址 */
export const NotifySubscription = z.object({
  id: z.string(),
  name: z.string(),
  provider: NotifyProvider,
  /** 打码后的地址，如 `https://open.feishu.cn/open-apis/bot/v2/hook/8f3a****` */
  urlHint: z.string(),
  /** null = 所有我参与的项目 */
  projectId: z.string().nullable(),
  eventTypes: z.array(NotifyEventType),
  enabled: z.boolean(),
  /** 连续失败次数；到 NOTIFY_DISABLE_AFTER 自动停用 */
  failureStreak: z.number().int(),
  disabledReason: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotifySubscription = z.infer<typeof NotifySubscription>;

export const NotifySubscriptionCreateInput = z.object({
  name: z
    .string({ error: tr('请给这个订阅起个名字') })
    .trim()
    .min(1, { error: tr('请给这个订阅起个名字') })
    .max(NOTIFY_NAME_MAX, { error: tr('名字最多 {NOTIFY_NAME_MAX} 个字', { NOTIFY_NAME_MAX }) }),
  provider: NotifyProvider,
  /** 群机器人地址；密钥部分只写不读 */
  url: z
    .string({ error: tr('请粘贴群机器人地址') })
    .trim()
    .min(1, { error: tr('请粘贴群机器人地址') })
    .max(500),
  projectId: z.string().nullable().default(null),
  eventTypes: z
    .array(NotifyEventType)
    .min(1)
    .max(NOTIFY_EVENTS.length)
    .default(NOTIFY_DEFAULT_EVENTS),
});
export type NotifySubscriptionCreateInput = z.input<typeof NotifySubscriptionCreateInput>;

/** PATCH：只允许改名 / 改事件 / 开关 / 换地址（换地址要重新校验域名） */
export const NotifySubscriptionUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(NOTIFY_NAME_MAX).optional(),
    url: z.string().trim().min(1).max(500).optional(),
    eventTypes: z.array(NotifyEventType).min(1).max(NOTIFY_EVENTS.length).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: tr('没有要修改的内容') });
export type NotifySubscriptionUpdateInput = z.input<typeof NotifySubscriptionUpdateInput>;

export const NOTIFY_DELIVERY_STATUS = ['pending', 'success', 'failed', 'dropped'] as const;
export const NotifyDeliveryStatus = z.enum(NOTIFY_DELIVERY_STATUS);
export type NotifyDeliveryStatus = z.infer<typeof NotifyDeliveryStatus>;

/** 投递记录（面板用） */
export const NotifyDelivery = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  eventType: z.string(),
  /** 发出去的人话摘要（就是飞书里看到的那句） */
  text: z.string(),
  status: NotifyDeliveryStatus,
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotifyDelivery = z.infer<typeof NotifyDelivery>;

/** 重试节奏（秒）：1m / 5m / 30m / 2h / 6h，共 5 次 */
export const NOTIFY_RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21600] as const;
/** 连续失败多少次自动停用订阅 */
export const NOTIFY_DISABLE_AFTER = 20;
/** 单次投递超时 */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** GET /auth/me/notify：`enabled` 是服务端开关（NOTIFY_ENABLED） */
export const NotifyOverview = z.object({
  enabled: z.boolean(),
  subscriptions: z.array(NotifySubscription),
});
export type NotifyOverview = z.infer<typeof NotifyOverview>;
