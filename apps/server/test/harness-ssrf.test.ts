import type * as DnsModule from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UndiciModule from 'undici';
import { fetch as undiciFetch } from 'undici';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServer } from '@srh/shared';
import {
  classifyMcpError,
  describeMcpError,
  MCP_BLOCKED_MESSAGE,
  mcpDispatcher,
  mcpFetch,
  mcpGuardedLookup,
} from '../src/modules/harness/mcp-net';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * MCP 出站防 SSRF + 错误信息：
 * - 保存时拒绝回环 / 内网 / 链路本地 / 云元数据地址（400）
 * - 连接 / 刷新时重查 DNS（rebinding：保存时是公网，之后解析到内网 → 连接被拒）
 * - 底层网络错误译成中文（DNS / 拒绝连接 / 超时 / TLS / HTTP 状态码），不回显响应体
 *
 * DNS 用 vi.mock('node:dns') 伪造（*.test 域名查表，查不到给 ENOTFOUND），fetch 用 vi.mock('undici') 按需替换。
 */
const h = vi.hoisted(() => ({
  hosts: new Map<string, string>(),
  fetchImpl: null as null | ((url: unknown, init?: unknown) => Promise<unknown>),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof DnsModule>();
  const lookup = (host: string, opts: unknown, cb?: unknown) => {
    let options = opts as { all?: boolean } | undefined;
    let callback = cb as (err: unknown, addr?: unknown, family?: number) => void;
    if (typeof opts === 'function') {
      callback = opts as typeof callback;
      options = {};
    }
    const ip = h.hosts.get(host);
    if (ip === undefined) {
      if (host.endsWith('.test')) {
        const e = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
        });
        setImmediate(() => callback(e));
        return;
      }
      return (actual.lookup as (...a: unknown[]) => void)(host, opts, cb);
    }
    const family = ip.includes(':') ? 6 : 4;
    setImmediate(() => {
      if (options?.all) callback(null, [{ address: ip, family }] satisfies LookupAddress[]);
      else callback(null, ip, family);
    });
  };
  return { ...actual, default: { ...actual, lookup }, lookup };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof UndiciModule>();
  return {
    ...actual,
    fetch: (url: unknown, init?: unknown) =>
      h.fetchImpl
        ? h.fetchImpl(url, init)
        : (actual.fetch as (...a: unknown[]) => unknown)(url, init),
  };
});

const noEvent = undefined as never;
const fetchFailed = (code: string, msg = code) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(msg), { code }) });

describe('MCP 错误信息翻译（describeMcpError）', () => {
  it('展开 undici 的 cause 链：DNS / 拒绝连接 / 超时 / TLS', () => {
    expect(describeMcpError(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND x.test'))).toContain(
      '找不到这个域名',
    );
    expect(describeMcpError(fetchFailed('ECONNREFUSED'))).toContain('连接被拒绝');
    // happy eyeballs：AggregateError 包着多个 ECONNREFUSED
    const agg = new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED ::1:80'), { code: 'ECONNREFUSED' }),
      ]),
    });
    expect(describeMcpError(agg)).toContain('连接被拒绝');
    expect(describeMcpError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toContain('连接超时');
    expect(describeMcpError(fetchFailed('ETIMEDOUT'))).toContain('连接超时');
    expect(describeMcpError(new DOMException('aborted', 'TimeoutError'))).toContain('连接超时');
    expect(describeMcpError(fetchFailed('CERT_HAS_EXPIRED'))).toMatch(/TLS.*CERT_HAS_EXPIRED/u);
    expect(describeMcpError(fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'))).toContain('TLS');
    expect(describeMcpError(fetchFailed('ECONNRESET'))).toContain('连接被对方中断');
    expect(describeMcpError(fetchFailed('ESRH_BLOCKED'))).toBe(MCP_BLOCKED_MESSAGE);
    expect(describeMcpError(new TypeError('fetch failed'))).toBe('网络请求失败');
  });

  it('HTTP 状态码：只报状态，不回显响应体', () => {
    const streamable = new StreamableHTTPError(
      401,
      'Error POSTing to endpoint: {"error":"secret-body-text"}',
    );
    const m = describeMcpError(streamable);
    expect(m).toContain('服务器返回 HTTP 401');
    expect(m).not.toContain('secret-body-text');
    // SSE 传输的 POST 失败只在文本里带状态码
    const ssePost = new Error(
      'Error POSTing to endpoint (HTTP 403): <html>secret-body-text</html>',
    );
    expect(describeMcpError(ssePost)).toContain('服务器返回 HTTP 403');
    expect(describeMcpError(ssePost)).not.toContain('secret-body-text');
    expect(describeMcpError(new SseError(404, 'Non-200 status code (404)', noEvent))).toContain(
      'HTTP 404',
    );
    expect(classifyMcpError(new StreamableHTTPError(502, 'x')).kind).toBe('http');
  });

  it('SSE 传输：eventsource 拍平成字符串的原因也能认出来', () => {
    const flat = new SseError(
      undefined,
      'TypeError: fetch failed: Error: getaddrinfo ENOTFOUND nope.test',
      noEvent,
    );
    expect(describeMcpError(flat)).toContain('找不到这个域名');
    const ours = new SseError(
      undefined,
      '连接被拒绝：对方没有在这个端口提供服务（ECONNREFUSED）',
      noEvent,
    );
    expect(describeMcpError(ours)).toBe('连接被拒绝：对方没有在这个端口提供服务（ECONNREFUSED）');
  });
});

describe('MCP 出站地址守卫（单元）', () => {
  beforeEach(() => {
    h.hosts.clear();
    h.fetchImpl = null;
  });

  it('建连时的 lookup：解析到内网地址就拒绝（DNS rebinding）', async () => {
    h.hosts.set('rebind.test', '10.1.2.3');
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      mcpGuardedLookup('rebind.test', { all: true }, (e) => resolve(e)),
    );
    expect(err?.code).toBe('ESRH_BLOCKED');
    h.hosts.set('rebind.test', '93.184.216.34');
    const addr = await new Promise<unknown>((resolve) =>
      mcpGuardedLookup('rebind.test', {}, (_e, a) => resolve(a)),
    );
    expect(addr).toBe('93.184.216.34');
  });

  it('dispatcher 层：即使绕过请求前的检查，建连也会被拦（不发出连接）', async () => {
    h.hosts.set('loop.test', '127.0.0.1');
    const err = await undiciFetch('http://loop.test:8787/', { dispatcher: mcpDispatcher }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('ESRH_BLOCKED');
    expect(describeMcpError(err)).toBe(MCP_BLOCKED_MESSAGE);
  });

  it('mcpFetch：IP 字面量与解析到内网的域名在请求前就被拒，fetch 不会被调用', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: unknown) => new Response('ok'));
    h.fetchImpl = spy;
    h.hosts.set('private.test', '192.168.1.10');
    for (const u of [
      'http://127.0.0.1:8787/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/mcp',
      'http://localhost/mcp',
      'http://private.test/mcp',
    ]) {
      await expect(mcpFetch(u), u).rejects.toThrow(MCP_BLOCKED_MESSAGE);
    }
    expect(spy).not.toHaveBeenCalled();
    // 公网地址照常放行，且强制手动处理重定向、走受控 dispatcher
    h.hosts.set('public.test', '93.184.216.34');
    await mcpFetch('https://public.test/mcp', { method: 'POST', body: '{}' });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]![1] as { redirect?: string; dispatcher?: unknown };
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(mcpDispatcher);
  });

  it('mcpFetch：网络错误译成中文 McpNetError', async () => {
    h.hosts.set('public.test', '93.184.216.34');
    h.fetchImpl = async () => {
      throw fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:443');
    };
    await expect(mcpFetch('https://public.test/mcp')).rejects.toThrow('连接被拒绝');
    await expect(mcpFetch('https://nxdomain.test/mcp')).rejects.toThrow('找不到这个域名');
  });
});

describe('MCP 服务器接口：防 SSRF 与错误展示', () => {
  let t: TestApp;
  let owner: Session;
  let member: Session;
  let projectId: string;

  beforeAll(async () => {
    t = await makeApp();
    const p = await setupProject(t.app);
    projectId = p.project.id;
    owner = p.owner;
    [member] = p.others as [Session];
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    h.hosts.clear();
    h.fetchImpl = null;
  });

  const create = (s: Session, url: string, extra: Record<string, unknown> = {}) =>
    s.req('POST', `/projects/${projectId}/mcp-servers`, {
      scope: 'project',
      name: `srv${Math.random().toString(36).slice(2, 8)}`,
      transport: 'http',
      url,
      ...extra,
    });

  it('添加时拒绝内网 / 本机 / 元数据地址 → 400', async () => {
    h.hosts.set('intranet.test', '10.20.30.40');
    const spy = vi.fn(async () => new Response('x'));
    h.fetchImpl = spy;
    for (const url of [
      'http://127.0.0.1:8787/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:3000/mcp',
      'http://10.0.0.1/mcp',
      'http://[::1]:8080/mcp',
      'http://[::ffff:127.0.0.1]/mcp',
      'http://intranet.test/mcp',
    ]) {
      const res = await create(owner, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: { message: string } }>().error.message, url).toBe(
        MCP_BLOCKED_MESSAGE,
      );
    }
    // 成员的个人 MCP 也一样
    const personal = await create(member, 'http://192.168.0.1/mcp', { scope: 'personal' });
    expect(personal.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('修改地址为内网 → 400；原配置不变', async () => {
    h.hosts.set('ok.test', '93.184.216.34');
    h.fetchImpl = async () => new Response('nope', { status: 404 });
    const created = await create(owner, 'https://ok.test/mcp');
    expect(created.statusCode).toBe(201);
    const srv = created.json<McpServer>();
    const res = await owner.req('PATCH', `/projects/${projectId}/mcp-servers/${srv.id}`, {
      url: 'http://169.254.169.254/',
    });
    expect(res.statusCode).toBe(400);
    const list = (await owner.req('GET', `/projects/${projectId}/mcp-servers`)).json<McpServer[]>();
    expect(list.find((x) => x.id === srv.id)!.url).toBe('https://ok.test/mcp');
  });

  it('DNS rebinding：保存时公网、之后解析到内网 → 刷新时拒绝连接，不发请求', async () => {
    h.hosts.set('rebind.test', '93.184.216.34');
    h.fetchImpl = async () =>
      new Response('{"error":"secret-body-text"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const created = await create(owner, 'https://rebind.test/mcp');
    expect(created.statusCode).toBe(201);
    const srv = created.json<McpServer>();
    // HTTP 状态码如实显示，响应体不回显
    expect(srv.state).toBe('error');
    expect(srv.error).toContain('服务器返回 HTTP 401');
    expect(srv.error).not.toContain('secret-body-text');

    h.hosts.set('rebind.test', '10.0.0.5');
    const spy = vi.fn(async () => new Response('x'));
    h.fetchImpl = spy;
    const refreshed = await owner.req(
      'POST',
      `/projects/${projectId}/mcp-servers/${srv.id}/refresh`,
    );
    expect(refreshed.statusCode).toBe(200);
    const after = refreshed.json<McpServer>();
    expect(after.state).toBe('error');
    expect(after.error).toBe(MCP_BLOCKED_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });

  it('连接失败显示具体原因：拒绝连接 / 找不到域名（HTTP 与 SSE）', async () => {
    h.hosts.set('refuse.test', '93.184.216.34');
    h.fetchImpl = async () => {
      throw fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 93.184.216.34:443');
    };
    const refused = (await create(owner, 'https://refuse.test/mcp')).json<McpServer>();
    expect(refused.state).toBe('error');
    expect(refused.error).toContain('连接被拒绝');
    expect(refused.error).not.toContain('fetch failed');

    const refusedSse = (
      await create(owner, 'https://refuse.test/sse', { transport: 'sse' })
    ).json<McpServer>();
    expect(refusedSse.state).toBe('error');
    expect(refusedSse.error).toContain('连接被拒绝');

    // 域名暂时解析不了：允许保存，状态里写明原因
    h.fetchImpl = null;
    const nx = await create(owner, 'https://nxdomain.test/mcp');
    expect(nx.statusCode).toBe(201);
    expect(nx.json<McpServer>().error).toContain('找不到这个域名');
  }, 30_000);
});
