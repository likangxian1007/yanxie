import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { assertPublicUrl, isBlockedAddress, NetError } from '../../websearch/net';

/**
 * MCP（HTTP / SSE）出站网络：防 SSRF + 把底层网络错误翻译成看得懂的中文。
 *
 * 防 SSRF 三道关：
 * 1. 保存时 assertPublicUrl：主机名解析出的地址必须全是公网（拒绝回环 / 内网 / 链路本地 / 云元数据 / ULA）；
 * 2. 每次请求前再过一遍 assertPublicUrl（IP 字面量不走 DNS，只能在这里拦；域名也顺便重查）；
 * 3. 真正建连时 dispatcher 的 connect.lookup 校验实际连接的地址，堵住 DNS rebinding 的窗口。
 * 重定向交给 SDK 的同源跟随，每一跳都会重新调用 mcpFetch，同样过这三道关。
 *
 * 错误信息只描述原因（DNS / 拒绝连接 / 超时 / TLS / HTTP 状态码），不回显对方响应体。
 */

export const MCP_BLOCKED_MESSAGE = 'MCP 地址不能指向内网或本机地址';

export type McpNetErrorKind =
  | 'blocked'
  | 'invalid'
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'reset'
  | 'unreachable'
  | 'tls'
  | 'http'
  | 'network';

/**
 * 已翻译好的网络错误。
 * 注意：故意不设 `cause`——eventsource 会把 cause 链拼进错误文本（"McpNetError: …: TypeError: fetch failed: …"），
 * 原始错误放在不可枚举的 `original` 里方便排查。
 */
export class McpNetError extends Error {
  declare readonly original: unknown;
  constructor(
    message: string,
    readonly kind: McpNetErrorKind,
    original?: unknown,
  ) {
    super(message);
    this.name = 'McpNetError';
    Object.defineProperty(this, 'original', { value: original, enumerable: false });
  }
}

// ---------------------------------------------------------------- 地址校验

/** 校验 MCP 地址：http(s)、不带账号密码、解析出的地址全是公网。失败抛 McpNetError */
export async function checkMcpUrl(raw: string): Promise<URL> {
  try {
    return await assertPublicUrl(raw);
  } catch (err) {
    if (err instanceof NetError) {
      if (err.code === 'blocked') throw new McpNetError(MCP_BLOCKED_MESSAGE, 'blocked', err);
      if (err.code === 'network') {
        let host = raw;
        try {
          host = new URL(raw).hostname;
        } catch {
          /* 保持原文 */
        }
        throw new McpNetError(`找不到这个域名：${host}`, 'dns', err);
      }
      throw new McpNetError(
        '请填写 http(s) 开头的合法服务器地址（地址里不能带用户名或密码）',
        'invalid',
        err,
      );
    }
    throw err;
  }
}

/** 建连时的 lookup：解析出的每个地址都必须是公网地址（DNS rebinding 防护） */
export function mcpGuardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  const opts = typeof options === 'number' ? { family: options } : (options ?? {});
  dnsLookup(hostname, { ...opts, all: true, verbatim: true } as never, (err, addrs) => {
    if (err) return callback(err, '');
    const list = addrs as unknown as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      const e = new Error(`${MCP_BLOCKED_MESSAGE}：${hostname}`) as NodeJS.ErrnoException;
      e.code = 'ESRH_BLOCKED';
      return callback(e, '');
    }
    if (opts.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}

/**
 * MCP 专用 dispatcher。不能复用 websearch 的 publicDispatcher：那个的 headersTimeout 15 秒 / bodyTimeout 20 秒
 * 会掐断耗时的工具调用和长连的 SSE 流。整体超时由 manager 的 withTimeout / SDK 的请求超时负责。
 */
export const mcpDispatcher = new Agent({
  connect: { lookup: mcpGuardedLookup as never, timeout: 10_000 },
  headersTimeout: 90_000,
  bodyTimeout: 0,
});

/** 交给 MCP SDK 的 fetch：每次请求先校验地址，再经带地址守卫的 dispatcher 发出；网络错误翻译成中文 */
export async function mcpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = await checkMcpUrl(typeof input === 'string' ? input : input.href);
  try {
    const res = await undiciFetch(url, {
      ...(init as object),
      // 重定向由 SDK 手动、同源地跟随（每一跳都重新走 mcpFetch）
      redirect: 'manual',
      dispatcher: mcpDispatcher,
    } as never);
    return res as unknown as Response;
  } catch (err) {
    // 主动中止（关闭连接 / 取消调用）原样抛出，SDK 与 eventsource 靠 name 判断
    if ((err as Error | undefined)?.name === 'AbortError') throw err;
    const info = classifyMcpError(err);
    throw new McpNetError(info.message, info.kind, err);
  }
}

// ---------------------------------------------------------------- 错误翻译

/** 展开 err.cause / AggregateError.errors 链（undici: TypeError('fetch failed') → cause: ECONNREFUSED …） */
function errorChain(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length && out.length < 16) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    const rec = e as Record<string, unknown>;
    out.push(rec);
    if (rec.original) queue.push(rec.original);
    if (rec.cause) queue.push(rec.cause);
    if (Array.isArray(rec.errors)) queue.push(...(rec.errors as unknown[]));
  }
  return out;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ESOCKETTIMEDOUT',
]);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN']);

function isTlsCode(code: string): boolean {
  return (
    code === 'EPROTO' ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') ||
    code.startsWith('UNABLE_TO_') ||
    code.includes('SELF_SIGNED') ||
    code === 'HOSTNAME_MISMATCH'
  );
}

/** 从文本里认错误码（SSE 传输经 eventsource 只留下拼好的字符串） */
const CODE_IN_TEXT =
  /\b(ESRH_BLOCKED|ENOTFOUND|EAI_AGAIN|EAI_NONAME|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|EPROTO|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\b/u;
const HAS_CJK = /[\u4e00-\u9fff]/u;

function fromCode(code: string): { kind: McpNetErrorKind; message: string } | null {
  if (code === 'ESRH_BLOCKED') return { kind: 'blocked', message: MCP_BLOCKED_MESSAGE };
  if (DNS_CODES.has(code))
    return { kind: 'dns', message: `找不到这个域名，请检查地址拼写（${code}）` };
  if (code === 'ECONNREFUSED')
    return { kind: 'refused', message: '连接被拒绝：对方没有在这个端口提供服务（ECONNREFUSED）' };
  if (TIMEOUT_CODES.has(code)) return { kind: 'timeout', message: `连接超时（${code}）` };
  if (RESET_CODES.has(code)) return { kind: 'reset', message: `连接被对方中断（${code}）` };
  if (UNREACHABLE_CODES.has(code)) return { kind: 'unreachable', message: `网络不可达（${code}）` };
  if (isTlsCode(code))
    return { kind: 'tls', message: `TLS 安全连接失败：证书无效或协议不匹配（${code}）` };
  return null;
}

function httpMessage(status: number): string {
  const hint =
    status === 401
      ? '：未授权，请检查请求头里的鉴权信息'
      : status === 403
        ? '：没有权限'
        : status === 404
          ? '：找不到这个路径，请检查地址（常见结尾是 /mcp 或 /sse）'
          : status === 405
            ? '：不支持这种请求方式，传输方式（HTTP / SSE）可能选错了'
            : status >= 300 && status < 400
              ? '：重定向到了其他站点，没有跟随'
              : status >= 500
                ? '：对方服务器内部错误'
                : '';
  return `服务器返回 HTTP ${status}${hint}`;
}

/** 把连接 / 列工具 / 调用失败的错误归类成中文原因（不回显响应体） */
export function classifyMcpError(err: unknown): { kind: McpNetErrorKind; message: string } {
  const chain = errorChain(err);
  // 已翻译过的
  for (const e of chain) if (e instanceof McpNetError) return { kind: e.kind, message: e.message };
  // 错误码（系统 / undici）
  for (const e of chain) {
    if (typeof e.code === 'string') {
      const hit = fromCode(e.code);
      if (hit) return hit;
    }
  }
  for (const e of chain) {
    if (e.name === 'TimeoutError') return { kind: 'timeout', message: '连接超时' };
  }
  // HTTP 状态码：StreamableHTTPError / SseError 的 code；SSE 的 POST 只在文本里带 "(HTTP 401)"
  for (const e of chain) {
    if (typeof e.code === 'number' && e.code >= 100 && e.code <= 599)
      return { kind: 'http', message: httpMessage(e.code) };
  }
  const texts = chain.map((e) => (typeof e.message === 'string' ? e.message : ''));
  for (const t of texts) {
    const m = /\(HTTP (\d{3})\)|Non-200 status code \((\d{3})\)/u.exec(t);
    if (m) return { kind: 'http', message: httpMessage(Number(m[1] ?? m[2])) };
  }
  for (const t of texts) {
    const m = CODE_IN_TEXT.exec(t);
    if (m) {
      const hit = fromCode(m[1]!);
      if (hit) return hit;
    }
  }
  const top = chain[0];
  const topMsg = texts[0] ?? '';
  // SSE 传输：eventsource 把我们抛出的中文原因拼成 "SSE error: …"
  if (topMsg.startsWith('SSE error: ') && HAS_CJK.test(topMsg))
    return { kind: 'network', message: topMsg.slice('SSE error: '.length).slice(0, 300) };
  if (top && typeof top.code === 'number' && top.code === -1 && /content type/iu.test(topMsg))
    return { kind: 'http', message: '服务器返回的内容类型不对，这个地址可能不是 MCP 服务' };
  // MCP 协议层的请求超时（JSON-RPC -32001）
  if (top && top.code === -32001) return { kind: 'timeout', message: '请求超时' };
  // 自己产生的中文信息（withTimeout 等）原样保留
  if (HAS_CJK.test(topMsg)) return { kind: 'network', message: topMsg.slice(0, 300) };
  if (/fetch failed|network|socket/iu.test(topMsg) || !topMsg)
    return { kind: 'network', message: '网络请求失败' };
  // 其它（协议错误等）：只取第一行、限制长度
  return { kind: 'network', message: topMsg.split('\n')[0]!.slice(0, 300) };
}

export function describeMcpError(err: unknown): string {
  return classifyMcpError(err).message;
}
