import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Response } from 'undici';

/**
 * 联网的底层：公网地址守卫 + 带上限的抓取。
 *
 * 防 SSRF 两道关：
 * 1. 请求前解析域名，任一地址落在内网 / 回环 / 链路本地 / ULA / CGNAT / 云元数据段就拒绝（错误信息友好）；
 * 2. 真正建连时 undici 的 connect.lookup 再校验一次实际连接的地址，堵住 DNS rebinding 的窗口。
 * 重定向手动跟随，每一跳都重新过两道关。
 */

export class NetError extends Error {
  constructor(
    message: string,
    readonly code: 'blocked' | 'invalid' | 'timeout' | 'network' | 'too_many_redirects',
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- 地址判定

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/u.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含 169.254.169.254 云元数据）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档示例
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档示例
  ['203.0.113.0', 24], // 文档示例
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留 + 广播
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return V4_BLOCKS.some(([base, bits]) => {
    const b = ipv4ToInt(base)!;
    const size = 2 ** (32 - bits);
    return n >= b && n < b + size;
  });
}

/** 把 IPv6 展开成 8 个 16 位整数；不合法返回 null */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // 末尾内嵌 IPv4（::ffff:1.2.3.4）
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/u.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    if (n === null) return null;
    s = `${s.slice(0, -v4[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function isBlockedV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [a, b, c, d, e, f, g6, h] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g6 === 0 && h === 1)
    return true; // ::1
  // IPv4 映射 / 兼容地址：按内嵌的 IPv4 判断
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    return isBlockedV4(v4of(g6, h));
  }
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (a === 0x2001 && b === 0x0db8) return true; // 文档示例
  if (a === 0x64 && b === 0xff9b) return isBlockedV4(v4of(g6, h)); // NAT64
  if (a === 0x2002) return isBlockedV4(v4of(b, c)); // 6to4
  return false;
}

/** 地址是否属于内网 / 保留地址 */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

// ---------------------------------------------------------------- 守卫

/** 建连时的 lookup：解析出的每个地址都必须是公网地址 */
function guardedLookup(
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
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (list.length === 0 || bad) {
      const e = new Error(`拒绝访问内网或保留地址：${hostname}`) as NodeJS.ErrnoException;
      e.code = 'ESRH_BLOCKED';
      return callback(e, '');
    }
    if (opts.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}

/** 公网专用 dispatcher：所有出站抓取都走它 */
export const publicDispatcher = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 20_000,
});

/** 校验网址：只允许 http/https，主机名解析到的地址都必须是公网 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError(`不是合法的网址：${raw}`, 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetError(`只能抓取 http / https 网址，不支持 ${url.protocol}`, 'invalid');
  }
  if (url.username || url.password) throw new NetError('网址里不能带用户名或密码', 'invalid');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (!host) throw new NetError('网址缺少主机名', 'invalid');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/iu.test(host)) {
    throw new NetError(`拒绝访问内网或保留地址：${host}`, 'blocked');
  }
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    addrs = await new Promise<string[]>((resolve, reject) => {
      dnsLookup(host, { all: true, verbatim: true }, (err, list) => {
        if (err) reject(new NetError(`无法解析域名 ${host}`, 'network'));
        else resolve(list.map((a) => a.address));
      });
    });
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a))) {
    throw new NetError(`拒绝访问内网或保留地址：${host}`, 'blocked');
  }
  return url;
}

export const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SRH-Agent/0.2';

export interface PublicFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

function mapFetchError(err: unknown, url: URL, timeoutMs: number): NetError {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e instanceof NetError) return e;
  if (e.name === 'TimeoutError' || e.name === 'AbortError')
    return new NetError(`抓取超时（${Math.round(timeoutMs / 1000)} 秒）：${url.href}`, 'timeout');
  if (e.cause?.code === 'ESRH_BLOCKED')
    return new NetError(`拒绝访问内网或保留地址：${url.hostname}`, 'blocked');
  return new NetError(`抓取失败：${e.cause?.message ?? e.message}`, 'network');
}

/** 抓取一个公网网址（手动跟随重定向，每一跳都校验）。返回最终的响应与网址 */
export async function fetchPublic(
  raw: string,
  opts: PublicFetchOptions = {},
): Promise<{ res: Response; url: URL }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = await assertPublicUrl(raw);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await undiciFetch(url, {
        method,
        body,
        redirect: 'manual',
        dispatcher: publicDispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...opts.headers,
        },
      });
    } catch (err) {
      throw mapFetchError(err, url, timeoutMs);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects)
        throw new NetError(`重定向超过 ${maxRedirects} 次：${raw}`, 'too_many_redirects');
      url = await assertPublicUrl(new URL(loc, url).href);
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { res, url };
  }
}

/** 读响应体，超过上限就截断 */
export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      capped = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, capped };
}

/**
 * 调用受信任的 API（SearXNG、OpenAlex、Crossref、Semantic Scholar、arXiv）。
 * 这些地址来自配置而不是模型，SearXNG 本身就在内网，所以不走公网守卫；只加超时与体积上限。
 */
export async function fetchApi(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let res: Response;
  try {
    res = await undiciFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...opts.headers },
    });
  } catch (err) {
    throw mapFetchError(err, new URL(url), timeoutMs);
  }
  const { bytes } = await readCapped(res, opts.maxBytes ?? 4 * 1024 * 1024);
  return {
    status: res.status,
    text: new TextDecoder('utf-8').decode(bytes),
    headers: res.headers as unknown as Headers,
  };
}
