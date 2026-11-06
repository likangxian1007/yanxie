import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress } from '../../agents/tools/web';

/**
 * 文献库的出站请求：统一 UA（带联系邮箱，Crossref / OpenAlex 的“礼貌池”要求）、超时、
 * 大小上限；用户给的 PDF 链接要做 SSRF 检查（拒绝内网地址，逐跳检查重定向）。
 */

export class FetchError extends Error {
  constructor(
    message: string,
    /** 可以稍后重试（网络错误、超时、429、5xx） */
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function userAgent(mailto: string): string {
  return `SRH-Library/0.1 (research collaboration platform${mailto ? `; mailto:${mailto}` : ''})`;
}

export interface FetchOpts {
  mailto: string;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  /** 覆盖默认 User-Agent（有的仓储只给浏览器样式的 UA 返回 PDF） */
  userAgent?: string;
  /** 用户提供的地址：检查是否为公网地址 */
  guard?: boolean;
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`只支持 http / https 链接：${url.href}`, false);
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new FetchError(`无法解析域名 ${host}`, true);
      });
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new FetchError(`拒绝访问内网或保留地址：${host}`, false);
  }
}

/** GET 并读出全部字节（有上限）。非 2xx 抛 FetchError（404 等不可重试） */
export async function fetchBytes(
  raw: string,
  opts: FetchOpts,
): Promise<{ bytes: Buffer; contentType: string; url: string }> {
  let url = new URL(raw);
  const timeout = opts.timeoutMs ?? 30_000;
  const max = opts.maxBytes ?? 30 * 1024 * 1024;
  for (let hop = 0; hop < 6; hop += 1) {
    if (opts.guard) await assertPublic(url);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: opts.guard ? 'manual' : 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: {
          'user-agent': opts.userAgent ?? userAgent(opts.mailto),
          accept: opts.accept ?? '*/*',
        },
      });
    } catch (err) {
      const name = (err as Error).name;
      throw new FetchError(
        name === 'TimeoutError' || name === 'AbortError'
          ? `请求超时：${url.host}`
          : `网络错误：${url.host}（${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message}）`,
        true,
      );
    }
    if (opts.guard && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new FetchError(
        `${url.host} 返回 HTTP ${res.status}`,
        res.status === 429 || res.status >= 500,
        res.status,
      );
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new FetchError(`文件太大（${Math.round(len / 1048576)} MB）`, false);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          throw new FetchError(`文件太大（超过 ${Math.round(max / 1048576)} MB）`, false);
        }
        chunks.push(value);
      }
    }
    return {
      bytes: Buffer.concat(chunks),
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      url: url.href,
    };
  }
  throw new FetchError('重定向次数太多', false);
}

export async function fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
  const { bytes } = await fetchBytes(url, { ...opts, accept: 'application/json' });
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new FetchError(`返回的不是 JSON：${new URL(url).host}`, true);
  }
}

export async function fetchText(url: string, opts: FetchOpts): Promise<string> {
  const { bytes } = await fetchBytes(url, opts);
  return bytes.toString('utf8');
}

export const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
