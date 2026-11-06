import { NOTIFY_PROVIDERS, NOTIFY_TIMEOUT_MS, type NotifyProvider } from '@srh/shared';

/**
 * 群机器人的消息组装与发送（`modules/notify`）。
 *
 * 只支持三家官方域名，所以**不需要**走公网守卫（`websearch/net.ts` 的 fetchPublic）：
 * 地址在建订阅时就已经被 `assertAllowedUrl` 限定在官方域名上了。若以后放开"任意地址"，
 * 必须改成走 fetchPublic，否则等于给服务器装了一个能打内网的工具。
 */

/** 三种平台的消息体（都是纯文本，最稳） */
export function buildMessage(provider: NotifyProvider, text: string): Record<string, unknown> {
  switch (provider) {
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'wecom':
      return { msgtype: 'text', text: { content: text } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
  }
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** 响应体前 500 字，排查"格式错了""被限流"就靠它 */
  snippet: string;
  error?: string;
}

/**
 * 判断这一发到底成没成。
 *
 * 三家平台在"参数错 / 被限流 / 关键词不匹配 / 签名校验失败"时**照样返回 HTTP 200**，
 * 真正的结果在 body 的 `code` / `StatusCode` / `errcode` 里。所以这里的规则是：
 * **必须能解析出 JSON 且平台返回码明确为 0**，否则一律按失败处理（继续重试）。
 * 空响应、被网关替换成 HTML 错误页、缺返回码，都算失败——宁可多试几次，也不要误报成功。
 */
export function parsePlatformResponse(
  provider: NotifyProvider,
  httpStatus: number,
  rawText: string,
): { ok: boolean; reason?: string } {
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, reason: `HTTP ${httpStatus}` };
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: '响应不是 JSON（可能被网关或代理拦截）' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '响应不是平台约定的对象格式' };
  }
  const obj = body as Record<string, unknown>;
  const keys = provider === 'feishu' ? ['code', 'StatusCode'] : ['errcode', 'code'];
  const codes = keys
    .map((k) => obj[k])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (codes.length === 0) return { ok: false, reason: '响应里没有平台返回码' };
  const bad = codes.find((v) => v !== 0);
  if (bad !== undefined) return { ok: false, reason: `平台返回失败码 ${bad}` };
  return { ok: true };
}

/** 测试用：替换真实发送（返回假的 SendResult），不注入就走真实 fetch */
type Sender = (url: string, payload: Record<string, unknown>) => Promise<SendResult>;
let senderOverride: Sender | null = null;

export function setNotifySenderForTest(sender: Sender | null): void {
  senderOverride = sender;
}

/** 发送一条消息到群机器人地址（10 秒超时） */
export async function postWebhook(
  url: string,
  payload: Record<string, unknown>,
  provider: NotifyProvider,
): Promise<SendResult> {
  if (senderOverride) return senderOverride(url, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text();
    const snippet = raw.slice(0, 500);
    const verdict = parsePlatformResponse(provider, res.status, raw);
    if (verdict.ok) return { ok: true, status: res.status, snippet };
    return {
      ok: false,
      status: res.status,
      snippet,
      error: `${verdict.reason ?? '发送失败'}${snippet ? `（平台返回：${snippet.slice(0, 160)}）` : ''}`,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时（10 秒）'
          : err.message
        : String(err);
    return { ok: false, status: 0, snippet: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** 飞书/企微/钉钉 三家都是"文本消息"，摘要就是这句话 */
export function describeProvider(provider: NotifyProvider): string {
  return NOTIFY_PROVIDERS[provider].label;
}
