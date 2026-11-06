import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers';

/** 终验 R2 附录：/assets 带哈希的文件要永久缓存，index.html 每次重新验证 */
describe('前端静态文件的缓存头', () => {
  let t: TestApp;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'srh-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>研协</title>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    t = await makeApp({ WEB_DIST_DIR: dir });
  }, 60_000);
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('assets 永久缓存，其它文件 no-cache，SPA 回退也是 no-cache', async () => {
    const js = await t.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(js.statusCode, js.body).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await t.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.headers['cache-control']).toBe('no-cache');
    const spa = await t.app.inject({ method: 'GET', url: '/projects/x' });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['cache-control']).toBe('no-cache');
    const missing = await t.app.inject({ method: 'GET', url: '/assets/gone-123.js' });
    expect(missing.statusCode).toBe(404);
  });
});
