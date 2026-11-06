import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * KyrenPay 客户端。要点：
 * 1. 原生 REST 信封 {code:0, data}，code 0 才是成功（易支付兼容层相反，不用它）
 * 2. 金额是美元十进制字符串（"5.00"），进出都按整数分换算，不碰浮点
 * 3. 金额绑在商品上：建收银台只传 productId，所以每个充值包一个商品（懒创建）
 * 4. webhook 里没有 checkout id，只能靠建单时塞进 metadata.ref 的我们自己的订单号
 * 5. 没有沙箱：任何建单都是真单
 */

const TIMEOUT_MS = 15_000;
/** webhook 时间戳窗口（毫秒），超出按重放拒绝 */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** "5" / "9.99" → 500 / 999（分）；字符串解析，不碰浮点 */
export function dollarsToCents(price: string | number): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(String(price).trim());
  if (!m) throw new Error(`invalid amount: ${String(price)}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export class KyrenError extends Error {
  status: number;
  code: unknown;
  body: unknown;
  constructor(msg: string, opts: { status: number; code?: unknown; body?: unknown }) {
    super(msg);
    this.name = 'KyrenError';
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

export interface KyrenCheckout {
  id: string;
  status?: string;
  orderId?: string | null;
  amount?: string;
  currency?: string;
  url: string;
}

export interface KyrenOrder {
  id: string;
  status?: string;
  productId?: string;
  amount?: string;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface KyrenProduct {
  id: string;
  name?: string;
  price?: string;
  currency?: string;
  metadata?: Record<string, unknown> | null;
}

export interface KyrenEvent {
  id: string;
  type: string;
  data: {
    order_id?: string;
    product_id?: string;
    amount?: string;
    currency?: string;
    refund_id?: string;
    refunded_amount?: string;
    original_amount?: string;
    metadata?: Record<string, unknown> | null;
    [k: string]: unknown;
  };
}

export interface KyrenClient {
  createCheckout(input: {
    productId: string;
    successUrl: string;
    cancelUrl?: string;
    email?: string;
    merchantName?: string;
    ref: string;
    metadata?: Record<string, string>;
  }): Promise<KyrenCheckout>;
  retrieveCheckout(id: string): Promise<KyrenCheckout>;
  retrieveOrder(id: string): Promise<KyrenOrder>;
  listProducts(): Promise<KyrenProduct[]>;
  createProduct(input: {
    name: string;
    description: string;
    price: string;
    currency: string;
    metadata: Record<string, string>;
  }): Promise<KyrenProduct>;
}

/**
 * 验 webhook 签名：HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → `sha256=<hex>`，
 * 时间戳（毫秒）必须在 5 分钟内；定长比较。rawBody 必须是原始字节，不能 parse 后再 stringify。
 * 失败抛错；成功返回解析后的事件。
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): KyrenEvent {
  if (!secret) throw new Error('webhook secret not configured');
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const sig = one(headers['x-kyren-signature']);
  const ts = one(headers['x-kyren-timestamp']);
  if (!sig || !ts) throw new Error('missing signature headers');
  const age = Math.abs(now - Number(ts));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_MS) throw new Error('stale timestamp');
  const expect = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
  const event = JSON.parse(rawBody) as KyrenEvent;
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string')
    throw new Error('malformed event');
  event.data ??= {};
  return event;
}

/** 测试与对端联调用：按同样算法签名 */
export function signWebhook(secret: string, rawBody: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function makeKyrenClient(opts: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): KyrenClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/u, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(base + path, {
        method,
        headers: {
          'x-api-key': opts.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (err) {
      throw new KyrenError(`${method} ${path} failed: ${(err as Error).message}`, { status: 0 });
    } finally {
      clearTimeout(timer);
    }
    type Envelope = { code?: unknown; message?: string; data?: unknown };
    const json = ((): Envelope | null => {
      try {
        return JSON.parse(text) as Envelope;
      } catch {
        return null; // 非 JSON，下面按状态码报错
      }
    })();
    if (!res.ok)
      throw new KyrenError(
        `${method} ${path} → HTTP ${res.status}: ${json?.message ?? text.slice(0, 200)}`,
        { status: res.status, code: json?.code, body: json },
      );
    if (!json || json.code !== 0)
      throw new KyrenError(`${method} ${path} code=${String(json?.code)}`, {
        status: res.status,
        code: json?.code,
        body: json,
      });
    return json.data as T;
  }

  return {
    createCheckout(input) {
      return call<KyrenCheckout>('POST', '/v1/checkouts', {
        productId: input.productId,
        successUrl: input.successUrl,
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.email ? { customerEmail: input.email } : {}),
        ...(input.merchantName ? { displayMerchantName: input.merchantName.slice(0, 80) } : {}),
        metadata: { ...(input.metadata ?? {}), ref: input.ref },
      });
    },
    retrieveCheckout(id) {
      return call<KyrenCheckout>('GET', `/v1/checkouts/${encodeURIComponent(id)}`);
    },
    retrieveOrder(id) {
      return call<KyrenOrder>('GET', `/v1/orders/${encodeURIComponent(id)}`);
    },
    async listProducts() {
      const data = await call<{ items?: KyrenProduct[] } | KyrenProduct[]>('GET', '/v1/products');
      return Array.isArray(data) ? data : (data?.items ?? []);
    },
    createProduct(input) {
      return call<KyrenProduct>('POST', '/v1/products', input);
    },
  };
}
