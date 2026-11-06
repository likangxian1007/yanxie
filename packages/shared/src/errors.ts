import { z } from 'zod';

/**
 * REST 错误响应统一形状：
 *   HTTP 4xx/5xx + { "error": { "code": "...", "message": "中文可读说明", "details"?: {...} } }
 * message 直接给用户看，写中文；code 给程序判断。
 */
export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  /** 唯一约束、状态不允许等 */
  conflict: 409,
  /** 乐观并发：基于的版本已过期，details.current 带最新对象 */
  version_conflict: 409,
  /** 认领冲突：资源已被他人独占认领，details.claims 带冲突的认领 */
  claim_conflict: 409,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  llm_unavailable: 503,
  /** 上传内容过大（反馈截图单张超限等） */
  payload_too_large: 413,
  /** 上传类型不允许（反馈附件只收图片） */
  unsupported_media_type: 415,
  /** 按量计费：余额不足（<= 0），需先充值 */
  insufficient_credits: 402,
  /** 在线支付未配置（服务器没有 KYREN_API_KEY） */
  payment_unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
