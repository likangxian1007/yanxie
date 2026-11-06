import { afterEach, expect, it, vi } from 'vitest';
import { ApiRequestError, getHealth } from './api';

afterEach(() => vi.unstubAllGlobals());

it('保留 503 健康响应中的数据库状态', async () => {
  const body = {
    status: 'degraded',
    version: '1',
    uptimeSec: 1,
    time: '2026-10-27T00:00:00Z',
    db: { ok: false, driver: 'postgres', latencyMs: null, error: 'database unavailable' },
    llm: { configured: false, model: '' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 503 })),
  );
  await expect(getHealth()).resolves.toEqual(body);
});

it('无效的 503 响应仍按服务错误处理', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 503 })),
  );
  await expect(getHealth()).rejects.toMatchObject({ status: 503, code: 'http_503' });
});

it('网络错误仍是标准 API 错误', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    }),
  );
  await expect(getHealth()).rejects.toBeInstanceOf(ApiRequestError);
  await expect(getHealth()).rejects.toMatchObject({ status: 0, code: 'network_error' });
});
