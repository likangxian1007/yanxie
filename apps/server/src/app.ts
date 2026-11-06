import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { API_PREFIX, ApiError } from '@srh/shared';
import type { AppConfig } from './config';
import type { AppContext } from './context';
import type { DbHandle } from './db/client';
import { registerErrorHandling } from './lib/http';
import { apiModules, healthModule } from './modules';
import { startNotifyPump } from './modules/notify/pump';
import { resolveAccessPolicy, type AccessPolicy } from './realtime/access';
import { EventBus } from './realtime/bus';
import { registerCollab } from './realtime/collab';
import { registerRealtime } from './realtime/ws';
import { createOperationCatalog } from './modules/integrations/catalog';
import { installIntegrationRuntime } from './modules/integrations/runtime';

export interface BuildAppOptions {
  config: AppConfig;
  db: DbHandle;
  /** 不传则用 realtime/access.ts 的 resolveAccessPolicy（默认拒绝） */
  access?: AccessPolicy;
  version?: string;
  logger?: boolean;
}

/**
 * 组装 Fastify 应用（不 listen）。测试直接 buildApp + app.inject / injectWS。
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = opts;
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
  });

  const bus = new EventBus(db.db);
  const ctx: AppContext = {
    config,
    db,
    bus,
    access: opts.access ?? resolveAccessPolicy(config, { db: db.db, bus }),
    version: opts.version ?? '0.1.0',
    startedAt: Date.now(),
  };
  app.decorate('ctx', ctx);
  const catalog = createOperationCatalog();
  installIntegrationRuntime(app, catalog);
  catalogs.set(ctx, catalog);

  registerErrorHandling(app);
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(websocket, { options: { maxPayload: 5 * 1024 * 1024 } });

  // 健康检查（/api/health，不带版本前缀）
  await healthModule.register(app);

  // 业务模块统一挂在 /api/v1
  await app.register(
    async (api) => {
      for (const mod of apiModules) await mod.register(api);
    },
    { prefix: API_PREFIX },
  );

  // 实时通道
  registerRealtime(app, bus, ctx.access, config.PUBLIC_URL);
  registerCollab(app, ctx);

  // 通知订阅的投递器（只在 NOTIFY_ENABLED 打开时才真正发东西）
  if (config.NOTIFY_ENABLED) {
    const stopNotify = startNotifyPump(ctx);
    app.addHook('onClose', async () => stopNotify());
  }

  // 生产环境：同一进程托管前端构建产物，SPA 回退到 index.html
  const webDist = config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : '';
  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // /assets 下是带内容哈希的文件，可以永久缓存；index.html 等每次都要重新验证，
      // 否则部署后旧页面还在引用已经不存在的 chunk（终验 R2 附录）
      setHeaders(reply, filePath) {
        const p = filePath.replace(/\\/gu, '/');
        const root = webDist.replace(/\\/gu, '/');
        const rel = p.startsWith(root) ? p.slice(root.length) : p;
        reply.header(
          'Cache-Control',
          rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi =
      req.url.startsWith('/api/') || req.url.startsWith('/ws') || req.url.startsWith('/collab');
    // 带扩展名的路径（/assets/x.js、/favicon.svg）找不到就是 404，不能回退成 index.html，
    // 否则部署后旧页面加载缺失的 chunk 会拿到 HTML，前端无法识别“需要刷新”
    const path = req.url.split('?')[0] ?? '';
    const looksLikeFile = /\.[a-z0-9]{1,8}$/iu.test(path) || path.startsWith('/assets/');
    if (
      !isApi &&
      !looksLikeFile &&
      req.method === 'GET' &&
      webDist &&
      existsSync(resolve(webDist, 'index.html'))
    ) {
      return reply.sendFile('index.html');
    }
    const err = new ApiError('not_found', `找不到 ${req.method} ${req.url.split('?')[0]}`);
    return reply.status(err.status).send(err.toBody());
  });

  return app;
}

const catalogs = new WeakMap<AppContext, ReturnType<typeof createOperationCatalog>>();
export function operationCatalog(ctx: AppContext) {
  const catalog = catalogs.get(ctx);
  if (!catalog) throw new Error('Operation catalog not initialized');
  return catalog;
}
